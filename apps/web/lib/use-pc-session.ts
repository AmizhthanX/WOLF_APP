'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adoptAccessToken, WolfApiError, type WolfProblem } from './client';
import {
  dispatch,
  openSession,
  reauthenticate,
  refreshSessionToken,
  requestPrivilegedGrant,
  type CommandView,
  type RiskLevel,
} from './wolf';

/**
 * Session and command execution for one PC.
 *
 * The escalation ladder lives here rather than in each page, because getting it wrong is
 * how a confirmation dialog ends up authorizing more than it showed. The rules it follows,
 * in order:
 *
 *  1. Send the command with no confirmation. If the API accepts it, it was low risk.
 *  2. If the API answers "confirmation required", it also tells us the risk level *it*
 *     assigned. That level, not the caller's guess, drives what the operator is asked for.
 *  3. Medium: an explicit confirmation. High: a password re-entry, after which the session
 *     token is re-issued so it carries the fresh authentication time. Critical: the same,
 *     plus a single-use privileged grant.
 *  4. The confirmed level is sent back. If the server would classify the retry differently,
 *     it refuses again rather than accepting a mismatch.
 */

export interface PendingConfirmation {
  readonly title: string;
  readonly description: string;
  readonly riskLevel: RiskLevel;
  readonly requiresPassword: boolean;
}

export interface PcSession {
  readonly sessionId: string | null;
  readonly sessionToken: string | null;
  readonly sessionError: WolfProblem | null;
  readonly pending: PendingConfirmation | null;
  readonly confirming: boolean;
  readonly confirmError: WolfProblem | null;
  /** Run a command, escalating for confirmation as the server requires. */
  run(input: {
    type: string;
    payload: Record<string, unknown>;
    title: string;
    description: string;
  }): Promise<CommandView | null>;
  confirm(password?: string): void;
  cancel(): void;
}

/**
 * What a PC workspace session is granted.
 *
 * `screen` is included because the workspace shows the remote desktop panel, and both the
 * ICE endpoint and the signaling relay check for it on every request. Without it the panel
 * could render a "start" button that the cloud would then refuse.
 *
 * `audio`, `input`, and `clipboard` are each separate from `screen`, because listening to a
 * machine, driving it, and reading what was copied on it are different intrusions. Holding a
 * capability is not the same as using it: the viewer starts every stream silent and view-only,
 * takes keyboard control only when asked and on a lease that expires, and never touches
 * either clipboard without an explicit click.
 *
 * `terminal` and `file-transfer` are here for the same reason and used the same way: neither
 * does anything until the operator asks for its lease, and the cloud arbitrates each one
 * separately. `services` is different in kind — it has no lease, because a service change is
 * a single audited command rather than a session over something.
 */
const CAPABILITIES = [
  'processes',
  'power',
  'screen',
  'audio',
  'input',
  'clipboard',
  'terminal',
  'file-transfer',
  'services',
];

export function usePcSession(pcId: string): PcSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<WolfProblem | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<WolfProblem | null>(null);

  // The in-flight command awaiting the operator's answer.
  const awaiting = useRef<{
    input: { type: string; payload: Record<string, unknown>; title: string; description: string };
    riskLevel: RiskLevel;
    resolve: (command: CommandView | null) => void;
  } | null>(null);

  const tokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  tokenRef.current = sessionToken;
  sessionIdRef.current = sessionId;

  useEffect(() => {
    let cancelled = false;

    void openSession(pcId, CAPABILITIES)
      .then((grant) => {
        if (cancelled) return;
        setSessionId(grant.session.id);
        setSessionToken(grant.sessionToken);
        setSessionError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof WolfApiError) setSessionError(caught.problem);
      });

    return () => {
      cancelled = true;
    };
  }, [pcId]);

  const send = useCallback(
    async (
      input: { type: string; payload: Record<string, unknown> },
      options: { confirmedRiskLevel?: RiskLevel; privilegedGrantId?: string } = {},
    ): Promise<CommandView> => {
      const bearer = tokenRef.current;
      if (!bearer) {
        throw new WolfApiError({
          code: 'session.missing',
          problem: 'No session is open for this PC.',
          cause: 'The session could not be created, or it has ended.',
          currentState: 'Nothing was changed.',
          recommendedAction: 'Reload the page to open a new session.',
          referenceId: 'WOLF-API-NOSESSION',
          httpStatus: 409,
        });
      }

      const result = await dispatch(pcId, {
        bearer,
        command: { type: input.type, payload: input.payload },
        ...options,
      });
      return result.command;
    },
    [pcId],
  );

  const run = useCallback<PcSession['run']>(
    async (input) => {
      setConfirmError(null);
      try {
        return await send(input);
      } catch (caught) {
        if (!(caught instanceof WolfApiError)) throw caught;

        const needsConfirmation =
          caught.problem.code === 'command.confirmation_required' ||
          caught.problem.code === 'command.reauth_required' ||
          caught.problem.code === 'command.privileged_grant_required';

        if (!needsConfirmation) throw caught;

        const riskLevel = (caught.problem.context?.['riskLevel'] as RiskLevel | undefined) ?? 'high';

        return await new Promise<CommandView | null>((resolve) => {
          awaiting.current = { input, riskLevel, resolve };
          setPending({
            title: input.title,
            description: input.description,
            riskLevel,
            // High and critical both require a fresh password; medium does not.
            requiresPassword: riskLevel === 'high' || riskLevel === 'critical',
          });
        });
      }
    },
    [send],
  );

  const confirm = useCallback(
    (password?: string) => {
      const request = awaiting.current;
      if (!request) return;

      setConfirming(true);
      setConfirmError(null);

      void (async () => {
        try {
          if (request.riskLevel === 'high' || request.riskLevel === 'critical') {
            if (!password) throw new Error('A password is required for this action.');

            const reauth = await reauthenticate(password);
            adoptAccessToken(reauth.accessToken, reauth.accessTokenExpiresAt);

            // The session token carries its own auth_time, so it has to be re-issued for
            // the fresh password to count.
            if (sessionIdRef.current) {
              const grant = await refreshSessionToken(pcId, sessionIdRef.current);
              tokenRef.current = grant.sessionToken;
              setSessionToken(grant.sessionToken);
            }
          }

          let privilegedGrantId: string | undefined;
          if (request.riskLevel === 'critical' && tokenRef.current) {
            const grant = await requestPrivilegedGrant(pcId, request.input.type, tokenRef.current);
            privilegedGrantId = grant.grant.id;
          }

          const command = await send(request.input, {
            confirmedRiskLevel: request.riskLevel,
            privilegedGrantId,
          });

          awaiting.current = null;
          setPending(null);
          request.resolve(command);
        } catch (caught) {
          if (caught instanceof WolfApiError) {
            setConfirmError(caught.problem);
          } else {
            setConfirmError({
              code: 'confirm.failed',
              problem: 'The action could not be confirmed.',
              cause: caught instanceof Error ? caught.message : 'Unknown error.',
              currentState: 'Nothing was changed.',
              recommendedAction: 'Check the details and try again.',
              referenceId: 'WOLF-CMD-CONFIRM',
              httpStatus: 400,
            });
          }
        } finally {
          setConfirming(false);
        }
      })();
    },
    [pcId, send],
  );

  const cancel = useCallback(() => {
    awaiting.current?.resolve(null);
    awaiting.current = null;
    setPending(null);
    setConfirmError(null);
  }, []);

  return {
    sessionId,
    sessionToken,
    sessionError,
    pending,
    confirming,
    confirmError,
    run,
    confirm,
    cancel,
  };
}

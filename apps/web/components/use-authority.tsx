'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { adoptAccessToken, WolfApiError, type WolfProblem } from '@/lib/client';
import { reauthenticate, type RiskLevel } from '@/lib/wolf';
import { ConfirmDialog } from '@/components/ui';

interface PendingAuthority {
  readonly title: string;
  readonly description: ReactNode;
  readonly riskLevel: RiskLevel;
  readonly retry: (confirmed: RiskLevel) => Promise<void>;
}

/**
 * The confirm-then-password flow, for decisions that are saved rather than sent: an automation, a
 * configuration restore.
 *
 * The first attempt goes without a confirmation. If the server says one is needed, it names the risk
 * level; that level is what the dialog shows and what is sent back. High risk asks for the password
 * first, so the retry carries a fresh sign-in.
 */
export function useAuthority(onError: (problem: WolfProblem) => void) {
  const [pending, setPending] = useState<PendingAuthority | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<WolfProblem | null>(null);

  const attempt = useCallback(
    async (title: string, action: (confirmed?: RiskLevel) => Promise<void>, description?: ReactNode) => {
      try {
        await action();
      } catch (caught) {
        if (!(caught instanceof WolfApiError)) throw caught;
        const code = caught.problem.code;
        if (code !== 'command.confirmation_required' && code !== 'command.reauth_required') {
          onError(caught.problem);
          return;
        }
        const riskLevel = (caught.problem.context?.['riskLevel'] as RiskLevel | undefined) ?? 'high';
        setDialogError(null);
        setPending({
          title,
          description: description ?? 'WOLF will act on this decision later, when nobody is watching.',
          riskLevel,
          retry: (confirmed) => action(confirmed),
        });
      }
    },
    [onError],
  );

  const confirm = useCallback(
    (password?: string) => {
      const request = pending;
      if (!request) return;
      setBusy(true);
      setDialogError(null);

      void (async () => {
        try {
          if (request.riskLevel === 'high' || request.riskLevel === 'critical') {
            if (!password) throw new Error('Your password is needed for this.');
            const reauth = await reauthenticate(password);
            adoptAccessToken(reauth.accessToken, reauth.accessTokenExpiresAt);
          }
          await request.retry(request.riskLevel);
          setPending(null);
        } catch (caught) {
          setDialogError(
            caught instanceof WolfApiError
              ? caught.problem
              : {
                  code: 'authorize.failed',
                  problem: 'This could not be authorized.',
                  cause: caught instanceof Error ? caught.message : 'Unknown error.',
                  currentState: 'Nothing was changed.',
                  recommendedAction: 'Check the details and try again.',
                  referenceId: 'WOLF-API-AUTHORIZE',
                  httpStatus: 400,
                },
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [pending],
  );

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      description={
        <>
          {pending.description}
          {pending.riskLevel === 'high' ? ' Because it is high risk, your password is needed.' : ''}
        </>
      }
      riskLevel={pending.riskLevel}
      requiresPassword={pending.riskLevel === 'high' || pending.riskLevel === 'critical'}
      busy={busy}
      error={dialogError}
      onCancel={() => setPending(null)}
      onConfirm={confirm}
    />
  ) : null;

  return { attempt, dialog };
}

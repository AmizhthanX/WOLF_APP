import {
  COMMAND_REGISTRY,
  agentCommandBody,
  classifyRisk,
  isAutomatableCommand,
  isKnownCommandType,
  riskRank,
  type AgentCommandBody,
  type AgentCommandType,
  type AuthorizationContext,
  type AutomationSkipReason,
} from '@wolf/protocol';
import { newId, policyFor, type ExclusiveResource, type RiskLevel } from '@wolf/shared-types';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import type { RequestAuth } from '../http/auth.js';
import type { CommandRecord } from '@wolf/server-core';
import { commandAuditTarget, withTransaction } from '@wolf/server-core';
import {
  confirmationRequired,
  conflict,
  forbidden,
  killSwitchEngaged,
  missingCapability,
  notFound,
  pcOffline,
  privilegedGrantRequired,
  reauthenticationRequired,
  unsupportedCommand,
} from '../http/errors.js';

/**
 * Exclusive resource each command area contends for. Commands not listed here are not
 * arbitrated: reading the process list never needs to wait for whoever holds the terminal.
 */
const COMMAND_RESOURCE: Partial<Record<AgentCommandType, ExclusiveResource>> = {
  'power.action': 'power',
  'power.schedule': 'power',
  'power.cancel': 'power',
  'power.unlock': 'power',
};

export interface DispatchInput {
  readonly auth: RequestAuth;
  readonly pcId: string;
  readonly command: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  /**
   * Risk level the operator was shown when they confirmed. It must match the server's own
   * classification: a UI that offered "terminate notepad" must not be able to confirm a
   * command the server classifies as terminating lsass.exe.
   */
  readonly confirmedRiskLevel?: RiskLevel;
  /** Privileged grant id, required for critical commands. */
  readonly privilegedGrantId?: string;
}

export interface DispatchOutcome {
  readonly command: CommandRecord;
  /** False when a repeated idempotency key resolved to an existing command. */
  readonly created: boolean;
}

/** A command an automation is about to send, on the authority recorded when it was saved. */
export interface AutomatedDispatchInput {
  readonly automationId: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly userId: string;
  /** The device the automation was authorized from. */
  readonly deviceId: string;
  readonly authorizedAt: Date;
  readonly authorizedRisk: RiskLevel;
  readonly pcId: string;
  readonly command: AgentCommandBody;
}

export type AutomatedDispatchOutcome =
  | { readonly ok: true; readonly command: CommandRecord }
  | { readonly ok: false; readonly reason: AutomationSkipReason; readonly detail: string };

export class CommandService {
  constructor(private readonly context: AppContext) {}

  /**
   * Authorize and enqueue a command.
   *
   * Order matters: ownership, then kill switch, then payload validity, then risk, then
   * agent support. Every rejection happens before a row is written, so a refused command
   * never appears as pending work on the PC.
   */
  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const { repos } = this.context;
    const now = this.context.now();

    const pc = await repos.pcs.findById(input.pcId, input.auth.userId);
    if (!pc || pc.registrationState === 'revoked') throw notFound('That PC');

    if (!pc.remoteAccessEnabled) throw killSwitchEngaged(pc.name);

    const command = parseOrThrow(agentCommandBody, input.command, {
      area: 'CMD',
      what: 'The command',
    }) as AgentCommandBody;

    if (!isKnownCommandType(command.type)) {
      throw unsupportedCommand(command.type, pc.name);
    }

    const definition = COMMAND_REGISTRY[command.type];
    const riskLevel = classifyRisk(command);
    const policy = policyFor(riskLevel);

    if (!input.auth.capabilities.includes(definition.capability)) {
      await this.auditDenied(input, command.type, riskLevel, 'capability-missing');
      throw missingCapability(definition.capability);
    }

    if (policy.requiresConfirmation) {
      if (input.confirmedRiskLevel !== riskLevel) {
        await this.auditDenied(input, command.type, riskLevel, 'confirmation-required');
        throw confirmationRequired(definition.description, riskLevel);
      }
    }

    if (policy.requiresPasswordReauth) {
      const authAge = Math.floor(now.getTime() / 1000) - input.auth.claims.auth_time;
      if (authAge > policy.reauthMaxAgeSeconds) {
        await this.auditDenied(input, command.type, riskLevel, 'reauth-required');
        throw reauthenticationRequired(definition.description, policy.reauthMaxAgeSeconds);
      }
    }

    if (policy.requiresPrivilegedGrant) {
      const grantValid = await this.privilegedGrantIsValid({
        grantId: input.privilegedGrantId,
        userId: input.auth.userId,
        pcId: input.pcId,
        sessionId: input.auth.sessionId,
        now,
      });
      if (!grantValid) {
        await this.auditDenied(input, command.type, riskLevel, 'privileged-grant-required');
        throw privilegedGrantRequired(definition.description);
      }
    }

    // The agent tells the cloud what it can do. Anything else is refused here rather than
    // queued as work that would never run.
    const capabilities = await repos.pcs.getCapabilities(input.pcId);
    if (capabilities && !capabilities.supportedCommands.includes(command.type)) {
      await this.auditDenied(input, command.type, riskLevel, 'unsupported-command');
      throw unsupportedCommand(command.type, pc.name);
    }

    if (pc.status !== 'online') {
      await this.auditDenied(input, command.type, riskLevel, 'pc-offline');
      throw pcOffline(pc.name);
    }

    const session = input.auth.sessionId
      ? await repos.sessions.findActive(input.auth.sessionId, input.auth.userId, now)
      : null;
    if (input.auth.sessionId && !session) {
      throw forbidden('The session has ended or expired.', 'Reconnect to the PC and try again.');
    }

    // Exclusive resources are arbitrated per PC. Holding one is not implied by holding a
    // capability; it has to be taken, and only one session can hold it at a time.
    const resource = COMMAND_RESOURCE[command.type];
    if (resource && definition.mutating && session) {
      const lease = await repos.sessions.acquireResource({
        pcId: input.pcId,
        resource,
        sessionId: session.id,
        expiresAt: new Date(now.getTime() + 60_000),
      });
      if (!lease.acquired) {
        throw conflict(
          `Another session currently controls ${resource} on ${pc.name}.`,
          `Session ${lease.heldBy ?? 'unknown'} holds the ${resource} lease.`,
          'Request control from the other session, or wait for it to be released.',
        );
      }
    }

    const authorization: AuthorizationContext = {
      userId: input.auth.userId,
      deviceId: input.auth.deviceId,
      sessionId: session?.id ?? input.auth.sessionId ?? input.auth.deviceId,
      route: session?.route ?? 'relay',
      grantedCapabilities: [...input.auth.capabilities],
      riskLevel,
      confirmedAt: policy.requiresConfirmation ? now.toISOString() : null,
      reauthenticatedAt: policy.requiresPasswordReauth
        ? new Date(input.auth.claims.auth_time * 1000).toISOString()
        : null,
      privilegedGrantId: policy.requiresPrivilegedGrant ? (input.privilegedGrantId ?? null) : null,
    };

    const commandId = newId();
    const expiresAt = new Date(now.getTime() + this.context.config.commandTtlSeconds * 1000);

    const outcome = await withTransaction(this.context.db, async (client) => {
      const created = await repos.commands.create(
        {
          id: commandId,
          pcId: input.pcId,
          sessionId: session?.id ?? null,
          userId: input.auth.userId,
          deviceId: input.auth.deviceId,
          requestId: input.requestId,
          type: command.type,
          riskLevel,
          payload: command,
          authorization,
          idempotencyKey: input.idempotencyKey,
          expiresAt,
        },
        client,
      );

      if (created.created) {
        await repos.audit.record(
          {
            category: definition.auditCategory,
            action: command.type,
            outcome: 'pending',
            riskLevel,
            userId: input.auth.userId,
            deviceId: input.auth.deviceId,
            pcId: input.pcId,
            sessionId: session?.id ?? null,
            requestId: input.requestId,
            sourceIp: input.sourceIp,
            route: session?.route ?? null,
            target: commandAuditTarget(command),
          },
          client,
        );
      }

      return created;
    });

    if (outcome.created) {
      // Wake the realtime service holding this agent's link. Postgres NOTIFY keeps command
      // delivery working across instances without adding a broker, and the durable row
      // means a missed notification is still picked up by the pending-command sweep.
      await this.context.db.query('SELECT pg_notify($1, $2)', [
        'wolf_command',
        JSON.stringify({ pcId: input.pcId, commandId }),
      ]);
    }

    return { command: outcome.command, created: outcome.created };
  }

  /**
   * Enqueue a command for an automation.
   *
   * A separate path rather than a flag on {@link dispatch}, so that nothing about unattended dispatch
   * can loosen the interactive one. The checks that stand in for a person:
   *
   * - the command must be on the automatable list, and classify at or below the risk level the owner
   *   confirmed when saving — never critical, however it was saved;
   * - the kill switch, agent support and presence are checked exactly as for a person;
   * - an exclusive resource held by a live session is never taken: an automation does not restart a
   *   machine out from under somebody who is holding its power control.
   *
   * Refusals are returned rather than thrown, because an automation has nobody to show an error to;
   * each is audited as denied.
   */
  async dispatchAutomated(input: AutomatedDispatchInput): Promise<AutomatedDispatchOutcome> {
    const { repos } = this.context;
    const now = this.context.now();

    const refuse = async (reason: AutomationSkipReason, detail: string, riskLevel: RiskLevel, type: string) => {
      await repos.audit.record({
        category: isKnownCommandType(type) ? COMMAND_REGISTRY[type].auditCategory : 'automation',
        action: type,
        outcome: 'denied',
        riskLevel,
        userId: input.userId,
        deviceId: input.deviceId,
        pcId: input.pcId,
        requestId: input.runId,
        target: { kind: 'automation', automationId: input.automationId, runId: input.runId, step: input.stepIndex },
        errorCode: reason,
      });
      return { ok: false as const, reason, detail };
    };

    const parsed = agentCommandBody.safeParse(input.command);
    if (!parsed.success || !isAutomatableCommand(parsed.data.type)) {
      return refuse('unsupported-command', 'The action is not one an automation may carry.', 'low', input.command.type);
    }

    const command = parsed.data as AgentCommandBody;
    const definition = COMMAND_REGISTRY[command.type];
    const riskLevel = classifyRisk(command);

    if (riskLevel === 'critical' || riskRank(riskLevel) > riskRank(input.authorizedRisk)) {
      return refuse(
        'risk-escalated',
        `The action classifies ${riskLevel} risk, above the ${input.authorizedRisk} the automation was authorized for.`,
        riskLevel,
        command.type,
      );
    }

    const pc = await repos.pcs.findById(input.pcId, input.userId);
    if (!pc || pc.registrationState === 'revoked') {
      return refuse('pc-unavailable', 'The PC is no longer enrolled on this account.', riskLevel, command.type);
    }

    if (!pc.remoteAccessEnabled) {
      return refuse('kill-switch', `Remote access to ${pc.name} is switched off.`, riskLevel, command.type);
    }

    const capabilities = await repos.pcs.getCapabilities(input.pcId);
    if (capabilities && !capabilities.supportedCommands.includes(command.type)) {
      return refuse('unsupported-command', `${pc.name} does not support ${command.type}.`, riskLevel, command.type);
    }

    if (pc.status !== 'online') {
      return refuse('pc-offline', `${pc.name} is offline.`, riskLevel, command.type);
    }

    const resource = COMMAND_RESOURCE[command.type];
    if (resource && definition.mutating) {
      const holder = await repos.sessions.activeResourceHolder(input.pcId, resource);
      if (holder) {
        return refuse('resource-held', `A connected session holds ${resource} control on ${pc.name}.`, riskLevel, command.type);
      }
    }

    const policy = policyFor(riskLevel);
    const authorization: AuthorizationContext = {
      userId: input.userId,
      deviceId: input.deviceId,
      // There is no session: the authority is the automation's, recorded against the device it was
      // saved from. The same fallback the interactive path uses for an account token.
      sessionId: input.deviceId,
      route: 'relay',
      grantedCapabilities: [definition.capability],
      riskLevel,
      // When the owner confirmed and re-entered their password: at save time, not now. Recorded as
      // what it is rather than stamped with the moment of dispatch.
      confirmedAt: policy.requiresConfirmation ? input.authorizedAt.toISOString() : null,
      reauthenticatedAt: policy.requiresPasswordReauth ? input.authorizedAt.toISOString() : null,
      privilegedGrantId: null,
    };

    const commandId = newId();
    const expiresAt = new Date(now.getTime() + this.context.config.commandTtlSeconds * 1000);

    const outcome = await withTransaction(this.context.db, async (client) => {
      const created = await repos.commands.create(
        {
          id: commandId,
          pcId: input.pcId,
          sessionId: null,
          userId: input.userId,
          deviceId: input.deviceId,
          requestId: input.runId,
          type: command.type,
          riskLevel,
          payload: command,
          authorization,
          idempotencyKey: `automation:${input.runId}:${input.stepIndex}`,
          expiresAt,
        },
        client,
      );

      if (created.created) {
        await repos.audit.record(
          {
            category: definition.auditCategory,
            action: command.type,
            outcome: 'pending',
            riskLevel,
            userId: input.userId,
            deviceId: input.deviceId,
            pcId: input.pcId,
            requestId: input.runId,
            target: { ...commandAuditTarget(command), automationId: input.automationId, runId: input.runId },
          },
          client,
        );
      }

      return created;
    });

    if (outcome.created) {
      await this.context.db.query('SELECT pg_notify($1, $2)', [
        'wolf_command',
        JSON.stringify({ pcId: input.pcId, commandId }),
      ]);
    }

    return { ok: true, command: outcome.command };
  }

  private async privilegedGrantIsValid(input: {
    grantId: string | undefined;
    userId: string;
    pcId: string;
    sessionId: string | null;
    now: Date;
  }): Promise<boolean> {
    if (!input.grantId) return false;
    const { rows } = await this.context.db.query<{ id: string }>(
      `SELECT id FROM privileged_grants
        WHERE id = $1 AND user_id = $2 AND pc_id = $3
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $4
          AND ($5::char(26) IS NULL OR session_id = $5)`,
      [input.grantId, input.userId, input.pcId, input.now, input.sessionId],
    );
    if (!rows[0]) return false;

    // Grants are single use: one grant authorizes one critical action.
    const { rowCount } = await this.context.db.query(
      'UPDATE privileged_grants SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
      [input.grantId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async auditDenied(
    input: DispatchInput,
    type: string,
    riskLevel: RiskLevel,
    errorCode: string,
  ): Promise<void> {
    await this.context.repos.audit.record({
      category: isKnownCommandType(type) ? COMMAND_REGISTRY[type].auditCategory : 'pc',
      action: type,
      outcome: 'denied',
      riskLevel,
      userId: input.auth.userId,
      deviceId: input.auth.deviceId,
      pcId: input.pcId,
      sessionId: input.auth.sessionId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
      errorCode,
    });
  }
}

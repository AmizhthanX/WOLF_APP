import type { Logger } from 'pino';
import {
  isTerminalStatus,
  type AutomationRun,
  type AutomationSkipReason,
  type AutomationStep,
} from '@wolf/protocol';
import {
  authorizeRun,
  evaluateConditions,
  withTransaction,
  type CommandRecord,
  type StoredAutomation,
} from '@wolf/server-core';
import type { AppContext } from '../http/context.js';
import { CommandService } from '../services/command-service.js';

/**
 * Running one automation on one PC.
 *
 * The order is the design:
 *
 * 1. **Authority.** Is the device that authorized it still active, and do its actions still classify
 *    within what was confirmed? If not, the automation is turned off and the owner told — it does
 *    not quietly skip forever.
 * 2. **Conditions.** Evaluated before the cooldown is claimed, so a run that was never going to act
 *    does not use up the next hour.
 * 3. **Claim.** Cooldown and daily limit, compare-and-set, with the run row in the same transaction.
 * 4. **Actions, in order.** A command's result is waited for before the next action, because
 *    "stop the service, then start it" means nothing if the stop has not finished. The first action
 *    that fails stops the rest.
 *
 * Runs are not resumed. An instance that dies mid-run leaves a lease that lapses, and the job marks
 * the run interrupted.
 */
export interface AutomationExecutorOptions {
  readonly pollMs?: number;
  /** Beyond a command's own time to live, how long to wait for its result. */
  readonly resultSlackMs?: number;
}

type StepKind = AutomationStep['kind'];

export class AutomationExecutor {
  private readonly inflight = new Set<Promise<void>>();
  private readonly commands: CommandService;
  private readonly logger: Logger;
  private readonly pollMs: number;
  private readonly resultSlackMs: number;

  constructor(
    private readonly context: AppContext,
    options: AutomationExecutorOptions = {},
  ) {
    this.commands = new CommandService(context);
    this.logger = context.logger.child({ component: 'automation-executor' });
    this.pollMs = options.pollMs ?? 250;
    this.resultSlackMs = options.resultSlackMs ?? 15_000;
  }

  /** Start runs in the background, one per PC. */
  start(
    automation: StoredAutomation,
    pcIds: readonly string[],
    triggerKind: AutomationRun['triggerKind'],
    options: { readonly ignoreCooldown?: boolean } = {},
  ): void {
    for (const pcId of pcIds) {
      const run = this.execute(automation, pcId, triggerKind, options.ignoreCooldown ?? false).catch((error: unknown) => {
        // Identifiers only. An automation's name and messages are the owner's words.
        this.logger.error(
          { automationId: automation.id, pcId, err: error instanceof Error ? error.message : String(error) },
          'Automation run failed unexpectedly',
        );
      });
      const tracked: Promise<void> = run.finally(() => {
        this.inflight.delete(tracked);
      });
      this.inflight.add(tracked);
    }
  }

  /** Wait for every run this executor started. For shutdown and tests. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private leaseMs(actions: number): number {
    return actions * (this.context.config.commandTtlSeconds * 1000 + this.resultSlackMs) + 60_000;
  }

  async execute(
    automation: StoredAutomation,
    pcId: string,
    triggerKind: AutomationRun['triggerKind'],
    ignoreCooldown: boolean,
  ): Promise<void> {
    const { repos } = this.context;
    const now = this.context.now();

    // 1. Authority.
    const device = await repos.devices.findActive(automation.authorizedDeviceId, automation.userId);
    const authority = authorizeRun({
      actions: automation.actions,
      authorizedRisk: automation.authorizedRisk,
      authorizingDeviceActive: device !== null,
    });

    if (!authority.ok) {
      await this.turnOff(automation, pcId, triggerKind, authority.reason, authority.detail);
      return;
    }

    const pc = await repos.pcs.findById(pcId, automation.userId);
    if (!pc || pc.registrationState === 'revoked') {
      await this.skip(automation, pcId, triggerKind, 'pc-unavailable', 'The PC is no longer enrolled on this account.');
      return;
    }

    // 2. Conditions.
    if (automation.conditions.length > 0) {
      const [latest, activeSessions] = await Promise.all([
        repos.telemetry.latestSample(pcId),
        repos.sessions.countActiveForPc(pcId),
      ]);
      const verdict = evaluateConditions(automation.conditions, { now, latest, activeSessions });
      if (!verdict.met) {
        await this.skip(automation, pcId, triggerKind, 'condition-not-met', verdict.detail);
        return;
      }
    }

    // 3. Claim.
    const claim = await withTransaction(this.context.db, (client) =>
      repos.automations.claimRun(client, {
        automation,
        pcId,
        triggerKind,
        now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs(automation.actions.length)),
        ignoreCooldown,
      }),
    );

    if (claim.outcome !== 'claimed') {
      await this.skip(automation, pcId, triggerKind, claim.outcome);
      return;
    }

    // 4. Actions.
    const steps: AutomationStep[] = [];
    let failure: string | null = null;

    for (const [index, action] of automation.actions.entries()) {
      const kind: StepKind = action.kind;
      const commandType = action.kind === 'command' ? action.command.type : null;

      if (failure !== null) {
        steps.push({ index, kind, status: 'skipped', commandId: null, commandType, detail: 'An earlier action did not complete.' });
        continue;
      }

      if (action.kind === 'notify') {
        await repos.automations.insertNotification({
          userId: automation.userId,
          automationId: automation.id,
          pcId,
          severity: action.severity,
          title: automation.name,
          detail: `${action.message} — ${pc.name}`,
          occurredAt: this.context.now(),
        });
        steps.push({ index, kind, status: 'completed', commandId: null, commandType: null, detail: null });
        continue;
      }

      const dispatched = await this.commands.dispatchAutomated({
        automationId: automation.id,
        runId: claim.runId,
        stepIndex: index,
        userId: automation.userId,
        deviceId: automation.authorizedDeviceId,
        authorizedAt: automation.authorizedAt,
        authorizedRisk: automation.authorizedRisk,
        pcId,
        command: action.command,
      });

      if (!dispatched.ok) {
        failure = dispatched.reason;
        steps.push({ index, kind, status: 'failed', commandId: null, commandType, detail: `${dispatched.reason}: ${dispatched.detail}` });
        continue;
      }

      const finished = await this.waitForResult(dispatched.command, claim.runId, automation.actions.length - index);

      if (finished.status === 'completed') {
        steps.push({ index, kind, status: 'completed', commandId: finished.id, commandType, detail: null });
      } else {
        failure = finished.errorCode ?? (isTerminalStatus(finished.status) ? finished.status : 'no-result');
        const detail = isTerminalStatus(finished.status)
          ? `${finished.status}${finished.errorCode ? `: ${finished.errorCode}` : ''}${finished.errorIsLimitation ? ' (a Windows limitation)' : ''}`
          : 'no-result: the PC did not report a result in time.';
        steps.push({ index, kind, status: 'failed', commandId: finished.id, commandType, detail });
      }
    }

    const finishedAt = this.context.now();
    await repos.automations.finishRun({
      runId: claim.runId,
      status: failure === null ? 'completed' : 'failed',
      reason: failure,
      steps,
      now: finishedAt,
    });

    await repos.audit.record({
      category: 'automation',
      action: 'automation.run',
      outcome: failure === null ? 'success' : 'failure',
      riskLevel: authority.risk,
      userId: automation.userId,
      deviceId: automation.authorizedDeviceId,
      pcId,
      requestId: claim.runId,
      target: { kind: 'automation', automationId: automation.id, runId: claim.runId, trigger: triggerKind },
      errorCode: failure,
    });

    // A nightly shutdown that finds the machine already off is not news. Anything else that stopped
    // a run is.
    if (failure !== null && failure !== 'pc-offline') {
      const failed = steps.find((step) => step.status === 'failed');
      await repos.automations.insertNotification({
        userId: automation.userId,
        automationId: automation.id,
        pcId,
        severity: 'warning',
        title: `Automation "${automation.name}" did not finish on ${pc.name}`,
        detail: failed?.detail ?? failure,
        occurredAt: finishedAt,
      });
    }
  }

  private async waitForResult(command: CommandRecord, runId: string, remainingActions: number): Promise<CommandRecord> {
    // Wall-clock time for the wait itself: it is measured against a real agent answering.
    const deadline = Date.now() + this.context.config.commandTtlSeconds * 1000 + this.resultSlackMs;
    let current = command;
    let leaseRenewedAt = Date.now();

    while (!isTerminalStatus(current.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      const refreshed = await this.context.repos.commands.findById(command.id);
      if (!refreshed) break;
      current = refreshed;

      if (Date.now() - leaseRenewedAt > 10_000) {
        leaseRenewedAt = Date.now();
        await this.context.repos.automations.extendLease(
          runId,
          new Date(this.context.now().getTime() + this.leaseMs(remainingActions)),
        );
      }
    }

    return current;
  }

  private async skip(
    automation: StoredAutomation,
    pcId: string | null,
    triggerKind: AutomationRun['triggerKind'],
    reason: AutomationSkipReason,
    detail?: string,
  ): Promise<void> {
    await this.context.repos.automations.recordSkippedRun({
      automation,
      pcId,
      triggerKind,
      reason: detail ? `${reason}: ${detail}` : reason,
      now: this.context.now(),
    });
  }

  /**
   * An automation that may no longer act is turned off, audited, and the owner told once.
   *
   * Turned off rather than skipped: re-enabling it goes through the same confirmation as saving it,
   * which is exactly the decision that has to be made again.
   */
  private async turnOff(
    automation: StoredAutomation,
    pcId: string,
    triggerKind: AutomationRun['triggerKind'],
    reason: 'authority-revoked' | 'risk-escalated',
    detail: string,
  ): Promise<void> {
    const { repos } = this.context;
    const now = this.context.now();

    await this.skip(automation, pcId, triggerKind, reason, detail);

    if (!(await repos.automations.disable(automation.id))) return;

    await repos.audit.record({
      category: 'automation',
      action: 'automation.disable',
      outcome: 'success',
      riskLevel: 'low',
      userId: automation.userId,
      deviceId: automation.authorizedDeviceId,
      target: { kind: 'automation', automationId: automation.id },
      errorCode: reason,
    });

    await repos.automations.insertNotification({
      userId: automation.userId,
      automationId: automation.id,
      pcId: null,
      severity: 'warning',
      title: `Automation "${automation.name}" was turned off`,
      detail: `${detail} Review it and save it again to re-authorize it.`,
      occurredAt: now,
    });
  }
}

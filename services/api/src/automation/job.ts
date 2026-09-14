import type { Logger } from 'pino';
import { EVENT_MAX_AGE_MINUTES } from '@wolf/protocol';
import { dueScheduleSlot, type AutomationEvent, type StoredAutomation } from '@wolf/server-core';
import type { AppContext } from '../http/context.js';
import { AutomationExecutor } from './executor.js';

export { AutomationExecutor } from './executor.js';

/**
 * Finding the automations that should run now.
 *
 * Every API instance runs this. Nothing it starts can start twice: a scheduled minute is claimed by
 * inserting its slot, an alert event by claiming its row, and a run on a PC by the cooldown's
 * compare-and-set — each done by exactly one instance.
 */
export interface AutomationJobOptions {
  readonly intervalMs?: number;
}

export interface AutomationJobOutcome {
  readonly interrupted: number;
  readonly schedulesFired: number;
  readonly eventsClaimed: number;
  readonly runsStarted: number;
}

const RETENTION_EVERY_MS = 60 * 60_000;

/** Whether an alert event is what an automation's trigger asks about. */
export function matchesEvent(automation: StoredAutomation, event: AutomationEvent): boolean {
  const trigger = automation.trigger;
  if (trigger.kind !== 'alert') return false;
  if ((trigger.on === 'fired') !== (event.kind === 'alert-fired')) return false;
  return trigger.ruleId === null || trigger.ruleId === event.ruleId;
}

/** The PCs a run covers: the listed ones, or the one the alert fired for. */
export function targetPcs(automation: StoredAutomation, event: AutomationEvent | null): string[] {
  if (automation.targets.mode === 'pcs') return [...automation.targets.pcIds];
  return event ? [event.pcId] : [];
}

export class AutomationJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private readonly intervalMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly context: AppContext,
    readonly executor: AutomationExecutor = new AutomationExecutor(context),
    options: AutomationJobOptions = {},
  ) {
    // Well inside the five-minute schedule grace, so a restart never costs a scheduled run.
    this.intervalMs = options.intervalMs ?? 30_000;
    this.logger = context.logger.child({ job: 'automations' });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<AutomationJobOutcome | null> {
    if (this.running) return null;
    this.running = true;

    let schedulesFired = 0;
    let runsStarted = 0;

    try {
      const { repos } = this.context;
      const now = this.context.now();

      const interrupted = await repos.automations.interruptStaleRuns(now);

      for (const automation of await repos.automations.enabledByTrigger('schedule')) {
        if (automation.trigger.kind !== 'schedule') continue;

        const slot = dueScheduleSlot(automation.trigger, now);
        if (slot === null || !(await repos.automations.claimScheduleSlot(automation.id, slot, now))) continue;

        schedulesFired += 1;
        const pcs = targetPcs(automation, null);
        runsStarted += pcs.length;
        this.executor.start(automation, pcs, 'schedule');
      }

      const events = await repos.automations.claimEvents(now);
      const byUser = new Map<string, StoredAutomation[]>();

      for (const event of events) {
        let candidates = byUser.get(event.userId);
        if (!candidates) {
          candidates = await repos.automations.enabledAlertAutomationsFor(event.userId);
          byUser.set(event.userId, candidates);
        }

        const stale = now.getTime() - event.occurredAt.getTime() > EVENT_MAX_AGE_MINUTES * 60_000;

        for (const automation of candidates.filter((candidate) => matchesEvent(candidate, event))) {
          const pcs = targetPcs(automation, event);

          if (stale) {
            // An alert that fired while every instance was down is not acted on an hour later. The
            // run history says so rather than leaving a gap.
            for (const pcId of pcs) {
              await repos.automations.recordSkippedRun({
                automation,
                pcId,
                triggerKind: 'alert',
                reason: 'stale-trigger: The alert changed state too long ago to act on now.',
                now,
              });
            }
            continue;
          }

          runsStarted += pcs.length;
          this.executor.start(automation, pcs, 'alert');
        }
      }

      if (now.getTime() - this.lastRetentionAt >= RETENTION_EVERY_MS) {
        this.lastRetentionAt = now.getTime();
        await repos.automations.deleteExpired(now);
      }

      if (interrupted > 0 || runsStarted > 0) {
        this.logger.info({ interrupted, schedulesFired, events: events.length, runsStarted }, 'Automations started');
      }

      return { interrupted, schedulesFired, eventsClaimed: events.length, runsStarted };
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Automation pass failed');
      return null;
    } finally {
      this.running = false;
    }
  }
}

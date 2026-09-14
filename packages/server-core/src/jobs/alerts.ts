import type { Logger } from 'pino';
import type { Pc } from '@wolf/shared-types';
import type { ServerContext } from '../context.js';
import { withTransaction } from '../db/pool.js';
import type { StateRow, StoredRule } from '../db/repositories/alerts.js';
import {
  describe,
  judgeMetric,
  judgeOffline,
  seriesValues,
  transition,
  type Verdict,
} from '../rules/engine.js';

/**
 * Asking every alert rule its question, once a minute, and telling the owner when the answer
 * changes.
 *
 * The judgement is pure and lives in `rules/engine.ts`. What is here needs a clock and a
 * database: which PCs a rule covers, which data to judge it on, and writing the new state and the
 * notification so that two API instances running this at once still tell the owner once.
 *
 * ## Which data a rule is judged on
 *
 * Agents sample every five seconds, so a rule asking about a whole day would mean reading
 * seventeen thousand raw samples per PC per rule per minute. Windows up to an hour read raw
 * samples. Longer ones read the settled five-minute buckets for most of the window and raw
 * samples only for the tail the rollup has not reached yet.
 *
 * That substitution is exact rather than approximate, and it is the reason it is allowed: a
 * metric was above its line for the whole window if and only if the *lowest* value in every
 * bucket was, and a bucket's minimum is stored. Below rules use the maximum. No threshold
 * decision is ever taken on an average.
 *
 * ## What it does not do
 *
 * It writes an in-app notification and nothing else. No e-mail, push or webhook exists yet — see
 * `docs/architecture/alerts.md` for why each one is its own piece of work.
 */
export interface AlertJobOptions {
  readonly intervalMs?: number;
  /** Windows longer than this are judged partly from five-minute aggregates. */
  readonly rawWindowMinutes?: number;
}

export interface AlertOutcome {
  readonly rulesEvaluated: number;
  readonly fired: number;
  readonly resolved: number;
  readonly notificationsWritten: number;
  /** Transitions another instance made first, so this one wrote nothing. */
  readonly lostRaces: number;
}

const FIVE_MINUTES_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;

type Point = { at: Date; value: number };

export class AlertJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private readonly intervalMs: number;
  private readonly rawWindowMinutes: number;
  private readonly logger: Logger;

  constructor(
    private readonly context: ServerContext,
    options: AlertJobOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.rawWindowMinutes = options.rawWindowMinutes ?? 60;
    this.logger = context.logger.child({ job: 'alerts' });
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

  async runOnce(): Promise<AlertOutcome | null> {
    if (this.running) return null;
    this.running = true;

    const outcome = { rulesEvaluated: 0, fired: 0, resolved: 0, notificationsWritten: 0, lostRaces: 0 };

    try {
      const now = this.context.now();
      const rules = await this.context.repos.alerts.enabledRules();
      const pcsByUser = new Map<string, Pc[]>();

      // One read of a PC's recent history serves every rule about it with the same window.
      const cache = new Map<string, Promise<Map<string, Point[]>>>();

      for (const rule of rules) {
        outcome.rulesEvaluated += 1;

        try {
          await this.evaluate(rule, now, pcsByUser, cache, outcome);
        } catch (error) {
          // One broken rule must not silence every rule after it.
          this.logger.error(
            { ruleId: rule.id, err: error instanceof Error ? error.message : String(error) },
            'Alert rule evaluation failed',
          );
        }
      }

      if (now.getTime() - this.lastRetentionAt >= RETENTION_EVERY_MS) {
        this.lastRetentionAt = now.getTime();
        const dropped = await this.context.repos.alerts.deleteOldNotifications(now);
        if (dropped > 0) this.logger.info({ dropped }, 'Deleted expired notifications');
      }

      if (outcome.fired > 0 || outcome.resolved > 0 || outcome.lostRaces > 0) {
        // Counts only. Rule names and PC names are the owner's words and have no business in logs.
        this.logger.info(outcome, 'Alert states changed');
      }

      return outcome;
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Alert evaluation failed',
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  private async targets(rule: StoredRule, pcsByUser: Map<string, Pc[]>): Promise<Pc[]> {
    if (rule.pcId !== null) {
      const pc = await this.context.repos.pcs.findById(rule.pcId, rule.userId);
      return pc && pc.registrationState === 'active' ? [pc] : [];
    }

    let pcs = pcsByUser.get(rule.userId);
    if (!pcs) {
      pcs = (await this.context.repos.pcs.listForUser(rule.userId)).filter(
        (pc) => pc.registrationState === 'active',
      );
      pcsByUser.set(rule.userId, pcs);
    }
    return pcs;
  }

  private async evaluate(
    rule: StoredRule,
    now: Date,
    pcsByUser: Map<string, Pc[]>,
    cache: Map<string, Promise<Map<string, Point[]>>>,
    outcome: { fired: number; resolved: number; notificationsWritten: number; lostRaces: number },
  ): Promise<void> {
    const pcs = await this.targets(rule, pcsByUser);
    if (pcs.length === 0) return;

    const states = new Map<string, StateRow>();
    for (const row of await this.context.repos.alerts.statesFor(rule.id)) {
      states.set(`${row.pcId}|${row.seriesKey}`, row);
    }

    for (const pc of pcs) {
      const verdicts = new Map<string, Verdict>();

      if (rule.condition === 'pc-offline') {
        verdicts.set(
          '',
          judgeOffline(rule, { status: pc.status, lastSeenAt: pc.lastSeenAt ? new Date(pc.lastSeenAt) : null }, now),
        );
      } else {
        const key = `${pc.id}|${rule.metric}|${rule.condition}|${rule.forMinutes}`;
        let series = cache.get(key);
        if (!series) {
          series = this.history(pc.id, rule, now);
          cache.set(key, series);
        }
        const bySeries = await series;

        const wanted = new Set<string>();
        for (const seriesKey of bySeries.keys()) {
          if (rule.seriesKey === null || rule.seriesKey === seriesKey) wanted.add(seriesKey);
        }
        // A series with a recorded state but no data now — a disk that was unplugged, a GPU that
        // stopped reporting — is judged on nothing, which is unknown, which holds its state. A
        // firing alert about a volume that vanished stays firing; it has not recovered.
        for (const row of states.values()) {
          if (row.pcId === pc.id && (rule.seriesKey === null || rule.seriesKey === row.seriesKey)) {
            wanted.add(row.seriesKey);
          }
        }
        if (rule.seriesKey !== null) wanted.add(rule.seriesKey);

        for (const seriesKey of wanted) {
          verdicts.set(seriesKey, judgeMetric(rule, bySeries.get(seriesKey) ?? [], now));
        }
      }

      for (const [seriesKey, verdict] of verdicts) {
        await this.apply(rule, pc, seriesKey, verdict, states.get(`${pc.id}|${seriesKey}`) ?? null, now, outcome);
      }
    }
  }

  /**
   * The values of one metric on one PC over a rule's window, by series.
   *
   * For an above rule a bucket contributes its minimum, for a below rule its maximum, placed at
   * the bucket's start. That is the one value that decides the answer for the whole bucket.
   */
  private async history(pcId: string, rule: StoredRule, now: Date): Promise<Map<string, Point[]>> {
    const metric = rule.metric!;
    const windowStart = new Date(now.getTime() - rule.forMinutes * 60_000);
    const result = new Map<string, Point[]>();
    const push = (seriesKey: string | null, point: Point) => {
      const key = seriesKey ?? '';
      let points = result.get(key);
      if (!points) {
        points = [];
        result.set(key, points);
      }
      points.push(point);
    };

    let rawFrom = windowStart;

    if (rule.forMinutes > this.rawWindowMinutes) {
      const newest = await this.context.repos.telemetry.newestAggregate(pcId, '5m');

      if (newest !== null && newest.getTime() > windowStart.getTime()) {
        // Only buckets that start inside the window: one straddling its start holds values from
        // before the window, and its minimum could be one of them.
        const firstBucket = new Date(Math.ceil(windowStart.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
        const bucketsEnd = new Date(newest.getTime() + FIVE_MINUTES_MS);
        const rows = await this.context.repos.telemetry.aggregatesInWindow(pcId, '5m', firstBucket, bucketsEnd);

        for (const row of rows) {
          if (row.metric !== metric) continue;
          const value = rule.condition === 'metric-above' ? row.min : row.max;
          if (value === null || row.sampleCount === 0) continue;
          push(row.seriesKey, { at: row.bucketStart, value });
        }

        rawFrom = rows.length > 0 ? bucketsEnd : windowStart;
      }
    }

    // Half-open at the far end would drop a sample stamped exactly now; the millisecond is added.
    const samples = await this.context.repos.telemetry.samplesInWindow(pcId, rawFrom, new Date(now.getTime() + 1));
    for (const [seriesKey, points] of seriesValues(samples, metric)) {
      for (const point of points) push(seriesKey, point);
    }

    return result;
  }

  private async apply(
    rule: StoredRule,
    pc: Pc,
    seriesKey: string,
    verdict: Verdict,
    current: StateRow | null,
    now: Date,
    outcome: { fired: number; resolved: number; notificationsWritten: number; lostRaces: number },
  ): Promise<void> {
    const next = transition(current, verdict, rule.cooldownMinutes, now);
    if (next.kind === 'none') return;

    const firing = next.kind === 'fire';
    const value = verdict.kind === 'unknown' ? null : verdict.value;

    const landed = await withTransaction(this.context.db, async (client) => {
      const moved = await this.context.repos.alerts.transition(client, {
        ruleId: rule.id,
        pcId: pc.id,
        seriesKey,
        from: current ? { state: current.state, changedAt: current.changedAt } : null,
        to: firing ? 'firing' : 'ok',
        // A resolve clears the flag; a fire records whether this firing was announced.
        notified: firing && next.notify,
        notifiedAt: next.notify ? now : null,
        now,
      });

      if (!moved) return false;

      if (next.notify) {
        const words = describe({
          kind: firing ? 'fired' : 'resolved',
          ruleName: rule.name,
          pcName: pc.name,
          condition: rule.condition,
          metric: rule.metric,
          seriesKey: seriesKey === '' ? null : seriesKey,
          threshold: rule.threshold,
          forMinutes: rule.forMinutes,
          value,
          severity: rule.severity,
        });

        await this.context.repos.alerts.insertNotification(client, {
          userId: rule.userId,
          ruleId: rule.id,
          pcId: pc.id,
          kind: firing ? 'fired' : 'resolved',
          severity: rule.severity,
          title: words.title,
          detail: words.detail,
          metric: rule.metric,
          seriesKey: seriesKey === '' ? null : seriesKey,
          value,
          threshold: rule.threshold,
          occurredAt: now,
        });
      }

      return true;
    });

    if (!landed) {
      outcome.lostRaces += 1;
      return;
    }

    if (firing) outcome.fired += 1;
    else outcome.resolved += 1;
    if (next.notify) outcome.notificationsWritten += 1;
  }
}

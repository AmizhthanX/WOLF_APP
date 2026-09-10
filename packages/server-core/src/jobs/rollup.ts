import type { Logger } from 'pino';
import {
  bucketIsSettled,
  bucketStart,
  DEFAULT_RETENTION_POLICY,
  RESOLUTION_SECONDS,
  ROLLUP_SOURCE,
  rollupAggregates,
  rollupSamples,
  type AggregateResolution,
  type AggregateRow,
  type RetentionPolicy,
} from '@wolf/telemetry-schema';
import type { ServerContext } from '../context.js';

/**
 * Turning samples into history, and then letting go of them.
 *
 * An agent produces a sample every few seconds. Kept forever that is unbounded growth on
 * somebody else's bill and useless besides: nobody asks what the CPU was doing at 14:03:07 last
 * March, they ask whether it has been getting worse. So raw samples live for days, five-minute
 * buckets for a month, hourly for six, daily for a year — and this job is what moves data
 * between those and drops what has run out.
 *
 * The arithmetic is in `@wolf/telemetry-schema` and is pure. What is here is the part that
 * needs a clock and a database: deciding which buckets are finished, where to resume, and how
 * much to do in one pass.
 *
 * ## Three properties this job has to have
 *
 * **Idempotent.** Every write is an upsert of a value computed only from the inputs, so
 * running twice — after a crash, or on two API instances at once — produces the same rows. No
 * locking, no leader election, no cursor that can drift out of step with the data.
 *
 * **Resumable without a cursor.** Where to start is derived from the newest bucket already
 * written. A separate cursor table would be a second thing to keep in step, and it would be
 * wrong in exactly the case that matters: a crash between writing a bucket and advancing the
 * cursor.
 *
 * **Bounded.** A machine that was offline for a month comes back with a month of catching up,
 * and doing it in one pass would be a query that never finishes. Each run does a fixed number
 * of buckets per PC and the next run continues.
 */
export interface RollupOptions {
  readonly intervalMs?: number;
  /** Buckets of one resolution processed for one PC in one pass. */
  readonly maxBucketsPerRun?: number;
  /** PCs looked at in one pass. */
  readonly maxPcsPerRun?: number;
  readonly retention?: RetentionPolicy;
}

/** What one pass did, so the caller and the tests can see it rather than infer it. */
export interface RollupOutcome {
  readonly pcsExamined: number;
  readonly bucketsWritten: Readonly<Record<Exclude<AggregateResolution, 'raw'>, number>>;
  readonly aggregatesDropped: number;
  readonly partitionsDropped: readonly string[];
}

const RESOLUTIONS: readonly Exclude<AggregateResolution, 'raw'>[] = ['5m', '1h', '1d'];

export class RollupJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly maxBucketsPerRun: number;
  private readonly maxPcsPerRun: number;
  private readonly retention: RetentionPolicy;
  private readonly logger: Logger;

  constructor(
    private readonly context: ServerContext,
    options: RollupOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.maxBucketsPerRun = options.maxBucketsPerRun ?? 96;
    this.maxPcsPerRun = options.maxPcsPerRun ?? 200;
    this.retention = options.retention ?? DEFAULT_RETENTION_POLICY;
    this.logger = context.logger.child({ job: 'rollup' });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    // Never the reason the process stays alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<RollupOutcome | null> {
    // A pass that overlaps its predecessor would be correct — every write is an upsert — and
    // would double the load for nothing. Skipped rather than queued.
    if (this.running) return null;
    this.running = true;

    const written: Record<Exclude<AggregateResolution, 'raw'>, number> = { '5m': 0, '1h': 0, '1d': 0 };
    let pcsExamined = 0;

    try {
      const now = this.context.now();

      // Anything that produced a sample within the raw window might have a bucket that has
      // only just settled. Looking further back would be work with nothing to show for it.
      const since = new Date(now.getTime() - this.retention.rawDays * 86_400_000);
      const pcIds = await this.context.repos.telemetry.pcsNeedingRollup(since, this.maxPcsPerRun);

      for (const pcId of pcIds) {
        pcsExamined += 1;

        for (const resolution of RESOLUTIONS) {
          written[resolution] += await this.rollForward(pcId, resolution, now);
        }
      }

      const { aggregatesDropped, partitionsDropped } = await this.enforceRetention(now);

      if (pcsExamined > 0 || aggregatesDropped > 0 || partitionsDropped.length > 0) {
        this.logger.info(
          { pcsExamined, written, aggregatesDropped, partitionsDropped: partitionsDropped.length },
          'Rolled telemetry up',
        );
      }

      return { pcsExamined, bucketsWritten: written, aggregatesDropped, partitionsDropped };
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Telemetry rollup failed',
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Bring one PC's buckets at one resolution up to date.
   *
   * Returns how many buckets were written, which is the thing worth counting: a run that
   * examined forty PCs and wrote nothing is a healthy idle, and a run that wrote thousands is
   * a fleet catching up after an outage.
   */
  private async rollForward(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
    now: Date,
  ): Promise<number> {
    const from = await this.startingBucket(pcId, resolution);
    if (from === null) return 0;

    // How far the resolution beneath this one has actually got.
    //
    // Without this, a bounded pass finalises a coarse bucket from a partial finer one and
    // never comes back: the first run rolls eight hours of five-minute buckets, builds a
    // *day* out of those eight hours, and the daily watermark then sits past the day for
    // ever. The day is permanently missing two thirds of itself.
    //
    // A cascade bucket is therefore eligible only when the source covers all of it. Found by
    // a test asserting a full day came back with 1440 samples and getting 480.
    const sourceComplete = await this.sourceCoveredUntil(pcId, resolution);
    if (sourceComplete === null) return 0;

    const bucketMs = RESOLUTION_SECONDS[resolution] * 1000;
    const buckets: Date[] = [];

    for (let cursor = from; buckets.length < this.maxBucketsPerRun; cursor = new Date(cursor.getTime() + bucketMs)) {
      // Only buckets that have ended and had time for stragglers. Rolling one up early stores
      // a partial answer, and for the coarser resolutions that partial answer becomes
      // permanent once the rows it came from are gone.
      if (!bucketIsSettled(cursor, resolution, now)) break;
      if (cursor.getTime() + bucketMs > sourceComplete.getTime()) break;
      buckets.push(cursor);
    }

    if (buckets.length === 0) return 0;

    const windowStart = buckets[0]!;
    const windowEnd = new Date(buckets[buckets.length - 1]!.getTime() + bucketMs);

    const rows =
      ROLLUP_SOURCE[resolution] === 'raw'
        ? rollupSamples(
            // Half-open, like the aggregate window below it. A sample exactly on a boundary
            // belongs to the bucket that starts there and to no other.
            await this.context.repos.telemetry.samplesInWindow(pcId, windowStart, windowEnd),
            resolution,
          )
        : rollupAggregates(
            (
              await this.context.repos.telemetry.aggregatesInWindow(
                pcId,
                ROLLUP_SOURCE[resolution] as Exclude<AggregateResolution, 'raw'>,
                windowStart,
                windowEnd,
              )
            ).map(toRow),
            resolution,
          );

    if (rows.length === 0) {
      // Nothing to write, but the window still has to be crossed — a machine switched off for
      // an hour has no hour, and leaving the watermark where it was would make the job try
      // that same empty window again every minute for as long as the samples are kept.
      //
      // Crossing it means writing nothing and letting the *next* run start from the same
      // place, which it will, because the watermark is derived from what was written. That is
      // acceptable: the query is bounded and cheap, and the alternative is a cursor table with
      // its own failure modes. An empty window stops being retried when the raw samples
      // beneath it are dropped.
      return 0;
    }

    await this.context.repos.telemetry.upsertAggregates(
      pcId,
      resolution,
      rows.map((row) => ({
        metric: row.metric,
        seriesKey: row.seriesKey,
        bucketStart: row.bucketStart,
        min: row.value.min,
        max: row.value.max,
        avg: row.value.avg,
        p95: row.value.p95,
        sampleCount: row.value.sampleCount,
      })),
    );

    return new Set(rows.map((row) => row.bucketStart.getTime())).size;
  }

  /**
   * The moment up to which this resolution's source is complete.
   *
   * For the five-minute buckets that is the clock: raw samples are the source, and a bucket
   * that has ended and had its grace period is as complete as it will ever be. For the
   * coarser ones it is the end of the newest bucket beneath them — a day cannot be finished
   * while the hours it is made of are still arriving.
   */
  private async sourceCoveredUntil(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
  ): Promise<Date | null> {
    const source = ROLLUP_SOURCE[resolution];
    if (source === 'raw') return new Date(8_640_000_000_000_000);

    const newest = await this.context.repos.telemetry.newestAggregate(
      pcId,
      source as Exclude<AggregateResolution, 'raw'>,
    );

    return newest === null
      ? null
      : new Date(newest.getTime() + RESOLUTION_SECONDS[source as Exclude<AggregateResolution, 'raw'>] * 1000);
  }

  /**
   * Where to resume for one PC and resolution.
   *
   * The bucket after the newest one already written. With nothing written yet — a PC seen for
   * the first time, or one whose history has aged out — it is the bucket the oldest surviving
   * input falls into.
   */
  private async startingBucket(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
  ): Promise<Date | null> {
    const newest = await this.context.repos.telemetry.newestAggregate(pcId, resolution);

    if (newest !== null) {
      return new Date(newest.getTime() + RESOLUTION_SECONDS[resolution] * 1000);
    }

    const source = ROLLUP_SOURCE[resolution];

    // The *oldest* surviving input, not the newest. Starting from the newest would skip
    // everything before it and lose the beginning of a machine's history without saying so.
    const oldest =
      source === 'raw'
        ? await this.context.repos.telemetry.oldestSample(pcId)
        : await this.context.repos.telemetry.oldestAggregate(
            pcId,
            source as Exclude<AggregateResolution, 'raw'>,
          );

    return oldest === null ? null : bucketStart(oldest, resolution);
  }

  /**
   * Drop what has outlived its window.
   *
   * Raw samples go by dropping whole partitions, which is a metadata operation rather than a
   * scan of millions of rows. Aggregates go by delete: there are orders of magnitude fewer of
   * them, and a partition scheme per resolution would be more machinery than the data is worth.
   *
   * Retention is enforced here rather than left to a database job because it is a promise the
   * product makes about somebody's data, and a promise kept by a cron entry nobody can see
   * from the code is one that quietly stops being kept.
   */
  private async enforceRetention(now: Date): Promise<{
    aggregatesDropped: number;
    partitionsDropped: readonly string[];
  }> {
    const partitionsDropped = await this.context.repos.telemetry.dropPartitionsBefore(
      new Date(now.getTime() - this.retention.rawDays * 86_400_000),
    );

    const windows: [Exclude<AggregateResolution, 'raw'>, number][] = [
      ['5m', this.retention.fiveMinuteDays],
      ['1h', this.retention.hourlyDays],
      ['1d', this.retention.dailyDays],
    ];

    let aggregatesDropped = 0;

    for (const [resolution, days] of windows) {
      aggregatesDropped += await this.context.repos.telemetry.deleteAggregatesBefore(
        resolution,
        new Date(now.getTime() - days * 86_400_000),
      );
    }

    return { aggregatesDropped, partitionsDropped };
  }
}

/** The repository's row shape, as the pure rollup wants it. */
function toRow(row: {
  bucketStart: Date;
  metric: string;
  seriesKey: string;
  min: number | null;
  max: number | null;
  avg: number | null;
  p95: number | null;
  sampleCount: number;
}): AggregateRow {
  return {
    bucketStart: row.bucketStart,
    // Stored as an empty string because the unique index treats two nulls as distinct;
    // carried back as null because that is what "this is a whole-machine metric" means.
    metric: row.metric as AggregateRow['metric'],
    seriesKey: row.seriesKey === '' ? null : row.seriesKey,
    value: {
      min: row.min,
      max: row.max,
      avg: row.avg,
      p95: row.p95,
      sampleCount: row.sampleCount,
    },
  };
}

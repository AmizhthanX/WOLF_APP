import type { AggregateResolution, TelemetrySample } from '@wolf/telemetry-schema';
import type { Database } from '../pool.js';

export interface StoredSample {
  readonly sampledAt: Date;
  readonly sample: TelemetrySample;
}

export interface AggregateRow {
  readonly bucketStart: Date;
  readonly metric: string;
  readonly seriesKey: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly p95: number | null;
  readonly sampleCount: number;
}

export class TelemetryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert a batch of samples.
   *
   * Duplicate (pc, timestamp) pairs are ignored rather than rejected: an agent replaying
   * its offline buffer after a reconnect will legitimately resend samples the cloud
   * already has, and that must not fail the whole batch.
   */
  async insertBatch(pcId: string, samples: readonly TelemetrySample[]): Promise<number> {
    if (samples.length === 0) return 0;

    const values: unknown[] = [];
    const placeholders = samples.map((sample, index) => {
      const base = index * 3;
      values.push(pcId, sample.sampledAt, JSON.stringify(sample));
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    const { rowCount } = await this.db.query(
      `INSERT INTO telemetry_samples (pc_id, sampled_at, sample)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (pc_id, sampled_at) DO NOTHING`,
      values,
    );
    return rowCount ?? 0;
  }

  async latestSample(pcId: string): Promise<StoredSample | null> {
    const { rows } = await this.db.query<{ sampled_at: Date; sample: TelemetrySample }>(
      `SELECT sampled_at, sample FROM telemetry_samples
        WHERE pc_id = $1
        ORDER BY sampled_at DESC
        LIMIT 1`,
      [pcId],
    );
    const row = rows[0];
    return row ? { sampledAt: row.sampled_at, sample: row.sample } : null;
  }

  async listSamples(pcId: string, from: Date, to: Date, limit = 3600): Promise<StoredSample[]> {
    const { rows } = await this.db.query<{ sampled_at: Date; sample: TelemetrySample }>(
      `SELECT sampled_at, sample FROM telemetry_samples
        WHERE pc_id = $1 AND sampled_at >= $2 AND sampled_at <= $3
        ORDER BY sampled_at
        LIMIT $4`,
      [pcId, from, to, Math.min(limit, 10_000)],
    );
    return rows.map((row) => ({ sampledAt: row.sampled_at, sample: row.sample }));
  }

  async listAggregates(input: {
    pcId: string;
    resolution: Exclude<AggregateResolution, 'raw'>;
    metrics: readonly string[];
    from: Date;
    to: Date;
  }): Promise<AggregateRow[]> {
    const { rows } = await this.db.query<{
      bucket_start: Date;
      metric: string;
      series_key: string;
      min_value: number | null;
      max_value: number | null;
      avg_value: number | null;
      p95_value: number | null;
      sample_count: number;
    }>(
      `SELECT bucket_start, metric, series_key, min_value, max_value, avg_value,
              p95_value, sample_count
         FROM telemetry_aggregates
        WHERE pc_id = $1 AND resolution = $2 AND metric = ANY($3)
          AND bucket_start >= $4 AND bucket_start <= $5
        ORDER BY bucket_start`,
      [input.pcId, input.resolution, input.metrics, input.from, input.to],
    );
    return rows.map((row) => ({
      bucketStart: row.bucket_start,
      metric: row.metric,
      seriesKey: row.series_key,
      min: row.min_value,
      max: row.max_value,
      avg: row.avg_value,
      p95: row.p95_value,
      sampleCount: row.sample_count,
    }));
  }

  async upsertAggregate(input: {
    pcId: string;
    resolution: Exclude<AggregateResolution, 'raw'>;
    metric: string;
    seriesKey: string;
    bucketStart: Date;
    min: number | null;
    max: number | null;
    avg: number | null;
    p95: number | null;
    sampleCount: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO telemetry_aggregates
         (pc_id, resolution, metric, series_key, bucket_start,
          min_value, max_value, avg_value, p95_value, sample_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (pc_id, resolution, metric, series_key, bucket_start) DO UPDATE SET
         min_value = EXCLUDED.min_value,
         max_value = EXCLUDED.max_value,
         avg_value = EXCLUDED.avg_value,
         p95_value = EXCLUDED.p95_value,
         sample_count = EXCLUDED.sample_count`,
      [
        input.pcId,
        input.resolution,
        input.metric,
        input.seriesKey,
        input.bucketStart,
        input.min,
        input.max,
        input.avg,
        input.p95,
        input.sampleCount,
      ],
    );
  }

  /**
   * Raw samples in a half-open window: `from` included, `to` not.
   *
   * Deliberately not `listSamples`, whose upper bound is inclusive because it answers "show me
   * this range" for a chart. A rollup needs half-open, and mixing the two is not a detail: a
   * sample landing exactly on a bucket boundary was being counted in both buckets, which put a
   * partial extra bucket at the end of every window and inflated every total above it. Caught
   * by a test that asked for two buckets and got three.
   */
  async samplesInWindow(pcId: string, from: Date, to: Date, limit = 10_000): Promise<StoredSample[]> {
    const { rows } = await this.db.query<{ sampled_at: Date; sample: TelemetrySample }>(
      `SELECT sampled_at, sample FROM telemetry_samples
        WHERE pc_id = $1 AND sampled_at >= $2 AND sampled_at < $3
        ORDER BY sampled_at
        LIMIT $4`,
      [pcId, from, to, limit],
    );
    return rows.map((row) => ({ sampledAt: row.sampled_at, sample: row.sample }));
  }

  /**
   * PCs that have raw samples the rollup has not caught up with.
   *
   * Driven off the data rather than off a list of PCs, so a machine that has been offline for
   * a month costs nothing until it says something. The alternative — sweeping every PC every
   * minute — is work proportional to the fleet rather than to what changed.
   */
  async pcsNeedingRollup(since: Date, limit = 200): Promise<string[]> {
    const { rows } = await this.db.query<{ pc_id: string }>(
      `SELECT DISTINCT pc_id FROM telemetry_samples
        WHERE sampled_at >= $1
        LIMIT $2`,
      [since, limit],
    );
    return rows.map((row) => row.pc_id);
  }

  /**
   * The newest bucket already written for one PC at one resolution.
   *
   * This is the watermark the job resumes from, and it is derived rather than stored: a
   * separate cursor table would be a second thing to keep in step with the data, and it would
   * be wrong in exactly the case that matters — after a crash between writing a bucket and
   * advancing the cursor.
   */
  async newestAggregate(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
  ): Promise<Date | null> {
    const { rows } = await this.db.query<{ bucket_start: Date }>(
      `SELECT bucket_start FROM telemetry_aggregates
        WHERE pc_id = $1 AND resolution = $2
        ORDER BY bucket_start DESC
        LIMIT 1`,
      [pcId, resolution],
    );
    return rows[0]?.bucket_start ?? null;
  }

  /**
   * The oldest bucket held for one PC at one resolution.
   *
   * Where a cascade begins when it has never run. Using the *newest* here instead would skip
   * everything before it and lose the beginning of a machine's history silently — which is
   * exactly the kind of wrong that nobody notices until they go looking for last Tuesday.
   */
  async oldestAggregate(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
  ): Promise<Date | null> {
    const { rows } = await this.db.query<{ bucket_start: Date }>(
      `SELECT bucket_start FROM telemetry_aggregates
        WHERE pc_id = $1 AND resolution = $2
        ORDER BY bucket_start
        LIMIT 1`,
      [pcId, resolution],
    );
    return rows[0]?.bucket_start ?? null;
  }

  /** The oldest raw sample still held for one PC, so a first rollup knows where to begin. */
  async oldestSample(pcId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ sampled_at: Date }>(
      `SELECT sampled_at FROM telemetry_samples
        WHERE pc_id = $1
        ORDER BY sampled_at
        LIMIT 1`,
      [pcId],
    );
    return rows[0]?.sampled_at ?? null;
  }

  /**
   * Write many aggregate rows at once.
   *
   * One statement rather than one per row: a busy PC produces a few hundred rows per hourly
   * rollup, and a round trip each would make the job's cost the network rather than the work.
   */
  async upsertAggregates(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
    rows: readonly {
      metric: string;
      seriesKey: string | null;
      bucketStart: Date;
      min: number | null;
      max: number | null;
      avg: number | null;
      p95: number | null;
      sampleCount: number;
    }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 10;
      values.push(
        pcId,
        resolution,
        row.metric,
        // The unique index treats two nulls as distinct, so a whole-machine series is stored
        // under a fixed empty key rather than null. Without this every rollup would insert a
        // new row instead of replacing the one before it.
        row.seriesKey ?? '',
        row.bucketStart,
        row.min,
        row.max,
        row.avg,
        row.p95,
        row.sampleCount,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
    });

    const { rowCount } = await this.db.query(
      `INSERT INTO telemetry_aggregates
         (pc_id, resolution, metric, series_key, bucket_start,
          min_value, max_value, avg_value, p95_value, sample_count)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (pc_id, resolution, metric, series_key, bucket_start) DO UPDATE SET
         min_value = EXCLUDED.min_value,
         max_value = EXCLUDED.max_value,
         avg_value = EXCLUDED.avg_value,
         p95_value = EXCLUDED.p95_value,
         sample_count = EXCLUDED.sample_count`,
      values,
    );

    return rowCount ?? 0;
  }

  /**
   * Read back aggregates for one PC so they can be rolled up again.
   *
   * The cascade's input. Deliberately not `listAggregates`, which is shaped for a dashboard
   * query across chosen metrics — this wants everything in a window, whatever it is.
   */
  async aggregatesInWindow(
    pcId: string,
    resolution: Exclude<AggregateResolution, 'raw'>,
    from: Date,
    to: Date,
  ): Promise<AggregateRow[]> {
    const { rows } = await this.db.query<{
      bucket_start: Date;
      metric: string;
      series_key: string;
      min_value: number | null;
      max_value: number | null;
      avg_value: number | null;
      p95_value: number | null;
      sample_count: number;
    }>(
      `SELECT bucket_start, metric, series_key, min_value, max_value, avg_value,
              p95_value, sample_count
         FROM telemetry_aggregates
        WHERE pc_id = $1 AND resolution = $2 AND bucket_start >= $3 AND bucket_start < $4
        ORDER BY bucket_start`,
      [pcId, resolution, from, to],
    );

    return rows.map((row) => ({
      bucketStart: row.bucket_start,
      metric: row.metric,
      seriesKey: row.series_key,
      min: row.min_value,
      max: row.max_value,
      avg: row.avg_value,
      p95: row.p95_value,
      sampleCount: row.sample_count,
    }));
  }

  /**
   * Delete aggregates that have outlived their retention window.
   *
   * Per resolution, because each has its own window: five-minute buckets go after a month,
   * hourly after six, daily after a year. Deleting rather than partitioning because these are
   * orders of magnitude smaller than the raw table, and a delete of a few thousand rows is
   * cheaper to reason about than a partition per resolution per day.
   */
  async deleteAggregatesBefore(
    resolution: Exclude<AggregateResolution, 'raw'>,
    cutoff: Date,
  ): Promise<number> {
    const { rowCount } = await this.db.query(
      'DELETE FROM telemetry_aggregates WHERE resolution = $1 AND bucket_start < $2',
      [resolution, cutoff],
    );
    return rowCount ?? 0;
  }

  /** Create upcoming raw partitions. Called by the maintenance job. */
  async ensurePartitions(daysAhead = 3): Promise<number> {
    const { rows } = await this.db.query<{ wolf_ensure_telemetry_partitions: number }>(
      'SELECT wolf_ensure_telemetry_partitions($1)',
      [daysAhead],
    );
    return rows[0]?.wolf_ensure_telemetry_partitions ?? 0;
  }

  /** Drop raw partitions older than the retention window. */
  async dropPartitionsBefore(cutoff: Date): Promise<string[]> {
    const { rows } = await this.db.query<{ wolf_drop_telemetry_partitions_before: string }>(
      'SELECT wolf_drop_telemetry_partitions_before($1)',
      [cutoff.toISOString().slice(0, 10)],
    );
    return rows.map((row) => row.wolf_drop_telemetry_partitions_before);
  }
}

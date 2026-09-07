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

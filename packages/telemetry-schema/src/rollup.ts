import type { AggregateResolution, AggregatedMetric } from './aggregates.js';
import { RESOLUTION_SECONDS } from './aggregates.js';
import type { TelemetrySample } from './samples.js';

/**
 * Turning samples into history.
 *
 * An agent produces a sample every few seconds. Kept forever that is unbounded growth on
 * somebody else's bill, and useless besides: nobody asks what the CPU was doing at 14:03:07
 * last March. What they ask is whether it has been getting worse.
 *
 * So raw samples live for days and are rolled into five-minute buckets, five-minute buckets
 * into hours, hours into days. Each step throws away detail nothing was going to look at and
 * keeps the shape of what happened.
 *
 * ## Why the rollup cascades instead of always reading raw
 *
 * The obvious design computes every resolution from the raw samples. It is also wrong here,
 * and wrong in a way that only shows up weeks later: raw samples are dropped after a couple of
 * days, so an hourly bucket recomputed after that would come back empty and overwrite a good
 * value with nothing.
 *
 * Rolling 5m → 1h → 1d instead means every resolution is derivable from one that outlives it.
 * The cost is that the coarser buckets are aggregates of aggregates, which matters for exactly
 * one statistic — see {@link mergeAggregates}.
 *
 * ## Everything here is pure
 *
 * No database, no clock, no I/O. This is where the correctness lives, so it is where the tests
 * can reach without a Postgres.
 */

/** A summary of one series over one bucket. */
export interface Aggregate {
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly p95: number | null;
  readonly sampleCount: number;
}

/** One row ready to be written: a bucket, a metric, and which device it belongs to. */
export interface AggregateRow {
  readonly bucketStart: Date;
  readonly metric: AggregatedMetric;
  /** Adapter id, volume, or adapter name for per-device metrics; null for whole-machine ones. */
  readonly seriesKey: string | null;
  readonly value: Aggregate;
}

/** One measurement pulled out of a sample, before it is bucketed. */
export interface Reading {
  readonly metric: AggregatedMetric;
  readonly seriesKey: string | null;
  readonly value: number;
}

/**
 * The start of the bucket a moment falls into.
 *
 * Aligned to the epoch rather than to the first sample, so two runs of the job — or two API
 * instances doing it at once — agree on where a bucket begins. A bucket boundary that depended
 * on when the job happened to run would make the same data aggregate differently every time.
 */
export function bucketStart(at: Date, resolution: Exclude<AggregateResolution, 'raw'>): Date {
  const seconds = RESOLUTION_SECONDS[resolution];
  const ms = seconds * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/**
 * Every metric a single sample contributes, flattened.
 *
 * Exported because alert rules judge metrics too, and they must judge the same number the history
 * chart draws. Two definitions of "disk used" — one here, one in the rule engine — would be a rule
 * firing on a value the owner cannot find on any chart.
 */
export function readingsOf(sample: TelemetrySample): Reading[] {
  const readings: Reading[] = [];

  const add = (metric: AggregatedMetric, seriesKey: string | null, value: number | null | undefined) => {
    // Null is "not measured", which is not zero. A CPU with no temperature sensor must not
    // pull the average temperature of a fleet towards freezing.
    if (typeof value === 'number' && Number.isFinite(value)) {
      readings.push({ metric, seriesKey, value });
    }
  };

  add('cpu.usage', null, sample.cpu.usagePercent);
  add('cpu.temperature', null, sample.cpu.temperatureCelsius);
  add('memory.used', null, sample.memory.usedBytes);

  if (sample.memory.totalBytes && sample.memory.totalBytes > 0 && sample.memory.usedBytes !== null) {
    add('memory.usedPercent', null, (sample.memory.usedBytes / sample.memory.totalBytes) * 100);
  }

  for (const gpu of sample.gpus) {
    add('gpu.usage', gpu.adapterId, gpu.usagePercent);
    add('gpu.vramUsed', gpu.adapterId, gpu.vramUsedBytes);
    add('gpu.temperature', gpu.adapterId, gpu.temperatureCelsius);
  }

  for (const disk of sample.disks) {
    if (disk.totalBytes && disk.totalBytes > 0 && disk.freeBytes !== null) {
      // Stored as used rather than free, because "85% full" is the number somebody acts on
      // and "15% free" is the same fact phrased so it has to be converted first.
      add('disk.usedPercent', disk.volume, ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
    }
    add('disk.activeTime', disk.volume, disk.activeTimePercent);
  }

  for (const network of sample.networks) {
    // Loopback and virtual adapters are skipped: they carry traffic that never left the
    // machine, and including them makes a fleet look busier than it is.
    if (network.kind === 'loopback' || network.kind === 'virtual') continue;

    add('network.receiveRate', network.adapterId, network.receiveBytesPerSecond);
    add('network.sendRate', network.adapterId, network.sendBytesPerSecond);
  }

  if (sample.battery?.present) add('battery.charge', null, sample.battery.chargePercent);

  if (sample.agent) {
    add('agent.cpu', null, sample.agent.cpuPercent);
    add('agent.memory', null, sample.agent.memoryBytes);
  }

  return readings;
}

/**
 * The 95th percentile, by nearest rank.
 *
 * Nearest rank rather than an interpolating variant on purpose: every value it returns is a
 * number the machine actually reported. An interpolated p95 of 87.3% CPU when no sample said
 * 87.3% is a number that cannot be traced back to anything, which is a poor property for a
 * figure somebody is about to act on.
 */
export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function summarise(values: readonly number[]): Aggregate {
  if (values.length === 0) {
    return { min: null, max: null, avg: null, p95: null, sampleCount: 0 };
  }

  let min = values[0]!;
  let max = values[0]!;
  let total = 0;

  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }

  return {
    min,
    max,
    avg: total / values.length,
    p95: percentile95(values),
    sampleCount: values.length,
  };
}

/**
 * Roll raw samples into buckets of one resolution.
 *
 * Every sample given is used. Deciding *which* samples belong to a run — and in particular
 * never rolling up a bucket that is still filling — belongs to the caller, because it needs a
 * clock and this does not.
 */
export function rollupSamples(
  samples: readonly { readonly sampledAt: Date; readonly sample: TelemetrySample }[],
  resolution: Exclude<AggregateResolution, 'raw'>,
): AggregateRow[] {
  const buckets = new Map<string, { bucket: Date; metric: AggregatedMetric; seriesKey: string | null; values: number[] }>();

  for (const entry of samples) {
    const bucket = bucketStart(entry.sampledAt, resolution);

    for (const reading of readingsOf(entry.sample)) {
      // The series key is part of the identity, not a label: two GPUs in one machine are two
      // series, and averaging them together would describe neither.
      const key = `${bucket.getTime()}|${reading.metric}|${reading.seriesKey ?? ''}`;
      let existing = buckets.get(key);

      if (!existing) {
        existing = { bucket, metric: reading.metric, seriesKey: reading.seriesKey, values: [] };
        buckets.set(key, existing);
      }

      existing.values.push(reading.value);
    }
  }

  return [...buckets.values()]
    .map((entry) => ({
      bucketStart: entry.bucket,
      metric: entry.metric,
      seriesKey: entry.seriesKey,
      value: summarise(entry.values),
    }))
    .sort(order);
}

/**
 * Merge finer buckets into coarser ones.
 *
 * Three of the four statistics survive this exactly. The minimum of the minimums is the
 * minimum; the maximum of the maximums is the maximum; a count-weighted mean of the means is
 * the mean.
 *
 * **The 95th percentile does not, and cannot.** A percentile is not recoverable from summaries
 * of its parts — reconstructing it would need every original value, which is the thing being
 * thrown away. What is stored instead is the largest of the contributing p95s, which is
 * something honest with a name: the worst five-minute spike in the hour. It is not the hour's
 * true 95th percentile and this is the only place that says so, because a number that is
 * quietly a different statistic from the one its column is called is worse than a missing one.
 */
export function mergeAggregates(parts: readonly Aggregate[]): Aggregate {
  const present = parts.filter((part) => part.sampleCount > 0);

  if (present.length === 0) {
    return { min: null, max: null, avg: null, p95: null, sampleCount: 0 };
  }

  let min: number | null = null;
  let max: number | null = null;
  let p95: number | null = null;
  let weighted = 0;
  let count = 0;

  for (const part of present) {
    if (part.min !== null) min = min === null ? part.min : Math.min(min, part.min);
    if (part.max !== null) max = max === null ? part.max : Math.max(max, part.max);
    if (part.p95 !== null) p95 = p95 === null ? part.p95 : Math.max(p95, part.p95);

    if (part.avg !== null) {
      // Weighted by how many samples each part actually had. An unweighted mean of means
      // would let a bucket with three samples count as much as one with three hundred, which
      // is exactly what happens when an agent is restarted mid-hour.
      weighted += part.avg * part.sampleCount;
      count += part.sampleCount;
    }
  }

  return {
    min,
    max,
    avg: count > 0 ? weighted / count : null,
    p95,
    sampleCount: count,
  };
}

/** Roll a set of already-aggregated rows up to the next resolution. */
export function rollupAggregates(
  rows: readonly AggregateRow[],
  resolution: Exclude<AggregateResolution, 'raw'>,
): AggregateRow[] {
  const buckets = new Map<
    string,
    { bucket: Date; metric: AggregatedMetric; seriesKey: string | null; parts: Aggregate[] }
  >();

  for (const row of rows) {
    const bucket = bucketStart(row.bucketStart, resolution);
    const key = `${bucket.getTime()}|${row.metric}|${row.seriesKey ?? ''}`;

    let existing = buckets.get(key);
    if (!existing) {
      existing = { bucket, metric: row.metric, seriesKey: row.seriesKey, parts: [] };
      buckets.set(key, existing);
    }

    existing.parts.push(row.value);
  }

  return [...buckets.values()]
    .map((entry) => ({
      bucketStart: entry.bucket,
      metric: entry.metric,
      seriesKey: entry.seriesKey,
      value: mergeAggregates(entry.parts),
    }))
    .sort(order);
}

/** Which resolution each one is built from. Raw feeds only the finest bucket. */
export const ROLLUP_SOURCE: Readonly<Record<Exclude<AggregateResolution, 'raw'>, AggregateResolution>> =
  Object.freeze({
    '5m': 'raw',
    '1h': '5m',
    '1d': '1h',
  });

/**
 * How long after a bucket ends before it is safe to roll up.
 *
 * A bucket is only finished when nothing more will land in it, and samples arrive late: an
 * agent that was offline replays its buffer, and a slow link delivers a batch minutes after it
 * was taken. Rolling up too early stores a partial answer — and for the coarser resolutions
 * that partial answer becomes permanent once the finer rows it came from are gone.
 *
 * Two minutes for the five-minute buckets is generous for a live agent and short enough that
 * history is never far behind. Coarser buckets inherit the delay of everything beneath them.
 */
export const ROLLUP_GRACE_SECONDS = 120;

/** True when a bucket has ended long enough ago that nothing more should land in it. */
export function bucketIsSettled(
  bucket: Date,
  resolution: Exclude<AggregateResolution, 'raw'>,
  now: Date,
  graceSeconds: number = ROLLUP_GRACE_SECONDS,
): boolean {
  const endsAt = bucket.getTime() + RESOLUTION_SECONDS[resolution] * 1000;
  return now.getTime() >= endsAt + graceSeconds * 1000;
}

function order(left: AggregateRow, right: AggregateRow): number {
  return (
    left.bucketStart.getTime() - right.bucketStart.getTime() ||
    left.metric.localeCompare(right.metric) ||
    (left.seriesKey ?? '').localeCompare(right.seriesKey ?? '')
  );
}

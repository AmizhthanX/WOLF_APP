import { z } from 'zod';
import { isoDateTime } from '@wolf/validation';

/**
 * Telemetry is stored in tiers. Raw samples answer "what is happening right now"; they are
 * expensive and short-lived. Aggregates answer "what has been happening" and are what
 * long retention windows actually store.
 */
export const AGGREGATE_RESOLUTIONS = ['raw', '5m', '1h', '1d'] as const;
export const aggregateResolution = z.enum(AGGREGATE_RESOLUTIONS);
export type AggregateResolution = z.infer<typeof aggregateResolution>;

export const RESOLUTION_SECONDS: Readonly<Record<AggregateResolution, number>> = Object.freeze({
  raw: 1,
  '5m': 300,
  '1h': 3600,
  '1d': 86_400,
});

/** Statistical summary of one numeric series over one aggregation bucket. */
export const metricAggregate = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
  /** 95th percentile: the number that actually characterises a load spike. */
  p95: z.number().nullable(),
  /** Samples that contributed. Zero means the counter was unreadable for the whole bucket. */
  sampleCount: z.number().int().nonnegative(),
});
export type MetricAggregate = z.infer<typeof metricAggregate>;

/** Metric series WOLF aggregates. Per-device series carry a `seriesKey` discriminator. */
export const AGGREGATED_METRICS = [
  'cpu.usage',
  'cpu.temperature',
  'memory.used',
  'memory.usedPercent',
  'gpu.usage',
  'gpu.vramUsed',
  'gpu.temperature',
  'disk.usedPercent',
  'disk.activeTime',
  'network.receiveRate',
  'network.sendRate',
  'battery.charge',
  'agent.cpu',
  'agent.memory',
] as const;
export const aggregatedMetric = z.enum(AGGREGATED_METRICS);
export type AggregatedMetric = z.infer<typeof aggregatedMetric>;

export const telemetryAggregate = z.object({
  bucketStart: isoDateTime,
  resolution: aggregateResolution,
  metric: aggregatedMetric,
  /** Adapter id, volume, or adapter name for per-device metrics; null for whole-machine ones. */
  seriesKey: z.string().max(128).nullable(),
  value: metricAggregate,
});
export type TelemetryAggregate = z.infer<typeof telemetryAggregate>;

export const RETENTION_PRESET_DAYS = [7, 30, 90, 180, 365] as const;

export const retentionPolicy = z.object({
  /** How long raw one-second samples are kept before being rolled up and dropped. */
  rawDays: z.number().int().min(1).max(30).default(2),
  fiveMinuteDays: z.number().int().min(1).max(400).default(30),
  hourlyDays: z.number().int().min(1).max(1200).default(180),
  dailyDays: z.number().int().min(1).max(3650).default(365),
  /** Audit and security events are retained separately and are never rolled up. */
  auditDays: z.number().int().min(30).max(3650).default(365),
});
export type RetentionPolicy = z.infer<typeof retentionPolicy>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = retentionPolicy.parse({});

/** Coarsest resolution that can answer a query over the given window without gaps. */
export function resolutionForWindow(
  windowSeconds: number,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): AggregateResolution {
  const days = windowSeconds / 86_400;
  if (days <= policy.rawDays && windowSeconds <= 3 * 3600) return 'raw';
  if (days <= policy.fiveMinuteDays) return '5m';
  if (days <= policy.hourlyDays) return '1h';
  return '1d';
}

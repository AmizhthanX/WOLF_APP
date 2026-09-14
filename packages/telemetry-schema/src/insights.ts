import type { DiskSample } from './samples.js';

/**
 * What the history says, in words an owner can act on.
 *
 * Pure: history in, conclusions out. Nothing here is stored — insights are computed when asked
 * for, from telemetry the cloud already holds, so there is no second copy of anything to keep in
 * step or to delete.
 *
 * Every conclusion carries how much it rests on. A forecast drawn through two days of history is
 * a guess with a date attached, and saying "full on 3 March" without saying "from two days of
 * data, and the line fits poorly" would be claiming a confidence nobody has.
 */

/* ------------------------------------------------------------------------- */
/* Storage                                                                    */
/* ------------------------------------------------------------------------- */

/** Least history a fill forecast is attempted from. Shorter than this, daily churn is the trend. */
export const MIN_FORECAST_HISTORY_DAYS = 3;
export const MIN_FORECAST_POINTS = 24;

/**
 * A trend smaller than this share of the volume over thirty days is called flat.
 *
 * Without a floor, a disk that gained forty megabytes in a month on a two-terabyte volume would
 * be "growing" and "full in 4,000 years", which is technically true and useless.
 */
export const FLAT_TREND_SHARE_PER_30_DAYS = 0.005;

/** Past this, "days until full" is not a number anyone should plan around. */
export const MAX_FORECAST_DAYS = 3650;

/** Coefficient of determination below which the line is reported as a poor fit. */
export const GOOD_FIT_R2 = 0.6;

export type StorageTrend = 'insufficient-history' | 'not-growing' | 'growing' | 'shrinking';

export interface StorageForecast {
  readonly volume: string;
  readonly label: string | null;
  readonly totalBytes: number | null;
  readonly usedBytes: number | null;
  readonly usedPercent: number | null;
  readonly healthStatus: DiskSample['healthStatus'];
  readonly temperatureCelsius: number | null;
  readonly trend: StorageTrend;
  /** Least-squares slope. Null without a trend to report. */
  readonly growthBytesPerDay: number | null;
  /** Null unless growing, and null past {@link MAX_FORECAST_DAYS}. */
  readonly daysUntilFull: number | null;
  readonly fullAt: string | null;
  /** How far back the history reaches, in days. */
  readonly historyDays: number;
  readonly fit: 'good' | 'poor' | null;
}

export interface UsagePoint {
  readonly at: Date;
  readonly usedPercent: number;
}

/** Ordinary least squares: slope, intercept and r² of y on x. */
export function linearFit(points: readonly { x: number; y: number }[]): {
  slope: number;
  intercept: number;
  r2: number;
} | null {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx === 0) return null;

  const slope = sxy / sxx;
  // A perfectly flat series explains all of its (zero) variance.
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: meanY - slope * meanX, r2 };
}

/**
 * When a volume will be full, if it keeps going the way it has.
 *
 * A straight line through the history. Deliberately that simple: storage fills in steps — a game
 * installed, a backup written, a cache cleared — and a cleverer model fitted to steps is still
 * guessing when the next one lands. What the line answers honestly is "at the rate of the last few
 * weeks", and the fit quality says how well that rate describes them.
 *
 * Bytes are reconstructed from the used percentage and the volume's *current* size, so a volume
 * that was resized inside the window distorts the slope. That is rare enough to note rather than
 * to model.
 */
export function forecastVolume(input: {
  readonly disk: DiskSample;
  readonly history: readonly UsagePoint[];
  readonly now: Date;
}): StorageForecast {
  const { disk, now } = input;
  const total = disk.totalBytes;
  const used = total !== null && disk.freeBytes !== null ? Math.max(0, total - disk.freeBytes) : null;

  const base = {
    volume: disk.volume,
    label: disk.label,
    totalBytes: total,
    usedBytes: used,
    usedPercent: total && used !== null ? (used / total) * 100 : null,
    healthStatus: disk.healthStatus,
    temperatureCelsius: disk.temperatureCelsius,
  };

  const history = input.history
    .filter((point) => point.at.getTime() <= now.getTime() && Number.isFinite(point.usedPercent))
    .sort((left, right) => left.at.getTime() - right.at.getTime());

  const historyDays =
    history.length === 0 ? 0 : (now.getTime() - history[0]!.at.getTime()) / 86_400_000;

  const insufficient: StorageForecast = {
    ...base,
    trend: 'insufficient-history',
    growthBytesPerDay: null,
    daysUntilFull: null,
    fullAt: null,
    historyDays,
    fit: null,
  };

  if (!total || used === null || history.length < MIN_FORECAST_POINTS || historyDays < MIN_FORECAST_HISTORY_DAYS) {
    return insufficient;
  }

  const origin = history[0]!.at.getTime();
  const fit = linearFit(
    history.map((point) => ({
      x: (point.at.getTime() - origin) / 86_400_000,
      y: (point.usedPercent / 100) * total,
    })),
  );

  if (!fit) return insufficient;

  const flatBand = total * FLAT_TREND_SHARE_PER_30_DAYS;
  const quality = fit.r2 >= GOOD_FIT_R2 ? 'good' : 'poor';

  if (Math.abs(fit.slope * 30) < flatBand) {
    return { ...base, trend: 'not-growing', growthBytesPerDay: fit.slope, daysUntilFull: null, fullAt: null, historyDays, fit: null };
  }

  if (fit.slope < 0) {
    return { ...base, trend: 'shrinking', growthBytesPerDay: fit.slope, daysUntilFull: null, fullAt: null, historyDays, fit: quality };
  }

  // Projected from what is used *now*, not from where the line says it should be: the owner has
  // just been shown the current figure, and a forecast that starts somewhere else looks wrong.
  const days = Math.max(0, (total - used) / fit.slope);
  const plannable = days <= MAX_FORECAST_DAYS;

  return {
    ...base,
    trend: 'growing',
    growthBytesPerDay: fit.slope,
    daysUntilFull: plannable ? days : null,
    fullAt: plannable ? new Date(now.getTime() + days * 86_400_000).toISOString() : null,
    historyDays,
    fit: quality,
  };
}

/* ------------------------------------------------------------------------- */
/* GPU                                                                        */
/* ------------------------------------------------------------------------- */

/** Buckets needed before a GPU summary says anything: an hour of five-minute buckets. */
export const MIN_GPU_BUCKETS = 12;

/** A five-minute bucket averaging at least this is counted as heavy load. */
export const HEAVY_LOAD_PERCENT = 80;

export interface GpuBucket {
  readonly metric: 'gpu.usage' | 'gpu.vramUsed' | 'gpu.temperature';
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly p95: number | null;
  readonly sampleCount: number;
}

export interface GpuInsight {
  readonly adapterId: string;
  readonly name: string;
  readonly windowHours: number;
  readonly coverage: 'ok' | 'insufficient-history';
  /** Sample-weighted mean load across the window. */
  readonly averageUsagePercent: number | null;
  /**
   * The highest five-minute 95th percentile in the window — the busiest stretch, not the window's
   * own 95th percentile, which cannot be recovered from bucket summaries.
   */
  readonly busiestFiveMinuteP95Percent: number | null;
  /** Share of five-minute buckets whose average was heavy. */
  readonly heavyLoadShare: number | null;
  readonly peakTemperatureCelsius: number | null;
  readonly peakVramUsedBytes: number | null;
  readonly vramTotalBytes: number | null;
  /** Peak VRAM use over total; null when either is unknown. */
  readonly peakVramShare: number | null;
}

export function summariseGpu(input: {
  readonly adapterId: string;
  readonly name: string;
  readonly vramTotalBytes: number | null;
  readonly windowHours: number;
  readonly buckets: readonly GpuBucket[];
}): GpuInsight {
  const usage = input.buckets.filter((bucket) => bucket.metric === 'gpu.usage' && bucket.sampleCount > 0);
  const vram = input.buckets.filter((bucket) => bucket.metric === 'gpu.vramUsed' && bucket.sampleCount > 0);
  const temperature = input.buckets.filter((bucket) => bucket.metric === 'gpu.temperature' && bucket.sampleCount > 0);

  const maxOf = (values: (number | null)[]) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0 ? null : Math.max(...present);
  };

  const peakVram = maxOf(vram.map((bucket) => bucket.max));

  const base = {
    adapterId: input.adapterId,
    name: input.name,
    windowHours: input.windowHours,
    peakTemperatureCelsius: maxOf(temperature.map((bucket) => bucket.max)),
    peakVramUsedBytes: peakVram,
    vramTotalBytes: input.vramTotalBytes,
    peakVramShare: peakVram !== null && input.vramTotalBytes ? peakVram / input.vramTotalBytes : null,
  };

  if (usage.length < MIN_GPU_BUCKETS) {
    return {
      ...base,
      coverage: 'insufficient-history',
      averageUsagePercent: null,
      busiestFiveMinuteP95Percent: null,
      heavyLoadShare: null,
    };
  }

  let weighted = 0;
  let count = 0;
  let heavy = 0;
  let averaged = 0;
  for (const bucket of usage) {
    if (bucket.avg === null) continue;
    weighted += bucket.avg * bucket.sampleCount;
    count += bucket.sampleCount;
    averaged += 1;
    if (bucket.avg >= HEAVY_LOAD_PERCENT) heavy += 1;
  }

  return {
    ...base,
    coverage: 'ok',
    averageUsagePercent: count > 0 ? weighted / count : null,
    busiestFiveMinuteP95Percent: maxOf(usage.map((bucket) => bucket.p95)),
    heavyLoadShare: averaged > 0 ? heavy / averaged : null,
  };
}

/* ------------------------------------------------------------------------- */
/* Findings                                                                   */
/* ------------------------------------------------------------------------- */

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface Finding {
  readonly severity: FindingSeverity;
  readonly subject: 'storage' | 'gpu';
  /** Volume or adapter id. */
  readonly key: string;
  readonly code:
    | 'storage.failing'
    | 'storage.health-warning'
    | 'storage.full-soon'
    | 'storage.nearly-full'
    | 'storage.hot'
    | 'gpu.vram-pressure'
    | 'gpu.sustained-load'
    | 'gpu.hot';
  readonly title: string;
  readonly detail: string;
}

export const THRESHOLDS = Object.freeze({
  fullSoonCriticalDays: 7,
  fullSoonWarningDays: 30,
  nearlyFullPercent: 90,
  driveHotCelsius: 70,
  vramPressureShare: 0.95,
  sustainedLoadShare: 0.5,
  gpuHotCelsius: 87,
});

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The things worth an owner's attention, most severe first.
 *
 * Fixed templates over numbers. A finding never contains a process name, a file name or anything
 * else the cloud does not hold — which is also why process-level insight lives on the PC, in the
 * live process list, and not here.
 */
export function findingsFor(storage: readonly StorageForecast[], gpus: readonly GpuInsight[]): Finding[] {
  const findings: Finding[] = [];

  for (const volume of storage) {
    const name = volume.label ? `${volume.volume} (${volume.label})` : volume.volume;

    if (volume.healthStatus === 'failing') {
      findings.push({
        severity: 'critical',
        subject: 'storage',
        key: volume.volume,
        code: 'storage.failing',
        title: `The drive behind ${name} reports that it is failing`,
        detail: 'Windows marks the drive unhealthy. Back up what is on it now; a drive that reports this can stop responding without further warning.',
      });
    } else if (volume.healthStatus === 'warning') {
      findings.push({
        severity: 'warning',
        subject: 'storage',
        key: volume.volume,
        code: 'storage.health-warning',
        title: `The drive behind ${name} reports a health warning`,
        detail: 'Windows marks the drive with a warning, usually a SMART predictive-failure flag. Check its SMART attributes from the Diagnostics tab and make sure it is backed up.',
      });
    }

    if (volume.trend === 'growing' && volume.daysUntilFull !== null && volume.daysUntilFull <= THRESHOLDS.fullSoonWarningDays) {
      const critical = volume.daysUntilFull <= THRESHOLDS.fullSoonCriticalDays;
      const days = Math.max(0, Math.floor(volume.daysUntilFull));
      findings.push({
        severity: critical ? 'critical' : 'warning',
        subject: 'storage',
        key: volume.volume,
        code: 'storage.full-soon',
        title: days === 0 ? `${name} is about to fill up` : `${name} will be full in about ${days} day${days === 1 ? '' : 's'}`,
        detail: `At the rate of the last ${Math.floor(volume.historyDays)} days (${gib(volume.growthBytesPerDay ?? 0)} a day)${volume.fit === 'poor' ? ', though usage has moved in steps rather than steadily, so the date is rough' : ''}.`,
      });
    } else if (volume.usedPercent !== null && volume.usedPercent >= THRESHOLDS.nearlyFullPercent) {
      findings.push({
        severity: 'warning',
        subject: 'storage',
        key: volume.volume,
        code: 'storage.nearly-full',
        title: `${name} is ${Math.round(volume.usedPercent)}% full`,
        detail: volume.totalBytes !== null && volume.usedBytes !== null
          ? `${gib(volume.totalBytes - volume.usedBytes)} free.`
          : 'Free space is low.',
      });
    }

    if (volume.temperatureCelsius !== null && volume.temperatureCelsius >= THRESHOLDS.driveHotCelsius) {
      findings.push({
        severity: 'warning',
        subject: 'storage',
        key: volume.volume,
        code: 'storage.hot',
        title: `The drive behind ${name} is running at ${Math.round(volume.temperatureCelsius)} °C`,
        detail: 'Drives slow themselves down to cool off at around this temperature, and sustained heat shortens their life. Check airflow around the drive.',
      });
    }
  }

  for (const gpu of gpus) {
    if (gpu.peakVramShare !== null && gpu.peakVramShare >= THRESHOLDS.vramPressureShare) {
      findings.push({
        severity: 'warning',
        subject: 'gpu',
        key: gpu.adapterId,
        code: 'gpu.vram-pressure',
        title: `${gpu.name} ran out of dedicated video memory`,
        detail: `Peak use reached ${Math.round(gpu.peakVramShare * 100)}% in the last ${gpu.windowHours} hours. Past this Windows moves GPU data into system memory, which shows up as stutter.`,
      });
    }

    if (gpu.heavyLoadShare !== null && gpu.heavyLoadShare >= THRESHOLDS.sustainedLoadShare) {
      findings.push({
        severity: 'info',
        subject: 'gpu',
        key: gpu.adapterId,
        code: 'gpu.sustained-load',
        title: `${gpu.name} has been under heavy load most of the time`,
        detail: `Above ${HEAVY_LOAD_PERCENT}% for ${Math.round(gpu.heavyLoadShare * 100)}% of the last ${gpu.windowHours} hours. Expected while gaming, rendering or mining; worth a look in the process list if nothing like that was running.`,
      });
    }

    if (gpu.peakTemperatureCelsius !== null && gpu.peakTemperatureCelsius >= THRESHOLDS.gpuHotCelsius) {
      findings.push({
        severity: 'warning',
        subject: 'gpu',
        key: gpu.adapterId,
        code: 'gpu.hot',
        title: `${gpu.name} reached ${Math.round(gpu.peakTemperatureCelsius)} °C`,
        detail: 'Close to the point where GPUs reduce their own speed to cool down. Check the fans and case airflow.',
      });
    }
  }

  const order: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };
  // Within a severity, a drive that is failing outranks one that is merely filling: losing the data
  // on it is not a matter of freeing space.
  const rank: Record<Finding['code'], number> = {
    'storage.failing': 0,
    'storage.full-soon': 1,
    'storage.health-warning': 2,
    'gpu.vram-pressure': 3,
    'gpu.hot': 4,
    'storage.hot': 5,
    'storage.nearly-full': 6,
    'gpu.sustained-load': 7,
  };
  return findings.sort(
    (left, right) => order[left.severity] - order[right.severity] || rank[left.code] - rank[right.code],
  );
}

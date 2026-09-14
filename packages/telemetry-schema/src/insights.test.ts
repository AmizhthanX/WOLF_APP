import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingsFor,
  forecastVolume,
  linearFit,
  MIN_GPU_BUCKETS,
  summariseGpu,
  type GpuBucket,
  type StorageForecast,
  type UsagePoint,
} from './insights.js';
import type { DiskSample } from './samples.js';

/**
 * Insights: the conclusions an owner acts on.
 *
 * The failure worth guarding against is not a wrong decimal. It is a confident statement drawn from
 * too little — "full in 12 days" from an afternoon of history — or an alarming one drawn from noise.
 */

const now = new Date('2026-09-14T12:00:00.000Z');
const GiB = 1024 ** 3;

function disk(overrides: Partial<DiskSample> = {}): DiskSample {
  return {
    volume: 'C:',
    label: null,
    totalBytes: 1000 * GiB,
    freeBytes: 400 * GiB,
    readBytesPerSecond: 0,
    writeBytesPerSecond: 0,
    activeTimePercent: 1,
    queueLength: 0,
    temperatureCelsius: null,
    healthStatus: 'healthy',
    ...overrides,
  };
}

/** Hourly points over `days` days, used percentage as a function of days ago. */
function hourly(days: number, usedPercent: (daysAgo: number) => number): UsagePoint[] {
  return Array.from({ length: days * 24 }, (_, index) => {
    const hoursAgo = days * 24 - index;
    return { at: new Date(now.getTime() - hoursAgo * 3_600_000), usedPercent: usedPercent(hoursAgo / 24) };
  });
}

/* ------------------------------------------------------------------------- */
/* The line                                                                   */
/* ------------------------------------------------------------------------- */

test('a least-squares fit recovers a straight line exactly', () => {
  const fit = linearFit([0, 1, 2, 3].map((x) => ({ x, y: 5 + 2 * x })));

  assert.ok(fit);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 5);
  assert.equal(fit.r2, 1);
});

test('a fit needs two distinct x values', () => {
  assert.equal(linearFit([{ x: 1, y: 1 }]), null);
  assert.equal(linearFit([{ x: 1, y: 1 }, { x: 1, y: 2 }]), null);
});

/* ------------------------------------------------------------------------- */
/* Storage                                                                    */
/* ------------------------------------------------------------------------- */

test('a volume growing steadily gets a date', () => {
  // 1% of a terabyte a day for two weeks, 60% used now: 400 GiB left at 10 GiB a day.
  const forecast = forecastVolume({ disk: disk(), history: hourly(14, (daysAgo) => 60 - daysAgo), now });

  assert.equal(forecast.trend, 'growing');
  assert.equal(forecast.fit, 'good');
  assert.ok(Math.abs(forecast.growthBytesPerDay! - 10 * GiB) < 0.01 * GiB);
  assert.ok(Math.abs(forecast.daysUntilFull! - 40) < 0.5);
  assert.ok(forecast.fullAt);
  assert.ok(forecast.historyDays > 13.9);
});

test('an afternoon of history is not a forecast', () => {
  // Steep growth over six hours: a download, most likely. Not a trend.
  const history = hourly(14, (daysAgo) => 60 - daysAgo).slice(-6);
  const forecast = forecastVolume({ disk: disk(), history, now });

  assert.equal(forecast.trend, 'insufficient-history');
  assert.equal(forecast.daysUntilFull, null);
  assert.equal(forecast.growthBytesPerDay, null);
});

test('plenty of points over too short a span is still not a forecast', () => {
  const forecast = forecastVolume({ disk: disk(), history: hourly(2, (daysAgo) => 60 - daysAgo), now });
  assert.equal(forecast.trend, 'insufficient-history');
});

test('a trend too small to matter is flat, not "full in four thousand years"', () => {
  // A tenth of a percent over two weeks on a terabyte.
  const forecast = forecastVolume({ disk: disk(), history: hourly(14, (daysAgo) => 60 - daysAgo * 0.007), now });

  assert.equal(forecast.trend, 'not-growing');
  assert.equal(forecast.daysUntilFull, null);
});

test('a volume being cleaned up is shrinking', () => {
  const forecast = forecastVolume({ disk: disk(), history: hourly(14, (daysAgo) => 60 + daysAgo), now });
  assert.equal(forecast.trend, 'shrinking');
  assert.equal(forecast.fullAt, null);
});

test('growth in steps is reported with a poor fit', () => {
  // Flat for twelve days, then a 20% jump two days ago. Growing on average; not steadily.
  const forecast = forecastVolume({
    disk: disk(),
    history: hourly(14, (daysAgo) => (daysAgo > 2 ? 30 : 50) + Math.sin(daysAgo * 40) * 2),
    now,
  });

  assert.equal(forecast.trend, 'growing');
  assert.equal(forecast.fit, 'poor');
});

test('growth so slow it will not fill for a decade has no date', () => {
  const forecast = forecastVolume({
    disk: disk({ freeBytes: 900 * GiB }),
    history: hourly(14, (daysAgo) => 10 - daysAgo * 0.02),
    now,
  });

  assert.equal(forecast.trend, 'growing');
  assert.equal(forecast.daysUntilFull, null);
});

test('a volume whose size is unknown cannot be forecast', () => {
  const forecast = forecastVolume({ disk: disk({ totalBytes: null }), history: hourly(14, () => 50), now });
  assert.equal(forecast.trend, 'insufficient-history');
  assert.equal(forecast.usedPercent, null);
});

/* ------------------------------------------------------------------------- */
/* GPU                                                                        */
/* ------------------------------------------------------------------------- */

function buckets(count: number, metric: GpuBucket['metric'], value: (index: number) => Partial<GpuBucket>): GpuBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    metric,
    min: null,
    max: null,
    avg: null,
    p95: null,
    sampleCount: 60,
    ...value(index),
  }));
}

test('a GPU summary weights load by samples and names the busiest stretch honestly', () => {
  const insight = summariseGpu({
    adapterId: 'pci-1.0.0',
    name: 'NVIDIA GeForce RTX 3060',
    vramTotalBytes: 12 * GiB,
    windowHours: 24,
    buckets: [
      ...buckets(24, 'gpu.usage', (index) => ({ avg: index < 12 ? 90 : 10, p95: index === 3 ? 99 : 50 })),
      ...buckets(24, 'gpu.vramUsed', (index) => ({ max: index === 5 ? 11.5 * GiB : 4 * GiB })),
      ...buckets(24, 'gpu.temperature', (index) => ({ max: 60 + index })),
    ],
  });

  assert.equal(insight.coverage, 'ok');
  assert.equal(insight.averageUsagePercent, 50);
  assert.equal(insight.busiestFiveMinuteP95Percent, 99);
  assert.equal(insight.heavyLoadShare, 0.5);
  assert.equal(insight.peakTemperatureCelsius, 83);
  assert.ok(Math.abs(insight.peakVramShare! - 11.5 / 12) < 1e-9);
});

test('under an hour of GPU history says nothing about load', () => {
  const insight = summariseGpu({
    adapterId: 'pci-1.0.0',
    name: 'GPU',
    vramTotalBytes: null,
    windowHours: 24,
    buckets: buckets(MIN_GPU_BUCKETS - 1, 'gpu.usage', () => ({ avg: 99, p95: 99 })),
  });

  assert.equal(insight.coverage, 'insufficient-history');
  assert.equal(insight.averageUsagePercent, null);
  assert.equal(insight.heavyLoadShare, null);
  // Unknown total memory means no share, rather than a share of something assumed.
  assert.equal(insight.peakVramShare, null);
});

/* ------------------------------------------------------------------------- */
/* Findings                                                                   */
/* ------------------------------------------------------------------------- */

function forecast(overrides: Partial<StorageForecast>): StorageForecast {
  return {
    volume: 'D:',
    label: 'Games',
    totalBytes: 1000 * GiB,
    usedBytes: 500 * GiB,
    usedPercent: 50,
    healthStatus: 'healthy',
    temperatureCelsius: null,
    trend: 'not-growing',
    growthBytesPerDay: null,
    daysUntilFull: null,
    fullAt: null,
    historyDays: 14,
    fit: null,
    ...overrides,
  };
}

test('a healthy, flat, cool machine has nothing to say', () => {
  assert.deepEqual(findingsFor([forecast({})], []), []);
});

test('a failing drive comes first, above everything else', () => {
  const findings = findingsFor(
    [
      forecast({ volume: 'C:', usedPercent: 95, usedBytes: 950 * GiB }),
      forecast({ volume: 'D:', healthStatus: 'failing' }),
    ],
    [],
  );

  assert.equal(findings[0]?.code, 'storage.failing');
  assert.equal(findings[0]?.severity, 'critical');
  assert.equal(findings[1]?.code, 'storage.nearly-full');
});

test('filling within a week is critical, within a month a warning, and says how sure it is', () => {
  const soon = findingsFor([forecast({ trend: 'growing', daysUntilFull: 4.6, growthBytesPerDay: 20 * GiB, fit: 'poor' })], []);
  assert.equal(soon[0]?.severity, 'critical');
  assert.match(soon[0]!.title, /about 4 days/);
  assert.match(soon[0]!.detail, /rough/);

  const month = findingsFor([forecast({ trend: 'growing', daysUntilFull: 21, growthBytesPerDay: 2 * GiB, fit: 'good' })], []);
  assert.equal(month[0]?.severity, 'warning');
  assert.doesNotMatch(month[0]!.detail, /rough/);

  const later = findingsFor([forecast({ trend: 'growing', daysUntilFull: 200, growthBytesPerDay: 1 * GiB, fit: 'good' })], []);
  assert.deepEqual(later, []);
});

test('a forecast finding replaces the nearly-full one rather than repeating it', () => {
  const findings = findingsFor(
    [forecast({ usedPercent: 96, trend: 'growing', daysUntilFull: 3, growthBytesPerDay: 10 * GiB, fit: 'good' })],
    [],
  );

  assert.deepEqual(findings.map((finding) => finding.code), ['storage.full-soon']);
});

test('GPU findings: memory pressure, heat, and heavy load as information rather than alarm', () => {
  const findings = findingsFor(
    [],
    [
      {
        adapterId: 'pci-1.0.0',
        name: 'RTX 3060',
        windowHours: 24,
        coverage: 'ok',
        averageUsagePercent: 85,
        busiestFiveMinuteP95Percent: 100,
        heavyLoadShare: 0.8,
        peakTemperatureCelsius: 91,
        peakVramUsedBytes: 11.9 * GiB,
        vramTotalBytes: 12 * GiB,
        peakVramShare: 11.9 / 12,
      },
    ],
  );

  assert.deepEqual(
    findings.map((finding) => [finding.code, finding.severity]),
    [
      ['gpu.vram-pressure', 'warning'],
      ['gpu.hot', 'warning'],
      ['gpu.sustained-load', 'info'],
    ],
  );
});

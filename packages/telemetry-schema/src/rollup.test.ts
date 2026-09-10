import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketIsSettled,
  bucketStart,
  mergeAggregates,
  percentile95,
  rollupAggregates,
  rollupSamples,
  ROLLUP_GRACE_SECONDS,
  ROLLUP_SOURCE,
  type Aggregate,
} from './rollup.js';
import type { TelemetrySample } from './samples.js';

/**
 * Turning samples into history.
 *
 * All of this is pure, which is the point: the correctness of a rollup is the whole feature —
 * a chart that is subtly wrong is worse than one that is missing, because nobody checks it —
 * and it can be tested here without a database anywhere near it.
 */

/** A sample with only the fields a test cares about; everything else at a plausible idle. */
function sample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    sampledAt: '2026-09-10T12:00:00.000Z',
    uptimeSeconds: 3600,
    cpu: {
      usagePercent: 10,
      perCorePercent: [],
      frequencyMhz: 2400,
      temperatureCelsius: null,
      queueLength: 0,
      packagePowerWatts: null,
    },
    memory: {
      totalBytes: 16_000_000_000,
      usedBytes: 8_000_000_000,
      availableBytes: 8_000_000_000,
      committedBytes: 9_000_000_000,
      commitLimitBytes: 20_000_000_000,
      cachedBytes: 2_000_000_000,
    },
    gpus: [],
    disks: [],
    networks: [],
    thermal: [],
    battery: null,
    agent: null,
    ...overrides,
  } as TelemetrySample;
}

function at(iso: string, overrides: Partial<TelemetrySample> = {}) {
  return { sampledAt: new Date(iso), sample: sample({ sampledAt: iso, ...overrides }) };
}

function find(rows: ReturnType<typeof rollupSamples>, metric: string, seriesKey: string | null = null) {
  return rows.find((row) => row.metric === metric && row.seriesKey === seriesKey);
}

/* ------------------------------------------------------------------------- */
/* Buckets                                                                    */
/* ------------------------------------------------------------------------- */

test('buckets are aligned to the epoch, not to when the job happened to run', () => {
  // Two runs of the job — or two API instances doing it at once — have to agree on where a
  // bucket begins. A boundary that depended on the first sample seen would make the same data
  // aggregate differently every time it was recomputed.
  assert.equal(
    bucketStart(new Date('2026-09-10T12:07:43.500Z'), '5m').toISOString(),
    '2026-09-10T12:05:00.000Z',
  );
  assert.equal(
    bucketStart(new Date('2026-09-10T12:59:59.999Z'), '1h').toISOString(),
    '2026-09-10T12:00:00.000Z',
  );
  assert.equal(
    bucketStart(new Date('2026-09-10T23:59:59.999Z'), '1d').toISOString(),
    '2026-09-10T00:00:00.000Z',
  );
});

test('a bucket is not settled until it has ended and the stragglers are in', () => {
  const bucket = new Date('2026-09-10T12:00:00.000Z');
  const ends = new Date('2026-09-10T12:05:00.000Z');

  // Samples arrive late: an agent replays its offline buffer, a slow link delivers a batch
  // minutes after it was taken. Rolling up early stores a partial answer — and for coarser
  // buckets that partial answer becomes permanent once the finer rows are gone.
  assert.equal(bucketIsSettled(bucket, '5m', new Date('2026-09-10T12:04:59.000Z')), false);
  assert.equal(bucketIsSettled(bucket, '5m', ends), false, 'the instant it ends is too early');
  assert.equal(
    bucketIsSettled(bucket, '5m', new Date(ends.getTime() + (ROLLUP_GRACE_SECONDS - 1) * 1000)),
    false,
  );
  assert.equal(
    bucketIsSettled(bucket, '5m', new Date(ends.getTime() + ROLLUP_GRACE_SECONDS * 1000)),
    true,
  );
});

test('every resolution is built from one that outlives it', () => {
  // The property the whole design turns on. Raw samples are dropped after a couple of days,
  // so an hourly bucket recomputed from raw after that would come back empty and overwrite a
  // good value with nothing.
  assert.equal(ROLLUP_SOURCE['5m'], 'raw');
  assert.equal(ROLLUP_SOURCE['1h'], '5m');
  assert.equal(ROLLUP_SOURCE['1d'], '1h');
});

/* ------------------------------------------------------------------------- */
/* Reading a sample                                                           */
/* ------------------------------------------------------------------------- */

test('a machine metric is summarised across the samples in its bucket', () => {
  const rows = rollupSamples(
    [
      at('2026-09-10T12:00:00.000Z'),
      at('2026-09-10T12:01:00.000Z'),
      at('2026-09-10T12:02:00.000Z'),
    ].map((entry, index) => ({
      sampledAt: entry.sampledAt,
      sample: { ...entry.sample, cpu: { ...entry.sample.cpu, usagePercent: [10, 50, 90][index]! } },
    })),
    '5m',
  );

  const cpu = find(rows, 'cpu.usage');
  assert.ok(cpu);
  assert.equal(cpu.bucketStart.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(cpu.value.min, 10);
  assert.equal(cpu.value.max, 90);
  assert.equal(cpu.value.avg, 50);
  assert.equal(cpu.value.sampleCount, 3);
});

test('a metric that was not measured is absent, never zero', () => {
  // A CPU with no temperature sensor must not pull the average temperature of a fleet towards
  // freezing. Null is "not measured", which is a different fact from a reading of zero.
  const rows = rollupSamples([at('2026-09-10T12:00:00.000Z')], '5m');

  assert.ok(find(rows, 'cpu.usage'));
  assert.equal(find(rows, 'cpu.temperature'), undefined);
});

test('percentages are derived where the raw numbers are absolute', () => {
  const rows = rollupSamples([at('2026-09-10T12:00:00.000Z')], '5m');

  // 8 GB of 16 GB.
  assert.equal(find(rows, 'memory.usedPercent')?.value.avg, 50);
  assert.equal(find(rows, 'memory.used')?.value.avg, 8_000_000_000);
});

test('disks are stored as used rather than free', () => {
  const rows = rollupSamples(
    [
      at('2026-09-10T12:00:00.000Z', {
        disks: [
          {
            volume: 'C:',
            label: null,
            totalBytes: 1000,
            freeBytes: 150,
            readBytesPerSecond: 0,
            writeBytesPerSecond: 0,
            activeTimePercent: 5,
            queueLength: 0,
            temperatureCelsius: null,
            healthStatus: 'healthy',
          },
        ],
      } as Partial<TelemetrySample>),
    ],
    '5m',
  );

  // "85% full" is the number somebody acts on. "15% free" is the same fact phrased so it has
  // to be converted first, and converted wrongly at three in the morning.
  assert.equal(find(rows, 'disk.usedPercent', 'C:')?.value.avg, 85);
});

test('two GPUs in one machine are two series, not an average of both', () => {
  const gpu = (adapterId: string, usagePercent: number) => ({
    adapterId,
    name: adapterId,
    usagePercent,
    graphicsEnginePercent: null,
    computeEnginePercent: null,
    videoEncodeEnginePercent: null,
    videoDecodeEnginePercent: null,
    vramTotalBytes: null,
    vramUsedBytes: null,
    temperatureCelsius: null,
    coreClockMhz: null,
    memoryClockMhz: null,
    fanPercent: null,
    powerWatts: null,
  });

  const rows = rollupSamples(
    [at('2026-09-10T12:00:00.000Z', { gpus: [gpu('igpu', 5), gpu('dgpu', 95)] } as Partial<TelemetrySample>)],
    '5m',
  );

  // The series key is part of the identity, not a label. A machine with an idle integrated
  // GPU and a pinned discrete one is not a machine at 50%.
  assert.equal(find(rows, 'gpu.usage', 'igpu')?.value.avg, 5);
  assert.equal(find(rows, 'gpu.usage', 'dgpu')?.value.avg, 95);
});

test('loopback and virtual adapters are left out of network totals', () => {
  const adapter = (adapterId: string, kind: 'ethernet' | 'loopback' | 'virtual') => ({
    adapterId,
    name: adapterId,
    kind,
    up: true,
    receiveBytesPerSecond: 1000,
    sendBytesPerSecond: 1000,
    linkSpeedBitsPerSecond: null,
    signalPercent: null,
  });

  const rows = rollupSamples(
    [
      at('2026-09-10T12:00:00.000Z', {
        networks: [adapter('eth', 'ethernet'), adapter('lo', 'loopback'), adapter('vm', 'virtual')],
      } as Partial<TelemetrySample>),
    ],
    '5m',
  );

  // They carry traffic that never left the machine. Counting it makes a fleet look busier
  // than it is, and makes a quiet machine look like it is talking to something.
  assert.ok(find(rows, 'network.receiveRate', 'eth'));
  assert.equal(find(rows, 'network.receiveRate', 'lo'), undefined);
  assert.equal(find(rows, 'network.receiveRate', 'vm'), undefined);
});

test('samples land in the bucket their timestamp falls into', () => {
  const rows = rollupSamples(
    [at('2026-09-10T12:04:59.000Z'), at('2026-09-10T12:05:01.000Z')],
    '5m',
  );

  const cpu = rows.filter((row) => row.metric === 'cpu.usage');
  assert.equal(cpu.length, 2);
  assert.equal(cpu[0]!.bucketStart.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(cpu[1]!.bucketStart.toISOString(), '2026-09-10T12:05:00.000Z');
});

/* ------------------------------------------------------------------------- */
/* Percentiles                                                                */
/* ------------------------------------------------------------------------- */

test('the 95th percentile is a number the machine actually reported', () => {
  // Nearest rank rather than an interpolating variant. An interpolated p95 of 87.3% CPU when
  // no sample said 87.3% is a number that cannot be traced back to anything, which is a poor
  // property for a figure somebody is about to act on.
  assert.equal(percentile95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.equal(percentile95([5]), 5);
  assert.equal(percentile95([]), null);

  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile95(twenty), 19);
  assert.ok(twenty.includes(percentile95(twenty)!));
});

test('the percentile does not care what order the values arrived in', () => {
  assert.equal(percentile95([10, 1, 5, 3, 8]), percentile95([1, 3, 5, 8, 10]));
});

/* ------------------------------------------------------------------------- */
/* Merging                                                                    */
/* ------------------------------------------------------------------------- */

const part = (min: number, max: number, avg: number, p95: number, sampleCount: number): Aggregate => ({
  min,
  max,
  avg,
  p95,
  sampleCount,
});

test('minimum, maximum and mean survive a merge exactly', () => {
  const merged = mergeAggregates([part(10, 50, 30, 45, 10), part(5, 90, 60, 85, 10)]);

  assert.equal(merged.min, 5);
  assert.equal(merged.max, 90);
  assert.equal(merged.avg, 45);
  assert.equal(merged.sampleCount, 20);
});

test('the mean is weighted by how many samples each part actually had', () => {
  // An unweighted mean of means would let a bucket with three samples count as much as one
  // with three hundred — which is exactly what happens when an agent is restarted mid-hour.
  const merged = mergeAggregates([part(0, 0, 0, 0, 3), part(100, 100, 100, 100, 297)]);

  assert.equal(merged.sampleCount, 300);
  assert.equal(merged.avg, 99);
});

test('the merged p95 is the worst part, and is honest about being that', () => {
  const merged = mergeAggregates([part(0, 100, 20, 40, 10), part(0, 100, 20, 80, 10)]);

  // A percentile is not recoverable from summaries of its parts — reconstructing it would
  // need every original value, which is the thing being thrown away. What is stored is the
  // largest contributing p95: the worst five-minute spike in the hour. It is not the hour's
  // true 95th percentile, and the module says so rather than implying otherwise.
  assert.equal(merged.p95, 80);
});

test('a bucket nothing was measured in merges to nothing rather than to zero', () => {
  const empty: Aggregate = { min: null, max: null, avg: null, p95: null, sampleCount: 0 };

  assert.deepEqual(mergeAggregates([empty, empty]), empty);
  assert.deepEqual(mergeAggregates([]), empty);

  // And an empty part alongside a real one contributes nothing rather than dragging it down.
  const merged = mergeAggregates([empty, part(50, 50, 50, 50, 10)]);
  assert.equal(merged.avg, 50);
  assert.equal(merged.sampleCount, 10);
});

/* ------------------------------------------------------------------------- */
/* The cascade                                                                */
/* ------------------------------------------------------------------------- */

test('twelve five-minute buckets become one hour', () => {
  const fiveMinute = Array.from({ length: 12 }, (_, index) => ({
    bucketStart: new Date(Date.UTC(2026, 8, 10, 12, index * 5)),
    metric: 'cpu.usage' as const,
    seriesKey: null,
    value: part(index * 5, index * 5 + 10, index * 5 + 5, index * 5 + 9, 60),
  }));

  const hourly = rollupAggregates(fiveMinute, '1h');

  assert.equal(hourly.length, 1);
  assert.equal(hourly[0]!.bucketStart.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(hourly[0]!.value.min, 0);
  assert.equal(hourly[0]!.value.max, 65);
  assert.equal(hourly[0]!.value.sampleCount, 720);
});

test('a rollup of a rollup keeps the extremes the raw samples had', () => {
  const raw = Array.from({ length: 60 }, (_, index) => {
    const minute = index;
    return {
      sampledAt: new Date(Date.UTC(2026, 8, 10, 12, minute)),
      sample: sample({
        sampledAt: new Date(Date.UTC(2026, 8, 10, 12, minute)).toISOString(),
        cpu: {
          usagePercent: minute === 37 ? 100 : 5,
          perCorePercent: [],
          frequencyMhz: 2400,
          temperatureCelsius: null,
          queueLength: 0,
          packagePowerWatts: null,
        },
      } as Partial<TelemetrySample>),
    };
  });

  const hourly = rollupAggregates(rollupSamples(raw, '5m'), '1h');
  const cpu = hourly.find((row) => row.metric === 'cpu.usage')!;

  // The spike is the whole reason anybody looks at an hour of history. Losing it in the
  // cascade would make the chart smooth and useless.
  assert.equal(cpu.value.max, 100);
  assert.equal(cpu.value.min, 5);
  assert.equal(cpu.value.sampleCount, 60);
});

test('series stay separate all the way up the cascade', () => {
  const rows = [
    { bucketStart: new Date('2026-09-10T12:00:00.000Z'), metric: 'disk.usedPercent' as const, seriesKey: 'C:', value: part(80, 80, 80, 80, 60) },
    { bucketStart: new Date('2026-09-10T12:05:00.000Z'), metric: 'disk.usedPercent' as const, seriesKey: 'C:', value: part(81, 81, 81, 81, 60) },
    { bucketStart: new Date('2026-09-10T12:00:00.000Z'), metric: 'disk.usedPercent' as const, seriesKey: 'D:', value: part(10, 10, 10, 10, 60) },
  ];

  const hourly = rollupAggregates(rows, '1h');

  assert.equal(hourly.length, 2);
  assert.equal(hourly.find((row) => row.seriesKey === 'C:')?.value.avg, 80.5);
  assert.equal(hourly.find((row) => row.seriesKey === 'D:')?.value.avg, 10);
});

test('rolling the same data up twice produces the same answer', () => {
  const raw = [at('2026-09-10T12:00:00.000Z'), at('2026-09-10T12:01:00.000Z')];

  // Idempotence is what makes the job safe to run again after a crash, and safe to run on two
  // API instances at once: the second write says exactly what the first one did.
  assert.deepEqual(rollupSamples(raw, '5m'), rollupSamples(raw, '5m'));
  assert.deepEqual(
    rollupAggregates(rollupSamples(raw, '5m'), '1h'),
    rollupAggregates(rollupSamples(raw, '5m'), '1h'),
  );
});

test('rolling up nothing produces nothing rather than an empty bucket', () => {
  // A machine that was switched off for an hour has no hour, which is different from an hour
  // in which it reported zero. Writing a row of nulls would put a flat line on a chart where
  // there should be a gap.
  assert.deepEqual(rollupSamples([], '5m'), []);
  assert.deepEqual(rollupAggregates([], '1h'), []);
});

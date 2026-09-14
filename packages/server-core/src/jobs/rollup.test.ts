import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { newId } from '@wolf/shared-types';
import { DEFAULT_RETENTION_POLICY, type TelemetrySample } from '@wolf/telemetry-schema';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.js';
import { RollupJob } from './rollup.js';
import type { ServerContext } from '../context.js';

/**
 * The rollup job, against a real Postgres engine.
 *
 * The arithmetic is tested where it lives — pure, in `@wolf/telemetry-schema`. What is left
 * here is everything that needs a clock and a database, and it is the half where the
 * interesting failures are: rolling up a bucket that is still filling, losing history because
 * the cascade read from something that had already been deleted, or writing a new row every
 * minute instead of replacing the one before it.
 */

let db: TestDatabase;
let repos: Repositories;
let userId: string;
let pcId: string;
let now: Date;

/** A context whose clock the tests own, so "settled" is a decision rather than a wait. */
function context(): ServerContext {
  return {
    config: {} as ServerContext['config'],
    db,
    repos,
    logger: pino({ level: 'silent' }),
    now: () => now,
  } as ServerContext;
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);
  repos = createRepositories(db);

  const owner = await repos.users.createOwner({
    id: newId(),
    email: 'rollup@example.com',
    passwordHash: 'scrypt$4096$8$1$c2FsdA$aGFzaA',
    displayName: 'Owner',
  });
  userId = owner.id;
});

after(async () => {
  await db.end();
});

beforeEach(async () => {
  const pc = await repos.pcs.create({
    id: newId(),
    userId,
    name: `pc-${newId()}`,
    hostname: null,
    publicKey: 'a'.repeat(64),
    agentVersion: null,
  });
  pcId = pc.id;
  now = new Date('2026-09-10T13:00:00.000Z');

  // Retention in one test drops the partitions the next test's samples need. Recreated here
  // rather than ordering the tests around each other.
  await repos.telemetry.ensurePartitions(3);

  // The partition function works from the wall clock and these tests from a fixed one. Without
  // the days they write to created explicitly, the suite passed on the day it was written and
  // failed four days later with "no partition found for row".
  for (let day = 8; day <= 14; day += 1) {
    const start = `2026-09-${String(day).padStart(2, '0')}`;
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await db.query(
      `CREATE TABLE IF NOT EXISTS telemetry_samples_${start.replaceAll('-', '')}
         PARTITION OF telemetry_samples FOR VALUES FROM ('${start}') TO ('${end}')`,
    );
  }
});

/** A sample at a moment, with one CPU reading and one disk. */
function sample(iso: string, cpuPercent: number, diskUsedPercent = 50): TelemetrySample {
  return {
    sampledAt: iso,
    uptimeSeconds: 3600,
    cpu: {
      usagePercent: cpuPercent,
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
    disks: [
      {
        volume: 'C:',
        label: null,
        totalBytes: 1000,
        freeBytes: 1000 - diskUsedPercent * 10,
        readBytesPerSecond: 0,
        writeBytesPerSecond: 0,
        activeTimePercent: 1,
        queueLength: 0,
        temperatureCelsius: null,
        healthStatus: 'healthy',
      },
    ],
    networks: [],
    thermal: [],
    battery: null,
    agent: null,
  } as TelemetrySample;
}

/** Samples one minute apart, starting at `from`. */
async function seed(from: string, minutes: number, cpu: (minute: number) => number): Promise<void> {
  const start = new Date(from);
  const samples: TelemetrySample[] = [];

  for (let minute = 0; minute < minutes; minute += 1) {
    const at = new Date(start.getTime() + minute * 60_000).toISOString();
    samples.push(sample(at, cpu(minute)));
  }

  await repos.telemetry.insertBatch(pcId, samples);
}

async function aggregates(resolution: '5m' | '1h' | '1d', metric = 'cpu.usage') {
  return repos.telemetry.listAggregates({
    pcId,
    resolution,
    metrics: [metric],
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2027-01-01T00:00:00.000Z'),
  });
}

/* ------------------------------------------------------------------------- */

test('samples become five-minute buckets', async () => {
  await seed('2026-09-10T12:00:00.000Z', 30, (minute) => minute);

  const outcome = await new RollupJob(context()).runOnce();

  assert.ok(outcome);
  assert.equal(outcome.pcsExamined, 1);

  const rows = await aggregates('5m');
  assert.equal(rows.length, 6, 'thirty minutes of samples is six five-minute buckets');

  // The first bucket holds minutes 0–4, so 0 through 4.
  assert.equal(rows[0]!.min, 0);
  assert.equal(rows[0]!.max, 4);
  assert.equal(rows[0]!.avg, 2);
  assert.equal(rows[0]!.sampleCount, 5);
});

test('a bucket that is still filling is left alone', async () => {
  // Samples up to 12:58, and the clock says 13:00. The 12:55 bucket has not ended, and the
  // one before it ended a hundred and twenty seconds ago — exactly the grace period.
  await seed('2026-09-10T12:40:00.000Z', 19, () => 50);
  now = new Date('2026-09-10T13:00:00.000Z');

  await new RollupJob(context()).runOnce();

  const rows = await aggregates('5m');
  const starts = rows.map((row) => row.bucketStart.toISOString());

  // Rolling up an unfinished bucket stores a partial answer — and for the coarser
  // resolutions that partial answer becomes permanent once the rows it came from are gone.
  assert.ok(starts.includes('2026-09-10T12:50:00.000Z'));
  assert.equal(starts.includes('2026-09-10T12:55:00.000Z'), false, 'the current bucket was rolled up');
});

test('five-minute buckets cascade into hours and days', async () => {
  await seed('2026-09-10T00:00:00.000Z', 24 * 60, (minute) => (minute === 137 ? 100 : 5));
  now = new Date('2026-09-11T02:00:00.000Z');

  // More than one pass, because each run is bounded: a machine that was offline for a month
  // must not become a query that never finishes.
  const job = new RollupJob(context());
  for (let pass = 0; pass < 8; pass += 1) await job.runOnce();

  const hourly = await aggregates('1h');
  const daily = await aggregates('1d');

  assert.equal(hourly.length, 24);
  assert.equal(daily.length, 1);

  // The spike is the whole reason anybody looks at a day of history. Losing it in the
  // cascade would make the chart smooth and useless.
  assert.equal(daily[0]!.max, 100);
  assert.equal(daily[0]!.min, 5);
  assert.equal(daily[0]!.sampleCount, 1440);
});

test('running the job again writes the same rows rather than new ones', async () => {
  await seed('2026-09-10T12:00:00.000Z', 30, (minute) => minute);

  const job = new RollupJob(context());
  await job.runOnce();

  const first = await aggregates('5m');

  // Every write is an upsert of a value computed only from its inputs, which is what makes
  // the job safe to run after a crash and safe to run on two API instances at once.
  await job.runOnce();
  await job.runOnce();

  const second = await aggregates('5m');

  assert.equal(second.length, first.length);
  assert.deepEqual(
    second.map((row) => [row.bucketStart.toISOString(), row.min, row.max, row.avg, row.sampleCount]),
    first.map((row) => [row.bucketStart.toISOString(), row.min, row.max, row.avg, row.sampleCount]),
  );
});

test('a second pass continues where the first stopped', async () => {
  await seed('2026-09-10T00:00:00.000Z', 12 * 60, () => 40);
  now = new Date('2026-09-10T13:00:00.000Z');

  // Two buckets a pass, so catching up twelve hours takes many — which is the point: the
  // work per run is bounded, and the next run picks up from what was written.
  const job = new RollupJob(context(), { maxBucketsPerRun: 2 });

  await job.runOnce();
  const afterFirst = (await aggregates('5m')).length;

  await job.runOnce();
  const afterSecond = (await aggregates('5m')).length;

  assert.equal(afterFirst, 2);
  assert.equal(afterSecond, 4);

  // And no bucket is done twice: the watermark is derived from what is already written.
  const starts = (await aggregates('5m')).map((row) => row.bucketStart.toISOString());
  assert.equal(new Set(starts).size, starts.length);
});

test('per-device series are kept apart in storage as well as in memory', async () => {
  await seed('2026-09-10T12:00:00.000Z', 10, () => 20);
  await new RollupJob(context()).runOnce();

  const disk = await aggregates('5m', 'disk.usedPercent');

  assert.ok(disk.length > 0);
  assert.equal(disk[0]!.seriesKey, 'C:');

  // Whole-machine metrics are stored under a fixed empty key rather than null, because the
  // unique index treats two nulls as distinct — without it every rollup would insert a new
  // row instead of replacing the one before it. This is the test that would catch that.
  const cpu = await aggregates('5m');
  assert.equal(cpu[0]!.seriesKey, '');

  const job = new RollupJob(context());
  await job.runOnce();
  await job.runOnce();

  assert.equal((await aggregates('5m')).length, cpu.length, 'a rollup duplicated its own rows');
});

test('hourly buckets survive the raw samples they came from', async () => {
  await seed('2026-09-10T10:00:00.000Z', 120, () => 60);
  now = new Date('2026-09-10T13:00:00.000Z');

  const job = new RollupJob(context());
  for (let pass = 0; pass < 6; pass += 1) await job.runOnce();

  const before = await aggregates('1h');
  assert.ok(before.length >= 2);

  // Now let the raw window pass. This is the case the whole cascade design exists for: an
  // hourly bucket recomputed from raw after the samples are gone would come back empty and
  // overwrite a good value with nothing.
  now = new Date('2026-09-20T00:00:00.000Z');
  for (let pass = 0; pass < 6; pass += 1) await job.runOnce();

  const after = await aggregates('1h');

  assert.deepEqual(
    after.map((row) => [row.bucketStart.toISOString(), row.avg]),
    before.map((row) => [row.bucketStart.toISOString(), row.avg]),
  );
});

test('aggregates past their window are deleted', async () => {
  await seed('2026-09-10T12:00:00.000Z', 30, () => 30);
  await new RollupJob(context()).runOnce();

  assert.ok((await aggregates('5m')).length > 0);

  // Five-minute buckets are kept for a month by default. A year later there is nothing to
  // keep them for: the hourly and daily rows are what answers a question that old.
  now = new Date('2027-09-10T00:00:00.000Z');
  const outcome = await new RollupJob(context()).runOnce();

  assert.ok(outcome);
  assert.ok(outcome.aggregatesDropped > 0);
  assert.equal((await aggregates('5m')).length, 0);
});

test('a retention policy shorter than the default is honoured', async () => {
  await seed('2026-09-10T12:00:00.000Z', 30, () => 30);
  await new RollupJob(context()).runOnce();

  now = new Date('2026-09-13T00:00:00.000Z');

  await new RollupJob(context(), {
    retention: { ...DEFAULT_RETENTION_POLICY, fiveMinuteDays: 1 },
  }).runOnce();

  // Retention is a promise the product makes about somebody's data. Enforced in code that
  // can be read rather than by a cron entry nobody can see from here.
  assert.equal((await aggregates('5m')).length, 0);
});

test('a PC with no samples is not examined at all', async () => {
  // Driven off the data rather than off a list of PCs, so a machine that has been offline for
  // a month costs nothing until it says something.
  const outcome = await new RollupJob(context()).runOnce();

  assert.ok(outcome);
  assert.equal(outcome.pcsExamined, 0);
  assert.deepEqual(outcome.bucketsWritten, { '5m': 0, '1h': 0, '1d': 0 });
});

test('two passes cannot overlap', async () => {
  await seed('2026-09-10T12:00:00.000Z', 30, () => 30);

  const job = new RollupJob(context());
  const [first, second] = await Promise.all([job.runOnce(), job.runOnce()]);

  // One of them is skipped rather than queued. Overlapping would be correct — every write is
  // an upsert — and would double the load for nothing.
  assert.ok(first === null || second === null);
  assert.ok(first !== null || second !== null);
});

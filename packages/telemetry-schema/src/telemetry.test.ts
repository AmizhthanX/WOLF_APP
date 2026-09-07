import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telemetrySample, telemetryBatch } from './samples.js';
import {
  DEFAULT_RETENTION_POLICY,
  RESOLUTION_SECONDS,
  resolutionForWindow,
  retentionPolicy,
} from './aggregates.js';

const baseSample = {
  sampledAt: '2026-09-06T12:00:00.000Z',
  uptimeSeconds: 3600,
  cpu: {
    usagePercent: 42,
    perCorePercent: [40, 44],
    frequencyMhz: null,
    temperatureCelsius: null,
    queueLength: 0,
    packagePowerWatts: null,
  },
  memory: {
    totalBytes: 34_359_738_368,
    usedBytes: 8_589_934_592,
    availableBytes: 25_769_803_776,
    committedBytes: null,
    commitLimitBytes: null,
    cachedBytes: null,
  },
  battery: null,
  agent: null,
};

test('a sample with unreadable counters is valid', () => {
  // A machine with no thermal sensor, no battery, and no GPU telemetry is normal, and the
  // schema has to accept it rather than forcing the agent to invent numbers.
  const parsed = telemetrySample.parse(baseSample);
  assert.equal(parsed.cpu.temperatureCelsius, null);
  assert.equal(parsed.battery, null);
  assert.deepEqual(parsed.gpus, []);
  assert.deepEqual(parsed.disks, []);
});

test('null is preserved rather than coerced to zero', () => {
  const parsed = telemetrySample.parse({
    ...baseSample,
    memory: { ...baseSample.memory, totalBytes: null, usedBytes: null, availableBytes: null },
  });

  assert.equal(parsed.memory.totalBytes, null);
  assert.notEqual(parsed.memory.totalBytes, 0);
});

test('out-of-range readings are rejected', () => {
  assert.equal(
    telemetrySample.safeParse({
      ...baseSample,
      cpu: { ...baseSample.cpu, usagePercent: 140 },
    }).success,
    false,
  );

  assert.equal(
    telemetrySample.safeParse({
      ...baseSample,
      memory: { ...baseSample.memory, usedBytes: -1 },
    }).success,
    false,
  );
});

test('a batch must carry at least one sample and is bounded', () => {
  assert.equal(telemetryBatch.safeParse({ samples: [] }).success, false);

  const accepted = telemetryBatch.parse({ samples: [baseSample] });
  assert.equal(accepted.backfill, false, 'a live batch is not a backfill by default');

  const tooMany = telemetryBatch.safeParse({
    samples: Array.from({ length: 601 }, () => baseSample),
  });
  assert.equal(tooMany.success, false);
});

test('resolution is chosen from the window being asked about', () => {
  // A short recent window can be answered from raw samples.
  assert.equal(resolutionForWindow(1800), 'raw');
  // Anything longer moves to the tier that actually retains that span.
  assert.equal(resolutionForWindow(86_400), '5m');
  assert.equal(resolutionForWindow(86_400 * 60), '1h');
  assert.equal(resolutionForWindow(86_400 * 300), '1d');
});

test('retention tiers grow coarser as they grow longer', () => {
  const policy = DEFAULT_RETENTION_POLICY;
  assert.ok(policy.rawDays < policy.fiveMinuteDays);
  assert.ok(policy.fiveMinuteDays < policy.hourlyDays);
  assert.ok(policy.hourlyDays < policy.dailyDays);
  // Audit retention is independent of telemetry rollup and never shorter than a month.
  assert.ok(policy.auditDays >= 30);
});

test('retention values outside the allowed bounds are rejected', () => {
  assert.equal(retentionPolicy.safeParse({ rawDays: 0 }).success, false);
  assert.equal(retentionPolicy.safeParse({ auditDays: 7 }).success, false);
  assert.equal(retentionPolicy.safeParse({ rawDays: 2, auditDays: 365 }).success, true);
});

test('resolution durations are ordered and consistent', () => {
  assert.ok(RESOLUTION_SECONDS.raw < RESOLUTION_SECONDS['5m']);
  assert.ok(RESOLUTION_SECONDS['5m'] < RESOLUTION_SECONDS['1h']);
  assert.ok(RESOLUTION_SECONDS['1h'] < RESOLUTION_SECONDS['1d']);
  assert.equal(RESOLUTION_SECONDS['1d'], 86_400);
});

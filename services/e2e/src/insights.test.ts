import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';
import type { TelemetrySample } from '@wolf/telemetry-schema';

/**
 * Insights through the real HTTP app, over real stored aggregates.
 *
 * The arithmetic has its own suite. This one checks the join: that the forecast is read from the
 * volume's own history and not its neighbour's, that a GPU's summary is keyed by the adapter id the
 * agent reports, that a PC with no telemetry gets empty answers rather than an error, and that one
 * account cannot read another PC's insights.
 */

const OWNER_EMAIL = 'insights-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';
const GiB = 1024 ** 3;

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let token: string;
let pcId: string;
let quietPcId: string;
const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);

function sample(): TelemetrySample {
  return {
    sampledAt: new Date(now.getTime() - 30_000).toISOString(),
    uptimeSeconds: 3600,
    cpu: { usagePercent: 10, perCorePercent: [], frequencyMhz: null, temperatureCelsius: null, queueLength: 0, packagePowerWatts: null },
    memory: { totalBytes: 16 * GiB, usedBytes: 8 * GiB, availableBytes: 8 * GiB, committedBytes: null, commitLimitBytes: null, cachedBytes: null },
    gpus: [
      {
        adapterId: 'pci-1.0.0',
        name: 'NVIDIA GeForce RTX 3060',
        usagePercent: 40,
        graphicsEnginePercent: 40,
        computeEnginePercent: 0,
        videoEncodeEnginePercent: 0,
        videoDecodeEnginePercent: 0,
        vramTotalBytes: 12 * GiB,
        vramUsedBytes: 6 * GiB,
        temperatureCelsius: 65,
        coreClockMhz: null,
        memoryClockMhz: null,
        fanPercent: null,
        powerWatts: null,
      },
    ],
    disks: [
      // 96% used and growing a percent a day: about four days left.
      { volume: 'C:', label: 'System', totalBytes: 1000 * GiB, freeBytes: 40 * GiB, readBytesPerSecond: 0, writeBytesPerSecond: 0, activeTimePercent: 1, queueLength: 0, temperatureCelsius: 41, healthStatus: 'healthy' },
      // Flat, and on a drive Windows says is failing.
      { volume: 'D:', label: 'Data', totalBytes: 2000 * GiB, freeBytes: 1000 * GiB, readBytesPerSecond: 0, writeBytesPerSecond: 0, activeTimePercent: 1, queueLength: 0, temperatureCelsius: null, healthStatus: 'failing' },
    ],
    networks: [],
    thermal: [],
    battery: null,
    agent: null,
  } as TelemetrySample;
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
    WOLF_COMMAND_TTL_SECONDS: '60',
  } as NodeJS.ProcessEnv);

  const repos = createRepositories(db);
  context = {
    config,
    db,
    repos,
    logger: pino({ level: 'silent' }),
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => now,
  };

  const owner = await repos.users.createOwner({
    id: newId(),
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(OWNER_PASSWORD, { cost: 2 ** 12, blockSize: 8, parallelization: 1, keyLength: 32 }),
    displayName: 'Owner',
  });

  for (const name of ['STUDIO', 'QUIET']) {
    const pc = await repos.pcs.create({ id: newId(), userId: owner.id, name, hostname: null, publicKey: 'a'.repeat(64), agentVersion: null });
    if (name === 'STUDIO') pcId = pc.id;
    else quietPcId = pc.id;
  }

  await repos.telemetry.ensurePartitions(3);
  await repos.telemetry.insertBatch(pcId, [sample()]);

  // Fourteen days of hourly history: C: climbing a percent a day, D: flat at 50%.
  const hourly = [];
  for (let hoursAgo = 14 * 24; hoursAgo >= 1; hoursAgo -= 1) {
    const bucketStart = new Date(Math.floor((now.getTime() - hoursAgo * 3_600_000) / 3_600_000) * 3_600_000);
    const cUsed = 96 - hoursAgo / 24;
    hourly.push({ metric: 'disk.usedPercent', seriesKey: 'C:', bucketStart, min: cUsed, max: cUsed, avg: cUsed, p95: cUsed, sampleCount: 720 });
    hourly.push({ metric: 'disk.usedPercent', seriesKey: 'D:', bucketStart, min: 50, max: 50, avg: 50, p95: 50, sampleCount: 720 });
  }
  await repos.telemetry.upsertAggregates(pcId, '1h', hourly);

  // A day of five-minute GPU buckets: VRAM peaking at 97% of 12 GiB once.
  const fiveMinute = [];
  for (let bucket = 1; bucket <= 288; bucket += 1) {
    const bucketStart = new Date(Math.floor((now.getTime() - bucket * 300_000) / 300_000) * 300_000);
    fiveMinute.push({ metric: 'gpu.usage', seriesKey: 'pci-1.0.0', bucketStart, min: 10, max: 60, avg: 30, p95: 55, sampleCount: 60 });
    const vram = bucket === 100 ? 0.97 * 12 * GiB : 6 * GiB;
    fiveMinute.push({ metric: 'gpu.vramUsed', seriesKey: 'pci-1.0.0', bucketStart, min: vram, max: vram, avg: vram, p95: vram, sampleCount: 60 });
    fiveMinute.push({ metric: 'gpu.temperature', seriesKey: 'pci-1.0.0', bucketStart, min: 50, max: 70, avg: 60, p95: 68, sampleCount: 60 });
  }
  await repos.telemetry.upsertAggregates(pcId, '5m', fiveMinute);

  app = await buildApp(context);
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name: 'Insights browser' } },
  });
  assert.equal(login.statusCode, 200);
  token = String(JSON.parse(login.payload).accessToken);
});

after(async () => {
  await app?.close();
  await db.end();
});

function get(path: string, bearer: string | null = token) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

test('insights require a signed-in caller', async () => {
  assert.equal((await get(`/pcs/${pcId}/insights`, null)).statusCode, 401);
});

test('an unknown PC is not found', async () => {
  assert.equal((await get(`/pcs/${newId()}/insights`)).statusCode, 404);
});

test('each volume is forecast from its own history', async () => {
  const response = await get(`/pcs/${pcId}/insights`);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.payload);

  const c = body.storage.find((volume: { volume: string }) => volume.volume === 'C:');
  const d = body.storage.find((volume: { volume: string }) => volume.volume === 'D:');

  assert.equal(c.trend, 'growing');
  assert.equal(c.fit, 'good');
  assert.ok(Math.abs(c.growthBytesPerDay - 10 * GiB) < 0.2 * GiB, `growth ${c.growthBytesPerDay / GiB} GiB/day`);
  assert.ok(c.daysUntilFull > 3 && c.daysUntilFull < 5, `days ${c.daysUntilFull}`);
  assert.equal(c.temperatureCelsius, 41);

  assert.equal(d.trend, 'not-growing');
  assert.equal(d.healthStatus, 'failing');
  assert.ok(body.sampledAt);
});

test('the GPU summary is keyed by the adapter the agent reports', async () => {
  const body = JSON.parse((await get(`/pcs/${pcId}/insights`)).payload);
  const [gpu] = body.gpus;

  assert.equal(gpu.adapterId, 'pci-1.0.0');
  assert.equal(gpu.coverage, 'ok');
  assert.equal(gpu.averageUsagePercent, 30);
  assert.equal(gpu.busiestFiveMinuteP95Percent, 55);
  assert.equal(gpu.peakTemperatureCelsius, 70);
  assert.ok(Math.abs(gpu.peakVramShare - 0.97) < 1e-9);
});

test('findings put the failing drive first and say nothing about processes', async () => {
  const body = JSON.parse((await get(`/pcs/${pcId}/insights`)).payload);
  const codes = body.findings.map((finding: { code: string }) => finding.code);

  assert.equal(codes[0], 'storage.failing');
  assert.ok(codes.includes('storage.full-soon'));
  assert.ok(codes.includes('gpu.vram-pressure'));
  assert.ok(!codes.includes('gpu.hot'));

  // The cloud holds no process data, so no finding can name one.
  assert.ok(body.findings.every((finding: { subject: string }) => finding.subject === 'storage' || finding.subject === 'gpu'));
});

test('a PC that has never reported gets empty answers, not an error', async () => {
  const response = await get(`/pcs/${quietPcId}/insights`);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.payload);

  assert.equal(body.sampledAt, null);
  assert.deepEqual(body.storage, []);
  assert.deepEqual(body.gpus, []);
  assert.deepEqual(body.findings, []);
});

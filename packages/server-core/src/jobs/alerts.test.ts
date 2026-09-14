import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { newId } from '@wolf/shared-types';
import type { TelemetrySample } from '@wolf/telemetry-schema';
import { migrate } from '../db/migrate.js';
import { withTransaction } from '../db/pool.js';
import { createRepositories, type Repositories, type RuleWrite } from '../db/repositories/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.js';
import { AlertJob } from './alerts.js';
import { RollupJob } from './rollup.js';
import type { ServerContext } from '../context.js';

/**
 * The alert evaluator, against a real Postgres engine.
 *
 * The judgement is tested where it lives, pure, in `rules/engine.test.ts`. What is left is the
 * part a unit test cannot see: that the owner is told once and not every minute, that a machine
 * going quiet does not resolve its own alert, and that two API instances evaluating at the same
 * moment still produce one notification.
 */

let db: TestDatabase;
let repos: Repositories;
let userId: string;
let pcId: string;
let pcName: string;
let now: Date;

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
    email: 'alerts@example.com',
    passwordHash: 'scrypt$4096$8$1$c2FsdA$aGFzaA',
    displayName: 'Owner',
  });
  userId = owner.id;
});

after(async () => {
  await db.end();
});

beforeEach(async () => {
  // Every test gets its own PC and no rules from the one before. Earlier PCs are revoked rather
  // than deleted: their telemetry has to stay coherent for the rollup that one test runs.
  await db.query('DELETE FROM alert_rules');
  await db.query('DELETE FROM notifications');
  await db.query(`UPDATE pcs SET registration_state = 'revoked'`);

  pcName = `pc-${newId().slice(-6)}`;
  const pc = await repos.pcs.create({
    id: newId(),
    userId,
    name: pcName,
    hostname: null,
    publicKey: 'a'.repeat(64),
    agentVersion: null,
  });
  pcId = pc.id;
  await db.query(`UPDATE pcs SET registration_state = 'active', status = 'online', last_seen_at = now() WHERE id = $1`, [pcId]);

  // Partitions are created around the wall clock, so the tests' clock stays near it.
  now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  await repos.telemetry.ensurePartitions(3);
});

function sample(at: Date, cpuPercent: number): TelemetrySample {
  return {
    sampledAt: at.toISOString(),
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
    disks: [],
    networks: [],
    thermal: [],
    battery: null,
    agent: null,
  } as TelemetrySample;
}

/** One CPU sample a minute for the `minutes` minutes ending at the test clock. */
async function seedCpu(minutes: number, cpu: (minutesAgo: number) => number): Promise<void> {
  const samples: TelemetrySample[] = [];
  for (let minutesAgo = minutes; minutesAgo >= 0; minutesAgo -= 1) {
    samples.push(sample(new Date(now.getTime() - minutesAgo * 60_000), cpu(minutesAgo)));
  }
  await repos.telemetry.insertBatch(pcId, samples);
}

function cpuRule(overrides: Partial<RuleWrite> = {}): RuleWrite {
  return {
    pcId,
    name: 'CPU pegged',
    condition: 'metric-above',
    metric: 'cpu.usage',
    seriesKey: null,
    threshold: 90,
    forMinutes: 10,
    severity: 'warning',
    cooldownMinutes: 60,
    enabled: true,
    ...overrides,
  };
}

async function notifications() {
  return repos.alerts.listNotifications(userId, { unreadOnly: false, limit: 200 });
}

function advance(minutes: number): void {
  now = new Date(now.getTime() + minutes * 60_000);
}

test('a sustained breach fires once, and stays quiet while it lasts', async () => {
  const rule = await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);

  const job = new AlertJob(context());
  const first = await job.runOnce();
  assert.equal(first?.fired, 1);
  assert.equal(first?.notificationsWritten, 1);

  // Still breaching a minute later. Told once is told.
  advance(1);
  await seedCpu(0, () => 97);
  const second = await job.runOnce();
  assert.equal(second?.fired, 0);

  const inbox = await notifications();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.kind, 'fired');
  assert.equal(inbox[0]!.ruleId, rule.id);
  assert.equal(inbox[0]!.pcId, pcId);
  assert.equal(inbox[0]!.title, `CPU usage on ${pcName} is above 90%`);
  assert.equal(inbox[0]!.value, 97);
  assert.equal(inbox[0]!.readAt, null);

  const [state] = await repos.alerts.statesFor(rule.id);
  assert.equal(state?.state, 'firing');
  assert.equal(state?.notified, true);
});

test('a breach that clears is resolved, and the owner is told that too', async () => {
  await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);

  const job = new AlertJob(context());
  await job.runOnce();

  advance(1);
  await seedCpu(0, () => 30);
  const outcome = await job.runOnce();

  assert.equal(outcome?.resolved, 1);
  const inbox = await notifications();
  assert.deepEqual(inbox.map((entry) => entry.kind).sort(), ['fired', 'resolved']);
});

test('a PC that stops reporting does not resolve its own alert', async () => {
  const rule = await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);

  const job = new AlertJob(context());
  await job.runOnce();

  // Half an hour of nothing. The alert has not recovered; nobody knows what the CPU is doing.
  advance(30);
  const outcome = await job.runOnce();

  assert.equal(outcome?.resolved, 0);
  const [state] = await repos.alerts.statesFor(rule.id);
  assert.equal(state?.state, 'firing');
  assert.equal((await notifications()).length, 1);
});

test('a flapping metric inside its cooldown fires silently and resolves silently', async () => {
  const rule = await repos.alerts.createRule(userId, cpuRule({ forMinutes: 2, cooldownMinutes: 60 }));
  const job = new AlertJob(context());

  await seedCpu(3, () => 97);
  await job.runOnce();

  advance(1);
  await seedCpu(0, () => 20);
  await job.runOnce();

  // Back over the line twenty minutes after the owner was last told.
  advance(20);
  await seedCpu(3, () => 97);
  const refire = await job.runOnce();
  assert.equal(refire?.fired, 1);
  assert.equal(refire?.notificationsWritten, 0);

  const [state] = await repos.alerts.statesFor(rule.id);
  assert.equal(state?.state, 'firing');
  assert.equal(state?.notified, false);

  advance(1);
  await seedCpu(0, () => 20);
  const quietResolve = await job.runOnce();
  assert.equal(quietResolve?.resolved, 1);
  assert.equal(quietResolve?.notificationsWritten, 0);

  // Fired and resolved once each, out loud. The silent round trip left nothing in the inbox.
  assert.deepEqual((await notifications()).map((entry) => entry.kind).sort(), ['fired', 'resolved']);
});

test('two instances evaluating at the same moment tell the owner once', async () => {
  await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);

  const outcomes = await Promise.all([new AlertJob(context()).runOnce(), new AlertJob(context()).runOnce()]);

  assert.equal((await notifications()).length, 1);
  assert.equal(outcomes.reduce((total, outcome) => total + (outcome?.notificationsWritten ?? 0), 0), 1);
});

test('a transition based on a stale read writes nothing', async () => {
  // The compare-and-set directly, with the interleaving forced rather than hoped for: one instance
  // read "firing", another resolved and re-fired it in between.
  const rule = await repos.alerts.createRule(userId, cpuRule());
  const firstFiring = new Date(now.getTime() - 10 * 60_000);

  const inserted = await withTransaction(db, (client) =>
    repos.alerts.transition(client, {
      ruleId: rule.id,
      pcId,
      seriesKey: '',
      from: null,
      to: 'firing',
      notified: true,
      notifiedAt: firstFiring,
      now: firstFiring,
    }),
  );
  assert.equal(inserted, true);

  // A second insert of the same alert loses.
  const duplicate = await withTransaction(db, (client) =>
    repos.alerts.transition(client, {
      ruleId: rule.id,
      pcId,
      seriesKey: '',
      from: null,
      to: 'firing',
      notified: true,
      notifiedAt: now,
      now,
    }),
  );
  assert.equal(duplicate, false);

  // Resolved and re-fired by somebody else.
  await db.query(`UPDATE alert_states SET changed_at = $2 WHERE rule_id = $1`, [rule.id, now]);

  const stale = await withTransaction(db, (client) =>
    repos.alerts.transition(client, {
      ruleId: rule.id,
      pcId,
      seriesKey: '',
      from: { state: 'firing', changedAt: firstFiring },
      to: 'ok',
      notified: false,
      notifiedAt: null,
      now,
    }),
  );
  assert.equal(stale, false);
  assert.equal((await repos.alerts.statesFor(rule.id))[0]?.state, 'firing');
});

test('an offline rule on every PC fires for the one that has gone', async () => {
  const rule = await repos.alerts.createRule(
    userId,
    cpuRule({ pcId: null, name: 'Gone', condition: 'pc-offline', metric: null, threshold: null, forMinutes: 15 }),
  );

  const job = new AlertJob(context());
  assert.equal((await job.runOnce())?.fired, 0);

  await db.query(`UPDATE pcs SET status = 'offline', last_seen_at = $2 WHERE id = $1`, [
    pcId,
    new Date(now.getTime() - 40 * 60_000),
  ]);

  const outcome = await job.runOnce();
  assert.equal(outcome?.fired, 1);

  const [entry] = await notifications();
  assert.equal(entry?.title, `${pcName} is offline`);
  assert.match(entry!.detail, /40 minutes/);
  assert.equal((await repos.alerts.statesFor(rule.id))[0]?.pcId, pcId);
});

test('a revoked PC is not watched', async () => {
  await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);
  await db.query(`UPDATE pcs SET registration_state = 'revoked' WHERE id = $1`, [pcId]);

  assert.equal((await new AlertJob(context()).runOnce())?.fired, 0);
});

test('a long window is judged from the five-minute history once the raw samples are gone', async () => {
  // Three hours above the line, rolled up, and then the raw samples older than twenty minutes
  // deleted. A rule that needed seventeen thousand raw samples to answer would be unanswerable;
  // the bucket minimums answer it exactly.
  await repos.alerts.createRule(userId, cpuRule({ forMinutes: 180 }));
  await seedCpu(185, () => 96);

  const rolled = await new RollupJob(context()).runOnce();
  assert.ok(rolled && rolled.bucketsWritten['5m'] > 0, `rollup: ${JSON.stringify(rolled)}`);

  await db.query('DELETE FROM telemetry_samples WHERE pc_id = $1 AND sampled_at < $2', [
    pcId,
    new Date(now.getTime() - 20 * 60_000),
  ]);

  const outcome = await new AlertJob(context()).runOnce();
  assert.equal(outcome?.fired, 1);
  assert.equal((await notifications())[0]?.value, 96);
});

test('one dip inside a long window is seen through the bucket minimum', async () => {
  // A single sample under the line two hours ago, long since rolled up. The five-minute average
  // for that bucket is still above 90; its minimum is not, and the minimum is what is judged.
  await repos.alerts.createRule(userId, cpuRule({ forMinutes: 180 }));
  await seedCpu(185, (minutesAgo) => (minutesAgo === 120 ? 50 : 96));

  await new RollupJob(context()).runOnce();
  await db.query('DELETE FROM telemetry_samples WHERE pc_id = $1 AND sampled_at < $2', [
    pcId,
    new Date(now.getTime() - 20 * 60_000),
  ]);

  const outcome = await new AlertJob(context()).runOnce();
  assert.equal(outcome?.fired, 0);
});

test('editing a rule forgets what the old rule concluded', async () => {
  const rule = await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);
  await new AlertJob(context()).runOnce();
  assert.equal((await repos.alerts.statesFor(rule.id)).length, 1);

  await repos.alerts.updateRule(rule.id, userId, cpuRule({ threshold: 99 }));
  assert.equal((await repos.alerts.statesFor(rule.id)).length, 0);
});

test('reading notifications is scoped to their owner', async () => {
  await repos.alerts.createRule(userId, cpuRule());
  await seedCpu(12, () => 97);
  await new AlertJob(context()).runOnce();

  const [entry] = await notifications();
  assert.equal(await repos.alerts.unreadCount(userId), 1);

  assert.equal(await repos.alerts.markRead(entry!.id, newId(), now), false);
  assert.equal(await repos.alerts.unreadCount(userId), 1);

  assert.equal(await repos.alerts.markRead(entry!.id, userId, now), true);
  assert.equal(await repos.alerts.unreadCount(userId), 0);
});

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { newId } from '@wolf/shared-types';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.js';
import type { PushOutcome, PushSender, PushTarget } from '../cloud/push.js';
import { PushJob } from './push.js';

/**
 * Waking phones from the notifications table: once per notification, only active devices with a token, never
 * for old news, and a dead token forgotten unless the phone has registered a new one since.
 */

let db: TestDatabase;
let repos: Repositories;
let userId: string;
let phoneA: string;
let phoneB: string;
let browser: string;
let clock: Date;

class RecordingSender implements PushSender {
  readonly provider = 'fcm' as const;
  readonly calls: PushTarget[] = [];
  outcome: (target: PushTarget) => Promise<PushOutcome> = async () => 'delivered';

  async wake(target: PushTarget): Promise<PushOutcome> {
    this.calls.push(target);
    return this.outcome(target);
  }
}

function job(sender: PushSender): PushJob {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://test/wolf', WOLF_TOKEN_SECRET: 'push-job-test-secret-long-enough-to-pass' } as NodeJS.ProcessEnv);
  return new PushJob({ config, db, repos, logger: pino({ level: 'silent' }), now: () => clock }, sender);
}

async function notify(minutesAgo: number): Promise<void> {
  await db.query(
    `INSERT INTO notifications (id, user_id, kind, severity, title, detail, occurred_at)
     VALUES ($1, $2, 'fired', 'critical', 'DESKTOP-50RGWF is offline', 'No heartbeat for 10 minutes.', $3)`,
    [newId(), userId, new Date(clock.getTime() - minutesAgo * 60_000)],
  );
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);
  repos = createRepositories(db);

  const owner = await repos.users.createOwner({ id: newId(), email: 'push-owner@example.com', passwordHash: 'not-a-real-hash', displayName: 'Owner' });
  userId = owner.id;
  phoneA = (await repos.devices.create({ id: newId(), userId, kind: 'android', name: 'Phone A', platform: null, publicKey: null })).id;
  phoneB = (await repos.devices.create({ id: newId(), userId, kind: 'android', name: 'Phone B', platform: null, publicKey: null })).id;
  browser = (await repos.devices.create({ id: newId(), userId, kind: 'web', name: 'Browser', platform: null, publicKey: null })).id;
});

beforeEach(async () => {
  clock = new Date();
  await db.query('DELETE FROM notifications');
  await db.query('DELETE FROM device_push_tokens');
  await db.query(`UPDATE user_devices SET status = 'active', revoked_at = NULL`);
  await repos.push.setToken({ deviceId: phoneA, userId, provider: 'fcm', token: 'token-for-phone-a-0123456789' });
  await repos.push.setToken({ deviceId: phoneB, userId, provider: 'fcm', token: 'token-for-phone-b-0123456789' });
});

after(async () => {
  await db.end();
});

test('news wakes each active device with a token, once, and the web device without one is not asked', async () => {
  const sender = new RecordingSender();
  await notify(0);
  await notify(0);

  const summary = await job(sender).runOnce();

  assert.deepEqual(sender.calls.map((call) => call.deviceId).sort(), [phoneA, phoneB].sort());
  assert.equal(summary?.delivered, 2);
  assert.ok(!sender.calls.some((call) => call.deviceId === browser));

  await job(sender).runOnce();
  assert.equal(sender.calls.length, 2, 'a notification is considered once');
});

test('the sender is given a device and a token, and nothing from the notification', async () => {
  const sender = new RecordingSender();
  await notify(0);
  await job(sender).runOnce();

  for (const call of sender.calls) {
    assert.deepEqual(Object.keys(call).sort(), ['deviceId', 'token']);
    assert.ok(!JSON.stringify(call).includes('DESKTOP'));
  }
});

test('no news wakes nobody, and old news is set aside without a wake-up', async () => {
  const sender = new RecordingSender();
  await job(sender).runOnce();
  assert.equal(sender.calls.length, 0);

  await notify(20);
  await job(sender).runOnce();
  assert.equal(sender.calls.length, 0);
  const { rows } = await db.query<{ pending: string }>('SELECT count(*)::text AS pending FROM notifications WHERE pushed_at IS NULL');
  assert.equal(rows[0]?.pending, '0', 'it is not reconsidered forever');
});

test('a revoked device is never woken', async () => {
  const sender = new RecordingSender();
  await repos.devices.revoke(phoneB, userId);
  await notify(0);

  await job(sender).runOnce();

  assert.deepEqual(sender.calls.map((call) => call.deviceId), [phoneA]);
});

test('a dead token is forgotten, unless the phone registered a new one in the meantime', async () => {
  const sender = new RecordingSender();
  sender.outcome = async (target) => {
    if (target.deviceId === phoneB) {
      // The phone rotated its token while this wake-up was on its way.
      await repos.push.setToken({ deviceId: phoneB, userId, provider: 'fcm', token: 'fresh-token-for-phone-b-0123' });
    }
    return 'token-invalid';
  };
  await notify(0);

  const summary = await job(sender).runOnce();

  assert.equal(summary?.invalidTokens, 2);
  assert.equal(await repos.push.hasToken(phoneA), false);
  assert.equal(await repos.push.hasToken(phoneB), true);
});

test('a failed send is not retried: the notification is already safe in the inbox', async () => {
  const sender = new RecordingSender();
  sender.outcome = async () => 'failed';
  await notify(0);

  assert.equal((await job(sender).runOnce())?.failed, 2);
  await job(sender).runOnce();
  assert.equal(sender.calls.length, 2);
  assert.equal(await repos.push.hasToken(phoneA), true, 'a failure is not a dead token');
});

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { newId } from '@wolf/shared-types';
import { WEBHOOK_FAILURES_BEFORE_DISABLE } from '@wolf/protocol';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.js';
import { WebhookSecrets } from '../webhooks/secrets.js';
import type { WebhookDelivery, WebhookResult, WebhookSender } from '../webhooks/sender.js';
import { WebhookJob } from './webhooks.js';

/**
 * From the notifications table to webhooks: fanned out once, only to webhooks that want the severity, never the
 * backlog, retried a minute and then five minutes later, and a webhook that keeps failing turned off with the
 * owner told.
 */

const KEY = 'webhook-job-test-key-long-enough-for-hkdf-0123456789';
const secrets = new WebhookSecrets(KEY);

let db: TestDatabase;
let repos: Repositories;
let userId: string;
let clock: Date;

class RecordingSender {
  readonly calls: WebhookDelivery[] = [];
  outcome: WebhookResult = { outcome: 'delivered', status: 204, detail: '' };

  async deliver(delivery: WebhookDelivery): Promise<WebhookResult> {
    this.calls.push(delivery);
    return this.outcome;
  }
}

function job(sender: RecordingSender): WebhookJob {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://test/wolf', WOLF_TOKEN_SECRET: 'webhook-job-test-secret-long-enough' } as NodeJS.ProcessEnv);
  return new WebhookJob({ config, db, repos, logger: pino({ level: 'silent' }), now: () => clock }, secrets, sender as unknown as WebhookSender);
}

async function webhook(
  owner: string,
  minSeverity: 'info' | 'warning' | 'critical',
  url = 'https://hooks.example.com/in/secret-token',
  format: 'wolf' | 'slack' | 'discord' = 'wolf',
) {
  const id = newId();
  return repos.webhooks.create({
    id,
    userId: owner,
    name: `Hook ${id.slice(-4)}`,
    host: new URL(url).host,
    urlSealed: secrets.encryptUrl(id, url),
    secretSalt: secrets.newSalt(),
    format,
    minSeverity,
  });
}

async function notify(owner: string, severity: 'info' | 'warning' | 'critical', occurredAt = clock): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO notifications (id, user_id, kind, severity, title, detail, occurred_at)
     VALUES ($1, $2, 'automation', $3, $4, 'detail', $5)`,
    [id, owner, severity, `A ${severity} thing`, occurredAt],
  );
  return id;
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);
  repos = createRepositories(db);
  userId = (await repos.users.createOwner({ id: newId(), email: 'hooks@example.com', passwordHash: 'scrypt$4096$8$1$c2FsdA$aGFzaA', displayName: 'Owner' })).id;
});

beforeEach(async () => {
  clock = new Date('2026-09-16T10:00:00.000Z');
  await db.query('DELETE FROM webhooks');
  await db.query('DELETE FROM notifications');
});

after(async () => {
  await db.end();
});

test('a notification goes once to each webhook whose minimum severity it meets, signed and with the real URL', async () => {
  const warnings = await webhook(userId, 'warning');
  const criticalOnly = await webhook(userId, 'critical');
  const sender = new RecordingSender();

  const warning = await notify(userId, 'warning');
  await notify(userId, 'info');

  const first = await job(sender).runOnce();
  assert.equal(first?.delivered, 1);
  assert.equal(sender.calls.length, 1);

  const call = sender.calls[0]!;
  assert.equal(call.url, 'https://hooks.example.com/in/secret-token');
  assert.equal(call.secret, secrets.signingSecret(warnings.id, warnings.secretSalt));
  assert.equal(call.deliveryId, `${warning}.${warnings.id}`);
  const body = JSON.parse(call.body);
  assert.equal(body.type, 'wolf.notification');
  assert.equal(body.notification.severity, 'warning');
  assert.equal(body.notification.title, 'A warning thing');
  assert.ok(!('userId' in body.notification));

  // Nothing is sent twice, however many passes run.
  await job(sender).runOnce();
  assert.equal(sender.calls.length, 1);
  assert.equal((await repos.webhooks.find(criticalOnly.id, userId))?.lastOutcome, null);
  assert.equal((await repos.webhooks.find(warnings.id, userId))?.lastOutcome, 'delivered');
});

test('the backlog is not sent, and a notification too old to be news is not either', async () => {
  // Written before the webhook existed and already considered: the migration marks history as sent.
  const old = await notify(userId, 'critical', new Date(clock.getTime() - 3 * 3_600_000));
  await db.query('UPDATE notifications SET webhooked_at = occurred_at WHERE id = $1', [old]);
  await notify(userId, 'critical', new Date(clock.getTime() - 45 * 60_000));
  await webhook(userId, 'info');

  const sender = new RecordingSender();
  await job(sender).runOnce();
  assert.equal(sender.calls.length, 0);
});

test('a failed delivery is retried after a minute and after five, then given up; a success resets the run of failures', async () => {
  const hook = await webhook(userId, 'info');
  const sender = new RecordingSender();
  sender.outcome = { outcome: 'http-error', status: 503, detail: '' };
  await notify(userId, 'warning');

  const runner = job(sender);
  await runner.runOnce();
  assert.equal(sender.calls.length, 1);

  clock = new Date(clock.getTime() + 30_000);
  await runner.runOnce();
  assert.equal(sender.calls.length, 1, 'not before the minute is up');

  clock = new Date(clock.getTime() + 31_000);
  await runner.runOnce();
  assert.equal(sender.calls.length, 2);

  clock = new Date(clock.getTime() + 5 * 60_000 + 1_000);
  await runner.runOnce();
  assert.equal(sender.calls.length, 3);

  clock = new Date(clock.getTime() + 60 * 60_000);
  await runner.runOnce();
  assert.equal(sender.calls.length, 3, 'three attempts in all');
  assert.equal((await repos.webhooks.find(hook.id, userId))?.consecutiveFailures, 3);

  sender.outcome = { outcome: 'delivered', status: 200, detail: '' };
  await notify(userId, 'warning');
  await runner.runOnce();
  assert.equal((await repos.webhooks.find(hook.id, userId))?.consecutiveFailures, 0);
});

test('a refused address is not retried', async () => {
  await webhook(userId, 'info');
  const sender = new RecordingSender();
  sender.outcome = { outcome: 'address-refused', status: null, detail: '' };
  await notify(userId, 'info');

  const runner = job(sender);
  await runner.runOnce();
  clock = new Date(clock.getTime() + 10 * 60_000);
  await runner.runOnce();
  assert.equal(sender.calls.length, 1);
});

test('a webhook that keeps failing turns itself off, says so in the inbox, and is sent nothing more', async () => {
  const hook = await webhook(userId, 'info');
  const sender = new RecordingSender();
  sender.outcome = { outcome: 'timeout', status: null, detail: '' };

  for (let i = 0; i < WEBHOOK_FAILURES_BEFORE_DISABLE; i++) await notify(userId, 'info');
  const summary = await job(sender).runOnce();

  assert.equal(summary?.turnedOff, 1);
  const stored = await repos.webhooks.find(hook.id, userId);
  assert.equal(stored?.enabled, false);
  assert.equal(stored?.disabledReason, 'too-many-failures');

  const { rows } = await db.query<{ title: string; detail: string }>(`SELECT title, detail FROM notifications WHERE kind = 'webhook'`);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]!.detail.includes('secret-token'), 'the notice names the host, never the URL');

  const audit = await db.query<Record<string, unknown>>(`SELECT * FROM audit_logs WHERE action = 'webhook.turned-off'`);
  assert.equal(audit.rows.length, 1);
  assert.ok(!JSON.stringify(audit.rows).includes('secret-token'));

  const before = sender.calls.length;
  await notify(userId, 'critical');
  clock = new Date(clock.getTime() + 10 * 60_000);
  await job(sender).runOnce();
  assert.equal(sender.calls.length, before);

  // Turned back on by the owner: the count starts again.
  const on = await repos.webhooks.update(hook.id, userId, { enabled: true });
  assert.equal(on?.disabledReason, null);
  assert.equal(on?.consecutiveFailures, 0);
});

test('a Slack or Discord webhook is sent the message shape it accepts, signed like any other', async () => {
  await webhook(userId, 'info', 'https://hooks.slack.com/services/T/B/x', 'slack');
  await webhook(userId, 'info', 'https://discord.com/api/webhooks/1/x', 'discord');
  const sender = new RecordingSender();
  await notify(userId, 'critical');

  await job(sender).runOnce();

  const bodies = sender.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
  const slack = bodies.find((body) => 'text' in body)!;
  const discord = bodies.find((body) => 'content' in body)!;
  assert.equal(slack['text'], '*[CRITICAL] A critical thing*\ndetail');
  assert.equal(discord['content'], '**[CRITICAL] A critical thing**\ndetail');
  assert.deepEqual(discord['allowed_mentions'], { parse: [] }, 'a message cannot ping anybody');
  assert.ok(sender.calls.every((call) => call.secret.startsWith('whsec_')));
});

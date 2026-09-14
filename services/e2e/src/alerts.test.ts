import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { createRepositories, loadConfig, migrate, withTransaction } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { MAX_ALERT_RULES } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';

/**
 * Alert rules and the inbox, through the real HTTP app.
 *
 * Evaluation has its own suite against a real Postgres. This one is about the boundary: that a
 * rule can only point at the caller's own PCs, that an incoherent rule is refused rather than
 * stored, that every rule change is in the audit log, and that one account's notifications are
 * not another's.
 */

const OWNER_EMAIL = 'alerts-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let userId: string;
let pcId: string;
let token: string;

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
    now: () => new Date(),
  };

  const owner = await repos.users.createOwner({
    id: newId(),
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(OWNER_PASSWORD, {
      cost: 2 ** 12,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
    }),
    displayName: 'Owner',
  });
  userId = owner.id;

  const pc = await repos.pcs.create({
    id: newId(),
    userId,
    name: 'STUDIO',
    hostname: null,
    publicKey: 'a'.repeat(64),
    agentVersion: null,
  });
  pcId = pc.id;
  await db.query(`UPDATE pcs SET registration_state = 'active' WHERE id = $1`, [pcId]);

  app = await buildApp(context);
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name: 'Alerts browser' } },
  });
  assert.equal(login.statusCode, 200);
  token = String(JSON.parse(login.payload).accessToken);
});

after(async () => {
  await app?.close();
  await db.end();
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const diskRule = {
  name: 'Disk nearly full',
  condition: 'metric-above',
  metric: 'disk.usedPercent',
  seriesKey: 'C:',
  threshold: 90,
  forMinutes: 30,
  severity: 'warning',
  cooldownMinutes: 120,
};

test('rules and the inbox require a signed-in caller', async () => {
  for (const [method, url] of [
    ['GET', '/api/v1/alert-rules'],
    ['POST', '/api/v1/alert-rules'],
    ['GET', '/api/v1/notifications'],
    ['POST', '/api/v1/notifications/read-all'],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test('a rule is created, listed, edited and deleted, and every change is audited', async () => {
  const created = await call('POST', '/alert-rules', { ...diskRule, pcId });
  assert.equal(created.statusCode, 201);
  const rule = JSON.parse(created.payload).rule;
  assert.equal(rule.pcId, pcId);
  assert.equal(rule.enabled, true);
  assert.equal(rule.userId, undefined, 'the owner id is not part of the public shape');

  const listed = JSON.parse((await call('GET', '/alert-rules')).payload);
  assert.ok(listed.rules.some((entry: { id: string }) => entry.id === rule.id));
  assert.equal(listed.limit, MAX_ALERT_RULES);

  const patched = await call('PATCH', `/alert-rules/${rule.id}`, { threshold: 95, enabled: false });
  assert.equal(patched.statusCode, 200);
  assert.equal(JSON.parse(patched.payload).rule.threshold, 95);
  assert.equal(JSON.parse(patched.payload).rule.enabled, false);
  // Untouched fields survive a partial update.
  assert.equal(JSON.parse(patched.payload).rule.seriesKey, 'C:');

  assert.equal((await call('DELETE', `/alert-rules/${rule.id}`)).statusCode, 204);
  assert.equal((await call('DELETE', `/alert-rules/${rule.id}`)).statusCode, 404);

  const { rows } = await db.query<{ action: string; before_value: unknown; after_value: unknown }>(
    `SELECT action, before_value, after_value FROM audit_logs
      WHERE category = 'automation' AND target->>'ruleId' = $1
      ORDER BY occurred_at, action`,
    [rule.id],
  );
  assert.deepEqual(
    rows.map((row) => row.action).sort(),
    ['alert-rule.create', 'alert-rule.delete', 'alert-rule.update'],
  );
  const update = rows.find((row) => row.action === 'alert-rule.update')!;
  assert.equal((update.before_value as { threshold: number }).threshold, 90);
  assert.equal((update.after_value as { threshold: number }).threshold, 95);
});

test('a metric rule without a metric or a threshold is refused', async () => {
  const noThreshold = await call('POST', '/alert-rules', { ...diskRule, threshold: null });
  assert.equal(noThreshold.statusCode, 400);

  const noMetric = await call('POST', '/alert-rules', { ...diskRule, metric: null });
  assert.equal(noMetric.statusCode, 400);

  const unknownMetric = await call('POST', '/alert-rules', { ...diskRule, metric: 'disk.somethingElse' });
  assert.equal(unknownMetric.statusCode, 400);
});

test('a cooldown shorter than the floor is refused, so a rule cannot flood the inbox', async () => {
  const response = await call('POST', '/alert-rules', { ...diskRule, cooldownMinutes: 1 });
  assert.equal(response.statusCode, 400);
});

test('coherence is checked on the merged rule, not only on the patch', async () => {
  // An offline rule has no metric. Turning it into a metric rule without supplying one would
  // store a rule its owner believes is watching something.
  const created = await call('POST', '/alert-rules', {
    name: 'Gone',
    condition: 'pc-offline',
    forMinutes: 15,
  });
  assert.equal(created.statusCode, 201);
  const rule = JSON.parse(created.payload).rule;
  assert.equal(rule.pcId, null);

  const incoherent = await call('PATCH', `/alert-rules/${rule.id}`, { condition: 'metric-below' });
  assert.equal(incoherent.statusCode, 400);

  const coherent = await call('PATCH', `/alert-rules/${rule.id}`, {
    condition: 'metric-below',
    metric: 'battery.charge',
    threshold: 15,
  });
  assert.equal(coherent.statusCode, 200);

  await call('DELETE', `/alert-rules/${rule.id}`);
});

test('a rule cannot point at a PC the caller does not own', async () => {
  // WOLF has a single owner account, so "somebody else's PC" and "an id that exists nowhere" are
  // the same query — scoped by owner — and answer the same way, which is the property that matters:
  // the endpoint cannot be used to learn which ids are real.
  const unknown = await call('POST', '/alert-rules', { ...diskRule, pcId: newId() });
  assert.equal(unknown.statusCode, 404);

  const created = await call('POST', '/alert-rules', { ...diskRule, pcId });
  const rule = JSON.parse(created.payload).rule;
  const moved = await call('PATCH', `/alert-rules/${rule.id}`, { pcId: newId() });
  assert.equal(moved.statusCode, 404);

  await call('DELETE', `/alert-rules/${rule.id}`);
});

test(`an account holds at most ${MAX_ALERT_RULES} rules`, async () => {
  const existing = JSON.parse((await call('GET', '/alert-rules')).payload).rules.length as number;

  for (let index = existing; index < MAX_ALERT_RULES; index += 1) {
    const response = await call('POST', '/alert-rules', { ...diskRule, name: `Rule ${index}` });
    assert.equal(response.statusCode, 201);
  }

  const over = await call('POST', '/alert-rules', { ...diskRule, name: 'One too many' });
  assert.equal(over.statusCode, 409);

  await db.query('DELETE FROM alert_rules WHERE user_id = $1', [userId]);
});

test('the inbox lists, counts and marks notifications read', async () => {
  const ids = await withTransaction(db, async (client) => {
    const written: string[] = [];
    for (const kind of ['fired', 'resolved'] as const) {
      written.push(
        await context.repos.alerts.insertNotification(client, {
          userId,
          ruleId: null as unknown as string,
          pcId,
          kind,
          severity: 'critical',
          title: `STUDIO ${kind}`,
          detail: 'detail',
          metric: null,
          seriesKey: null,
          value: null,
          threshold: null,
          occurredAt: new Date(),
        }),
      );
    }
    return written;
  });

  const inbox = JSON.parse((await call('GET', '/notifications')).payload);
  assert.equal(inbox.unreadCount, 2);
  assert.equal(inbox.notifications.length, 2);

  assert.equal((await call('POST', `/notifications/${ids[0]}/read`)).statusCode, 204);
  const unread = JSON.parse((await call('GET', '/notifications?unread=true')).payload);
  assert.equal(unread.unreadCount, 1);
  assert.deepEqual(unread.notifications.map((entry: { id: string }) => entry.id), [ids[1]]);

  // Somebody else's id, or one that does not exist, is not found rather than silently accepted.
  assert.equal((await call('POST', `/notifications/${newId()}/read`)).statusCode, 404);

  const all = JSON.parse((await call('POST', '/notifications/read-all')).payload);
  assert.equal(all.marked, 1);
  assert.equal(JSON.parse((await call('GET', '/notifications')).payload).unreadCount, 0);
});

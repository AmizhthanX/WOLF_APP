import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import {
  WebhookJob,
  WebhookSecrets,
  WebhookSender,
  createRepositories,
  loadConfig,
  migrate,
  verifyWebhook,
} from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';

/**
 * Webhooks through the real HTTP app, delivering to a real HTTPS server on this machine.
 *
 * The receiver's name resolves to a public address, so it passes the same check a production delivery does; the
 * sender then opens its socket to this machine, where a throwaway certificate for that name is trusted for the
 * run. Everything between — sealing the URL, deriving the secret, signing, the job, the audit trail — is the
 * code that runs in production.
 */

const OWNER_EMAIL = 'webhook-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';
const KEY = 'e2e-webhook-key-that-is-long-enough-for-hkdf-012345';
const TOKEN_IN_PATH = 'T0KEN-in-the-path-9f8e7d';

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let userId: string;
let token: string;
let clock: Date;

let receiver: Server;
let port: number;
let workDir: string;
let answer = 204;
const received: { headers: Record<string, unknown>; body: string }[] = [];
let sender: WebhookSender;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'wolf-e2e-webhooks-'));
  const key = path.join(workDir, 'key');
  const cert = path.join(workDir, 'cert');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=hooks.example.com', '-addext', 'subjectAltName=DNS:hooks.example.com'],
    { stdio: 'ignore' },
  );
  const ca = readFileSync(cert);

  receiver = createServer({ key: readFileSync(key), cert: ca }, (request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer;
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  port = (receiver.address() as { port: number }).port;

  sender = new WebhookSender({
    resolve: async (hostname) => {
      if (hostname === 'hooks.example.com') return [{ address: '93.184.215.14', family: 4 }];
      if (hostname === 'inside.example.com') return [{ address: '10.20.30.40', family: 4 }];
      throw new Error('not found');
    },
    testConnectAddress: { address: '127.0.0.1', family: 4 },
    ca,
    timeoutMs: 3_000,
  });

  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
    WOLF_WEBHOOK_KEY: KEY,
  } as NodeJS.ProcessEnv);

  clock = new Date();
  const repos = createRepositories(db);
  context = {
    config,
    db,
    repos,
    logger: pino({ level: 'silent' }),
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => clock,
    webhookSender: sender,
  };

  userId = (
    await repos.users.createOwner({
      id: newId(),
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(OWNER_PASSWORD, { cost: 2 ** 12, blockSize: 8, parallelization: 1, keyLength: 32 }),
      displayName: 'Owner',
    })
  ).id;

  app = await buildApp(context);
  await app.ready();
});

beforeEach(async () => {
  clock = new Date();
  answer = 204;
  await db.query('DELETE FROM webhooks');
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name: 'Webhook browser' } },
  });
  token = String(JSON.parse(login.payload).accessToken);
});

after(async () => {
  await app?.close();
  await db?.end();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const hookUrl = () => `https://hooks.example.com:${port}/services/${TOKEN_IN_PATH}`;

async function create(overrides: Record<string, unknown> = {}) {
  const response = await call('POST', '/webhooks', { webhook: { name: 'Team chat', url: hookUrl(), minSeverity: 'warning', ...overrides } });
  assert.equal(response.statusCode, 201, response.payload);
  return JSON.parse(response.payload) as { webhook: { id: string; host: string; enabled: boolean }; secret: string };
}

test('a webhook is saved with its URL sealed, its secret shown once, and neither in the API, the database or the audit trail', async () => {
  const { webhook, secret } = await create();
  assert.match(secret, /^whsec_/);
  assert.equal(webhook.host, `hooks.example.com:${port}`);

  const listed = await call('GET', '/webhooks');
  assert.equal(JSON.parse(listed.payload).configured, true);
  assert.ok(!listed.payload.includes(TOKEN_IN_PATH), 'the list shows the host, not the URL');
  assert.ok(!listed.payload.includes(secret), 'nor the secret');

  const stored = await db.query<Record<string, unknown>>('SELECT * FROM webhooks');
  assert.ok(!JSON.stringify(stored.rows).includes(TOKEN_IN_PATH), 'the URL is encrypted at rest');
  assert.ok(!JSON.stringify(stored.rows).includes(secret), 'the secret is not stored');

  const audit = await db.query<Record<string, unknown>>(`SELECT * FROM audit_logs WHERE action LIKE 'webhook.%'`);
  assert.ok(audit.rows.length >= 1);
  assert.ok(!JSON.stringify(audit.rows).includes(TOKEN_IN_PATH), 'the audit trail names the host');
});

test('saving a webhook needs a recently entered password', async () => {
  clock = new Date(Date.now() + 10 * 60_000);
  const stale = await call('POST', '/webhooks', { webhook: { name: 'Late', url: hookUrl() } });
  assert.equal(JSON.parse(stale.payload).error.code, 'command.reauth_required');
  assert.equal((await db.query('SELECT 1 FROM webhooks')).rows.length, 0);
});

test('a URL that is not https, or that points inside a network, is refused before anything is saved', async () => {
  const insecure = await call('POST', '/webhooks', { webhook: { name: 'Plain', url: `http://hooks.example.com:${port}/in` } });
  assert.equal(insecure.statusCode, 400);

  for (const url of ['https://localhost/in', 'https://169.254.169.254/latest/meta-data', 'https://inside.example.com/in', 'https://[::1]/in']) {
    const refused = await call('POST', '/webhooks', { webhook: { name: 'Inside', url } });
    assert.equal(refused.statusCode, 422, url);
    assert.equal(JSON.parse(refused.payload).error.code, 'webhooks.address_refused', url);
  }
  assert.equal((await db.query('SELECT 1 FROM webhooks')).rows.length, 0);
  assert.equal(received.length, 0, 'nothing was sent anywhere');
});

test('a test delivery and a real notification arrive signed with the webhook’s secret; rotating it changes the signature', async () => {
  const { webhook, secret } = await create();
  const before = received.length;

  const tested = await call('POST', `/webhooks/${webhook.id}/test`);
  assert.equal(JSON.parse(tested.payload).outcome, 'delivered');
  const testDelivery = received[before]!;
  assert.equal(JSON.parse(testDelivery.body).type, 'wolf.test');
  assert.equal(verifyWebhook(secret, String(testDelivery.headers['wolf-signature']), testDelivery.body, Math.floor(clock.getTime() / 1000)), true);

  await db.query(
    `INSERT INTO notifications (id, user_id, kind, severity, title, detail, occurred_at)
     VALUES ($1, $2, 'fired', 'critical', 'Disk almost full on Tower', 'C: is at 97%.', $3)`,
    [newId(), userId, clock],
  );
  const job = new WebhookJob(context, new WebhookSecrets(KEY), sender);
  await job.runOnce();

  const delivered = received.at(-1)!;
  const body = JSON.parse(delivered.body);
  assert.equal(body.type, 'wolf.notification');
  assert.equal(body.notification.title, 'Disk almost full on Tower');
  assert.equal(verifyWebhook(secret, String(delivered.headers['wolf-signature']), delivered.body, Math.floor(clock.getTime() / 1000)), true);

  const rotated = await call('POST', `/webhooks/${webhook.id}/rotate-secret`);
  const newSecret = JSON.parse(rotated.payload).secret as string;
  assert.notEqual(newSecret, secret);

  await call('POST', `/webhooks/${webhook.id}/test`);
  const after = received.at(-1)!;
  assert.equal(verifyWebhook(secret, String(after.headers['wolf-signature']), after.body, Math.floor(clock.getTime() / 1000)), false);
  assert.equal(verifyWebhook(newSecret, String(after.headers['wolf-signature']), after.body, Math.floor(clock.getTime() / 1000)), true);
});

test('a webhook turned off is sent nothing, and a deleted one is gone', async () => {
  const { webhook } = await create({ minSeverity: 'info' });
  const off = await call('PATCH', `/webhooks/${webhook.id}`, { enabled: false });
  assert.equal(JSON.parse(off.payload).webhook.enabled, false);

  const before = received.length;
  await db.query(
    `INSERT INTO notifications (id, user_id, kind, severity, title, detail, occurred_at) VALUES ($1, $2, 'fired', 'critical', 'x', 'y', $3)`,
    [newId(), userId, clock],
  );
  await new WebhookJob(context, new WebhookSecrets(KEY), sender).runOnce();
  assert.equal(received.length, before);

  assert.equal((await call('DELETE', `/webhooks/${webhook.id}`)).statusCode, 204);
  assert.equal(JSON.parse((await call('GET', '/webhooks')).payload).webhooks.length, 0);
  assert.equal((await call('POST', `/webhooks/${webhook.id}/test`)).statusCode, 404);
});

test('a server without a webhook key says so and saves nothing', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const bare = await buildApp({ ...context, config });
  await bare.ready();
  try {
    const headers = { authorization: `Bearer ${token}` };
    const listed = await bare.inject({ method: 'GET', url: '/api/v1/webhooks', headers });
    assert.equal(JSON.parse(listed.payload).configured, false);
    const refused = await bare.inject({ method: 'POST', url: '/api/v1/webhooks', headers, payload: { webhook: { name: 'x', url: hookUrl() } } });
    assert.equal(JSON.parse(refused.payload).error.code, 'webhooks.not_configured');
  } finally {
    await bare.close();
  }
});

test('an account holds at most ten webhooks, and nobody unauthenticated can see or make one', async () => {
  for (let i = 0; i < 10; i++) await create({ name: `Hook ${i}` });
  const eleventh = await call('POST', '/webhooks', { webhook: { name: 'One more', url: hookUrl() } });
  assert.equal(eleventh.statusCode, 409);

  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/webhooks' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/webhooks', payload: { webhook: {} } })).statusCode, 401);
});

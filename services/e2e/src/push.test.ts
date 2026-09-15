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

/**
 * Push registration through the real HTTP app: a device registers only its own token, the audit trail says
 * that it did and never what the token was, a server without a push service says so, and a revoked device
 * stops being a target.
 */

const OWNER_EMAIL = 'push-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';
const TOKEN = 'fcm-registration-token:APA91bExampleOnlyNotReal0123456789';

let db: TestDatabase;
let app: FastifyInstance;

async function login(name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'android', name } },
  });
  assert.equal(response.statusCode, 200, response.payload);
  return String(JSON.parse(response.payload).accessToken);
}

async function call(method: 'GET' | 'PUT' | 'DELETE', url: string, bearer: string, payload?: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${bearer}` };
  if (payload === undefined) return app.inject({ method, url, headers });
  return app.inject({ method, url, headers, payload });
}

async function deviceIdOf(bearer: string): Promise<string> {
  const response = await call('GET', '/api/v1/users/me', bearer);
  return String(JSON.parse(response.payload).device.id);
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const repos = createRepositories(db);
  const context: AppContext = {
    config,
    db,
    repos,
    logger: pino({ level: 'silent' }),
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => new Date(),
  };

  await repos.users.createOwner({
    id: newId(),
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(OWNER_PASSWORD, { cost: 2 ** 12, blockSize: 8, parallelization: 1, keyLength: 32 }),
    displayName: 'Owner',
  });

  app = await buildApp(context);
  await app.ready();
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('a server without a push service says so, and a device starts unregistered', async () => {
  const phone = await login('Status phone');
  const response = await call('GET', '/api/v1/push', phone);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.payload), { configured: false, provider: null, registered: false });
});

test('a device registers its own token, and the audit trail records that it did but never the token', async () => {
  const phone = await login('Registering phone');

  const registered = await call('PUT', '/api/v1/push/token', phone, { provider: 'fcm', token: TOKEN });
  assert.equal(registered.statusCode, 204, registered.payload);
  assert.equal(JSON.parse((await call('GET', '/api/v1/push', phone)).payload).registered, true);

  const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM audit_logs WHERE action LIKE 'device.push-token.%'`);
  assert.ok(rows.length >= 1, 'the registration is audited');
  assert.ok(!JSON.stringify(rows).includes(TOKEN), 'the token never reaches the audit trail');
  assert.ok(!JSON.stringify(rows).includes('APA91b'));

  // Another device's view of push says nothing about this device's registration.
  const other = await login('Other phone');
  assert.equal(JSON.parse((await call('GET', '/api/v1/push', other)).payload).registered, false);
});

test('something that is not a token, or a provider WOLF does not use, is refused', async () => {
  const phone = await login('Refused phone');

  assert.equal((await call('PUT', '/api/v1/push/token', phone, { provider: 'fcm', token: 'has spaces and is long enough' })).statusCode, 400);
  assert.equal((await call('PUT', '/api/v1/push/token', phone, { provider: 'fcm', token: 'short' })).statusCode, 400);
  assert.equal((await call('PUT', '/api/v1/push/token', phone, { provider: 'apns', token: TOKEN })).statusCode, 400);
  assert.equal(JSON.parse((await call('GET', '/api/v1/push', phone)).payload).registered, false);
});

test('clearing the token, or revoking the device, stops wake-ups to it', async () => {
  const phone = await login('Clearing phone');
  const phoneId = await deviceIdOf(phone);

  await call('PUT', '/api/v1/push/token', phone, { provider: 'fcm', token: TOKEN });
  assert.equal((await call('DELETE', '/api/v1/push/token', phone)).statusCode, 204);
  assert.equal(JSON.parse((await call('GET', '/api/v1/push', phone)).payload).registered, false);

  await call('PUT', '/api/v1/push/token', phone, { provider: 'fcm', token: TOKEN });
  const admin = await login('Revoking browser');
  const revoked = await call('DELETE', `/api/v1/devices/${phoneId}`, admin);
  assert.equal(revoked.statusCode, 204, revoked.payload);

  const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM device_push_tokens WHERE device_id = $1', [phoneId]);
  assert.equal(rows[0]?.count, '0');
});

test('an unauthenticated caller can neither read push status nor register a token', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/push' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/push/token', payload: { provider: 'fcm', token: TOKEN } })).statusCode, 401);
});

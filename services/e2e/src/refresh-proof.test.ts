import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import {
  createHmacSigner,
  generateIdentityKeyPair,
  hashPassword,
  signPayload,
  type IdentityKeyPair,
} from '@wolf/auth';
import { refreshProofPayload, refreshTokenBinding, webRefreshProofPayload } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';

/**
 * Device proof-of-possession on refresh, through the real HTTP app.
 *
 * A device that registered an identity key signs every refresh with it. Without that signature — or with
 * someone else's — the refresh token is treated as copied: every token for the device is revoked and the
 * event is recorded. A correct signature from a wrong clock is refused without revoking anything. A device
 * that registered no key is not asked.
 *
 * A phone signs its refresh token. A browser signs the token's binding, because its page never holds the
 * token; which of the two a device must sign is fixed by its kind, never by the request.
 */

const OWNER_EMAIL = 'proof-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let now = new Date();

interface Grant {
  readonly refreshToken: string;
  readonly device: { readonly id: string };
}

async function login(
  name: string,
  key: IdentityKeyPair | null,
  deviceId?: string,
  kind: 'android' | 'web' = 'android',
): Promise<Grant> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      device: { kind, name, ...(key ? { publicKey: key.publicKey } : {}), ...(deviceId ? { id: deviceId } : {}) },
    },
  });
  assert.equal(response.statusCode, 200, response.payload);
  return JSON.parse(response.payload) as Grant;
}

function proof(key: IdentityKeyPair, deviceId: string, token: string, at: Date = now) {
  const signedAt = at.toISOString();
  return { signedAt, signature: signPayload(key.privateKey, refreshProofPayload(deviceId, token, signedAt)) };
}

/** What the dashboard sends: a signature over the token's binding, which the broker computes from the cookie. */
async function webProof(key: IdentityKeyPair, deviceId: string, token: string, at: Date = now) {
  const signedAt = at.toISOString();
  const binding = await refreshTokenBinding(token);
  return { signedAt, signature: signPayload(key.privateKey, webRefreshProofPayload(deviceId, binding, signedAt)) };
}

async function refresh(deviceId: string, refreshToken: string, signed?: ReturnType<typeof proof>) {
  const payload = signed ? { refreshToken, deviceId, proof: signed } : { refreshToken, deviceId };
  return app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload });
}

async function proofEvents(deviceId: string) {
  const { rows } = await db.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM security_events WHERE type = 'device-proof-failure' AND device_id = $1`,
    [deviceId],
  );
  return rows;
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
    now: () => now,
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

test('a device signs every refresh with its key, and each rotated token needs a new signature', async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Signed phone', key);

  const first = await refresh(grant.device.id, grant.refreshToken, proof(key, grant.device.id, grant.refreshToken));
  assert.equal(first.statusCode, 200, first.payload);
  const rotated = JSON.parse(first.payload) as Grant;

  // A signature is bound to the token it was made for: the old one's does not carry over.
  const reused = await refresh(grant.device.id, rotated.refreshToken, proof(key, grant.device.id, grant.refreshToken));
  assert.equal(reused.statusCode, 401);
});

test('an unsigned refresh from a device with a key is a copied token: every token for it is revoked', async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Copied token', key);

  const unsigned = await refresh(grant.device.id, grant.refreshToken);
  assert.equal(unsigned.statusCode, 401, unsigned.payload);

  // The rightful device, with its own key, finds the family gone: the copy cost the session.
  const rightful = await refresh(grant.device.id, grant.refreshToken, proof(key, grant.device.id, grant.refreshToken));
  assert.equal(rightful.statusCode, 401);

  const events = await proofEvents(grant.device.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.detail['reason'], 'missing');
  assert.ok(!JSON.stringify(events).includes(grant.refreshToken), 'the token never reaches the security log');
});

test("a signature from another key is refused and revokes the device's tokens", async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Forged proof', key);

  const forged = await refresh(grant.device.id, grant.refreshToken, proof(generateIdentityKeyPair(), grant.device.id, grant.refreshToken));
  assert.equal(forged.statusCode, 401);

  const events = await proofEvents(grant.device.id);
  assert.equal(events[0]?.detail['reason'], 'bad-signature');
  assert.equal((await refresh(grant.device.id, grant.refreshToken, proof(key, grant.device.id, grant.refreshToken))).statusCode, 401);
});

test('a correct signature by a wrong clock is refused without revoking anything', async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Wrong clock', key);

  const skewed = await refresh(
    grant.device.id,
    grant.refreshToken,
    proof(key, grant.device.id, grant.refreshToken, new Date(now.getTime() - 10 * 60 * 1000)),
  );
  assert.equal(skewed.statusCode, 400, skewed.payload);
  assert.equal(JSON.parse(skewed.payload).error.code, 'auth.device_clock');

  // Nothing was taken away: the same token, signed now, still rotates.
  const corrected = await refresh(grant.device.id, grant.refreshToken, proof(key, grant.device.id, grant.refreshToken));
  assert.equal(corrected.statusCode, 200, corrected.payload);
});

test('a device that registered no key is not asked for a proof', async () => {
  now = new Date();
  const grant = await login('Browser', null);

  const response = await refresh(grant.device.id, grant.refreshToken);
  assert.equal(response.statusCode, 200, response.payload);
});

test("signing in with a device's id but another key makes a new device rather than rebinding it", async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const original = await login('Bound phone', key);

  const other = await login('Someone else', generateIdentityKeyPair(), original.device.id);
  assert.notEqual(other.device.id, original.device.id);

  const same = await login('Bound phone again', key, original.device.id);
  assert.equal(same.device.id, original.device.id);
});

test("a browser signs its refresh token's binding, and each rotated token needs a new signature", async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Signed browser', key, undefined, 'web');

  const first = await refresh(grant.device.id, grant.refreshToken, await webProof(key, grant.device.id, grant.refreshToken));
  assert.equal(first.statusCode, 200, first.payload);
  const rotated = JSON.parse(first.payload) as Grant;

  const reused = await refresh(grant.device.id, rotated.refreshToken, await webProof(key, grant.device.id, grant.refreshToken));
  assert.equal(reused.statusCode, 401);
});

test("a browser's key cannot prove a phone's payload, and a phone's cannot prove a browser's", async () => {
  now = new Date();
  const browserKey = generateIdentityKeyPair();
  const browser = await login('Browser signing like a phone', browserKey, undefined, 'web');
  const asPhone = await refresh(browser.device.id, browser.refreshToken, proof(browserKey, browser.device.id, browser.refreshToken));
  assert.equal(asPhone.statusCode, 401);
  const browserEvents = await proofEvents(browser.device.id);
  assert.equal(browserEvents[0]?.detail['reason'], 'bad-signature');
  assert.equal(browserEvents[0]?.detail['variant'], 'web');

  const phoneKey = generateIdentityKeyPair();
  const phone = await login('Phone signing like a browser', phoneKey);
  const asBrowser = await refresh(phone.device.id, phone.refreshToken, await webProof(phoneKey, phone.device.id, phone.refreshToken));
  assert.equal(asBrowser.statusCode, 401);
  const phoneEvents = await proofEvents(phone.device.id);
  assert.equal(phoneEvents[0]?.detail['reason'], 'bad-signature');
  assert.equal(phoneEvents[0]?.detail['variant'], 'device');
});

test('an unsigned refresh from a browser with a key revokes its tokens', async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Copied cookie', key, undefined, 'web');

  assert.equal((await refresh(grant.device.id, grant.refreshToken)).statusCode, 401);
  const events = await proofEvents(grant.device.id);
  assert.equal(events[0]?.detail['reason'], 'missing');
  assert.equal(events[0]?.detail['variant'], 'web');
  assert.equal((await refresh(grant.device.id, grant.refreshToken, await webProof(key, grant.device.id, grant.refreshToken))).statusCode, 401);
});

test("a browser's correct signature by a wrong clock is refused without revoking anything", async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Browser with a wrong clock', key, undefined, 'web');

  const skewed = await refresh(
    grant.device.id,
    grant.refreshToken,
    await webProof(key, grant.device.id, grant.refreshToken, new Date(now.getTime() + 10 * 60 * 1000)),
  );
  assert.equal(skewed.statusCode, 400, skewed.payload);
  assert.equal(JSON.parse(skewed.payload).error.code, 'auth.device_clock');

  const corrected = await refresh(grant.device.id, grant.refreshToken, await webProof(key, grant.device.id, grant.refreshToken));
  assert.equal(corrected.statusCode, 200, corrected.payload);
});

test('a sign-in with something other than a P-256 public key is refused and creates no device', async () => {
  const count = async () => Number((await db.query<{ count: string }>('SELECT count(*) AS count FROM user_devices')).rows[0]?.count);
  const before = await count();

  const secp384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  for (const publicKey of ['cHVibGljLWtleQ', secp384, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(86)]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name: 'Bad key', publicKey } },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(JSON.parse(response.payload).error.code, 'validation.failed');
  }
  assert.equal(await count(), before);
});

test('a sign-out records why it happened, and nothing more', async () => {
  now = new Date();
  const key = generateIdentityKeyPair();
  const grant = await login('Browser that lost its key', key, undefined, 'web');

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    payload: { refreshToken: grant.refreshToken, reason: 'device-key-lost' },
  });
  assert.equal(response.statusCode, 204);

  const { rows } = await db.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_logs WHERE action = 'auth.logout' AND device_id = $1`,
    [grant.device.id],
  );
  assert.deepEqual(rows[0]?.target, { reason: 'device-key-lost' });
  assert.ok(!JSON.stringify(rows).includes(grant.refreshToken));

  const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: grant.refreshToken, reason: 'because' } });
  assert.equal(unknown.statusCode, 400);
});

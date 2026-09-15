import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
import { refreshProofPayload } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';

/**
 * Device proof-of-possession on refresh, through the real HTTP app.
 *
 * A device that registered an identity key signs every refresh with it. Without that signature — or with
 * someone else's — the refresh token is treated as copied: every token for the device is revoked and the
 * event is recorded. A correct signature from a wrong clock is refused without revoking anything. A device
 * that registered no key is not asked.
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

async function login(name: string, key: IdentityKeyPair | null, deviceId?: string): Promise<Grant> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      device: { kind: 'android', name, ...(key ? { publicKey: key.publicKey } : {}), ...(deviceId ? { id: deviceId } : {}) },
    },
  });
  assert.equal(response.statusCode, 200, response.payload);
  return JSON.parse(response.payload) as Grant;
}

function proof(key: IdentityKeyPair, deviceId: string, token: string, at: Date = now) {
  const signedAt = at.toISOString();
  return { signedAt, signature: signPayload(key.privateKey, refreshProofPayload(deviceId, token, signedAt)) };
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

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { P256_SPKI_PREFIX } from '@wolf/protocol';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { newId } from '@wolf/shared-types';
import { browserLock, createDeviceKeys, type DeviceKeyStore, type Lock, type StoredDeviceKey } from './device-key.js';
import {
  brokerLogin,
  brokerLogout,
  brokerRefresh,
  brokerRefreshBinding,
  type BrokerResult,
  type BrokerSession,
} from './refresh-broker.js';
import {
  refreshSession,
  signInWithDeviceKey,
  type BrokerPath,
  type SessionDeps,
  type SessionGrant,
} from './session-refresh.js';

/**
 * The dashboard's device proof, end to end: the page's session code with a real WebCrypto key, the
 * broker's decisions, and the real API over HTTP with its real database schema.
 *
 * What stands in for the browser: a cookie jar the broker writes (as the route handlers do), a store
 * that structured-clones the key record (as IndexedDB does), and one lock per "browser" shared by its
 * "tabs" (as Web Locks is). The route handlers themselves only add the CSRF check and the cookies.
 */

const OWNER_EMAIL = 'web-proof-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let api: { apiBaseUrl: string };

class CookieJar {
  session: BrokerSession | null = null;
  /** Every refresh token the cookie ever held, to prove none reached the page. */
  readonly tokens: string[] = [];

  apply(result: BrokerResult): void {
    if (result.session.kind === 'clear') this.session = null;
    if (result.session.kind === 'store') {
      const { refreshToken, deviceId, devicePublicKey } = result.session;
      this.session = { refreshToken, deviceId, devicePublicKey };
      this.tokens.push(refreshToken);
    }
  }
}

function memoryStore(): DeviceKeyStore {
  let record: StoredDeviceKey | null = null;
  return {
    read: async () => (record ? structuredClone(record) : null),
    write: async (next) => {
      record = structuredClone(next);
    },
  };
}

interface Browser {
  readonly jar: CookieJar;
  store: DeviceKeyStore;
  readonly sessionLock: Lock;
  readonly keyLock: Lock;
  /** Everything the broker sent back to the page. */
  readonly seen: unknown[];
}

function newBrowser(): Browser {
  return { jar: new CookieJar(), store: memoryStore(), sessionLock: browserLock('wolf-session'), keyLock: browserLock('wolf-device-key'), seen: [] };
}

/** What `app/api/auth/*` does after its CSRF check: run the broker, write the cookies, answer. */
async function route(browser: Browser, path: BrokerPath, body: unknown): Promise<BrokerResult> {
  const sent = body === undefined ? null : JSON.parse(JSON.stringify(body));
  const result =
    path === '/api/auth/login'
      ? await brokerLogin(sent, null, api)
      : path === '/api/auth/refresh/binding'
        ? await brokerRefreshBinding(browser.jar.session)
        : path === '/api/auth/refresh'
          ? await brokerRefresh(browser.jar.session, sent, api)
          : await brokerLogout(browser.jar.session, sent, api);
  browser.jar.apply(result);
  return result;
}

function tab(
  browser: Browser,
  options: { clock?: () => Date; lock?: Lock; beforePost?: (path: BrokerPath) => Promise<void> } = {},
): SessionDeps {
  return {
    transport: {
      async post(path, body) {
        await options.beforePost?.(path);
        const result = await route(browser, path, body);
        const payload = result.body === null ? null : JSON.parse(JSON.stringify(result.body));
        browser.seen.push(payload);
        return { status: result.status, payload };
      },
    },
    keys: createDeviceKeys(browser.store, browser.keyLock, options.clock),
    lock: options.lock ?? browser.sessionLock,
  };
}

async function signIn(page: SessionDeps): Promise<SessionGrant> {
  const outcome = await signInWithDeviceKey(page, { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test browser' });
  assert.equal(outcome.kind, 'signed-in', JSON.stringify(outcome));
  return (outcome as { grant: SessionGrant }).grant;
}

async function securityEvents(deviceId: string) {
  const { rows } = await db.query<{ type: string; detail: Record<string, unknown> }>(
    `SELECT type, detail FROM security_events WHERE device_id = $1`,
    [deviceId],
  );
  return rows;
}

async function deviceCount(): Promise<number> {
  const { rows } = await db.query<{ count: string | number }>(`SELECT count(*) AS count FROM user_devices`);
  return Number(rows[0]?.count ?? 0);
}

before(async () => {
  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'web-e2e-secret-key-that-is-long-enough-to-pass',
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
  await app.listen({ port: 0, host: '127.0.0.1' });
  api = { apiBaseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('a browser signs in with a key it cannot export, and proves every refresh with it', async () => {
  const browser = newBrowser();
  const page = tab(browser);
  const grant = await signIn(page);

  const key = await page.keys.load();
  const { rows } = await db.query<{ kind: string; public_key: string }>(`SELECT kind, public_key FROM user_devices WHERE id = $1`, [grant.device!.id]);
  assert.equal(rows[0]?.kind, 'web');
  assert.equal(rows[0]?.public_key, key?.publicKeySpki, 'the API holds the public half of the key in this browser');
  assert.equal(key?.privateKey.extractable, false);
  assert.equal(key?.deviceId, grant.device!.id);

  for (let round = 0; round < 3; round += 1) {
    const outcome = await refreshSession(page);
    assert.equal(outcome.kind, 'refreshed', JSON.stringify(outcome));
  }
  assert.equal(browser.jar.tokens.length, 4, 'one sign-in and three rotations');
  assert.deepEqual(await securityEvents(grant.device!.id), []);

  const seen = JSON.stringify(browser.seen);
  for (const token of browser.jar.tokens) assert.ok(!seen.includes(token), 'the page never receives a refresh token');
});

test('signing in again from the same browser keeps its device', async () => {
  const browser = newBrowser();
  const first = await signIn(tab(browser));
  const second = await signIn(tab(browser));
  assert.equal(second.device!.id, first.device!.id);
});

test('tabs refreshing at once take turns, and every one of them gets a token', async () => {
  const browser = newBrowser();
  const grant = await signIn(tab(browser));

  const tabs = Array.from({ length: 4 }, () => tab(browser));
  const outcomes = await Promise.all(tabs.map((each) => refreshSession(each)));
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['refreshed', 'refreshed', 'refreshed', 'refreshed']);
  assert.deepEqual(await securityEvents(grant.device!.id), [], 'no replay, no proof failure');
});

test('a token rotated between asking and signing is retried, not treated as stolen', async () => {
  const browser = newBrowser();
  const grant = await signIn(tab(browser));

  // Another tab — one not sharing the lock, as without Web Locks — refreshes just before this one sends.
  let raced = false;
  const other = tab(browser, { lock: browserLock('elsewhere') });
  const page = tab(browser, {
    beforePost: async (path) => {
      if (path === '/api/auth/refresh' && !raced) {
        raced = true;
        assert.equal((await refreshSession(other)).kind, 'refreshed');
      }
    },
  });

  const outcome = await refreshSession(page);
  assert.ok(raced);
  assert.equal(outcome.kind, 'refreshed', JSON.stringify(outcome));
  assert.ok(
    browser.seen.some((payload) => (payload as { error?: { referenceId?: string } } | null)?.error?.referenceId === 'WOLF-AUTH-SUPERSEDED'),
    'the broker answered the stale signature with a retry',
  );
  assert.deepEqual(await securityEvents(grant.device!.id), []);
});

test('a copied cookie refreshed without the key ends the sign-in, and the attempt is recorded', async () => {
  const browser = newBrowser();
  const page = tab(browser);
  const grant = await signIn(page);
  const copied = { ...browser.jar.session! };

  // Replayed at the broker from somewhere else: no body, so no proof.
  const stolen = await brokerRefresh(copied, null, api);
  assert.equal(stolen.status, 401);

  const events = await securityEvents(grant.device!.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'device-proof-failure');
  assert.equal(events[0]?.detail['reason'], 'missing');
  assert.equal(events[0]?.detail['variant'], 'web');
  assert.ok(!JSON.stringify(events).includes(copied.refreshToken), 'the token never reaches the security log');

  // The rightful browser finds the sign-in gone, and is told why.
  const outcome = await refreshSession(page);
  assert.equal(outcome.kind, 'signed-out');
  assert.equal(browser.jar.session, null);
});

test("a copied cookie signed by another browser's key is refused and revokes the sign-in", async () => {
  const browser = newBrowser();
  const grant = await signIn(tab(browser));
  const copied = { ...browser.jar.session! };

  const attacker = createDeviceKeys(memoryStore(), browserLock('attacker'));
  const attackerKey = await attacker.ensure();
  const binding = (await brokerRefreshBinding(copied)).body as { deviceId: string; binding: string };
  const proof = await attacker.sign(attackerKey, binding.deviceId, binding.binding);

  const forged = await brokerRefresh(copied, { binding: binding.binding, proof }, api);
  assert.equal(forged.status, 401);
  assert.equal(forged.session.kind, 'clear');

  const events = await securityEvents(grant.device!.id);
  assert.equal(events[0]?.detail['reason'], 'bad-signature');
  assert.equal(events[0]?.detail['variant'], 'web');
});

test('a browser that lost its key ends that sign-in plainly, then signs in as a new device', async () => {
  const browser = newBrowser();
  const original = await signIn(tab(browser));
  const oldSession = { ...browser.jar.session! };

  // Site data cleared: the cookie survives, the key does not.
  browser.store = memoryStore();
  const page = tab(browser);

  const outcome = await refreshSession(page);
  assert.equal(outcome.kind, 'signed-out');
  assert.equal((outcome as { problem: { referenceId: string } }).problem.referenceId, 'WOLF-AUTH-KEYLOST');
  assert.equal(browser.jar.session, null, 'the cookie is cleared');

  // Ended as a sign-out with its reason — not as a stolen token.
  assert.deepEqual(await securityEvents(original.device!.id), []);
  const { rows } = await db.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_logs WHERE action = 'auth.logout' AND device_id = $1`,
    [original.device!.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.target['reason'], 'device-key-lost');

  // The old token is revoked: nothing can renew it, key or not.
  assert.equal((await brokerRefresh(oldSession, null, api)).status, 401);

  const again = await signIn(page);
  assert.notEqual(again.device!.id, original.device!.id, 'a new key is a new device');
  assert.equal((await refreshSession(page)).kind, 'refreshed');
});

test('a wrong clock is reported and the sign-in survives it', async () => {
  const browser = newBrowser();
  await signIn(tab(browser));
  const before = browser.jar.session!.refreshToken;

  const slow = tab(browser, { clock: () => new Date(Date.now() - 10 * 60 * 1000) });
  const outcome = await refreshSession(slow);
  assert.equal(outcome.kind, 'failed');
  assert.equal((outcome as { problem: { code: string } }).problem.code, 'auth.device_clock');
  assert.equal(browser.jar.session?.refreshToken, before, 'the cookie is untouched');

  assert.equal((await refreshSession(tab(browser))).kind, 'refreshed');
});

test('the broker will not sign in without a device key, and no device is created', async () => {
  const devices = await deviceCount();

  const without = await brokerLogin({ email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'No key' }, null, api);
  assert.equal(without.status, 400);
  assert.equal((without.body as { error: { referenceId: string } }).error.referenceId, 'WOLF-AUTH-WEBKEY');

  // The right shape, but no point on the curve: the API parses it and refuses.
  const notAKey = await brokerLogin(
    { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Bad key', publicKey: P256_SPKI_PREFIX + 'A'.repeat(86) },
    null,
    api,
  );
  assert.equal(notAKey.status, 400);
  assert.equal(notAKey.session.kind, 'keep');

  assert.equal(await deviceCount(), devices);
});

test('a malformed proof is refused at the broker and nothing is revoked', async () => {
  const browser = newBrowser();
  const page = tab(browser);
  await signIn(page);

  const malformed = await brokerRefresh(browser.jar.session, { binding: 'family.token.secret', proof: {} }, api);
  assert.equal(malformed.status, 400);
  assert.equal((malformed.body as { error: { referenceId: string } }).error.referenceId, 'WOLF-AUTH-PROOFBODY');
  assert.equal((await refreshSession(page)).kind, 'refreshed');
});

test('a sign-in from before the dashboard registered keys is ended, not refreshed unsigned', async () => {
  const response = await fetch(`${api.apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name: 'Old browser' } }),
  });
  const legacy = (await response.json()) as { refreshToken: string; device: { id: string } };

  const browser = newBrowser();
  browser.jar.session = { refreshToken: legacy.refreshToken, deviceId: legacy.device.id, devicePublicKey: null };
  const page = tab(browser);
  await page.keys.ensure();

  const outcome = await refreshSession(page);
  assert.equal(outcome.kind, 'signed-out');
  assert.equal((outcome as { problem: { referenceId: string } }).problem.referenceId, 'WOLF-AUTH-KEYLOST');
  assert.deepEqual(await securityEvents(legacy.device.id), []);
});

test('a browser that cannot keep a key is refused before its password is sent', async () => {
  const devices = await deviceCount();
  const browser = newBrowser();
  browser.store = { read: async () => null, write: async () => undefined };

  const outcome = await signInWithDeviceKey(tab(browser), { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Private window' });
  assert.equal(outcome.kind, 'refused');
  assert.equal((outcome as { problem: { referenceId: string } }).problem.referenceId, 'WOLF-AUTH-KEYPERSIST');
  assert.deepEqual(browser.seen, [], 'nothing was posted');
  assert.equal(await deviceCount(), devices);
});

test('with no session there is nothing to refresh and nothing to report', async () => {
  const outcome = await refreshSession(tab(newBrowser()));
  assert.deepEqual(outcome, { kind: 'signed-out', problem: null });
});

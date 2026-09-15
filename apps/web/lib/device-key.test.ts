import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, createVerify, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { P256_SPKI_PREFIX, webRefreshProofPayload } from '@wolf/protocol/device-proof';
import {
  DeviceKeyError,
  browserLock,
  createDeviceKeys,
  ecdsaSignatureToDer,
  generateDeviceKey,
  indexedDbDeviceKeyStore,
  type DeviceKeyStore,
  type StoredDeviceKey,
} from './device-key.js';

/**
 * The browser's device key, under Node's WebCrypto — the same API, and the same raw r‖s signatures,
 * a browser gives. What only a browser has (IndexedDB keeping a non-extractable key across loads, Web
 * Locks) is exercised by the browser harness in services/e2e.
 */

const DEVICE = '01J9ZQK7T0000000000000000D';
const BINDING = 'rT4NFl6b8Vr_lezENu5yr2HFdm9rFz7nvxXk-stlhPc';

/** A store that keeps the record the way IndexedDB does: a structured clone, not the object itself. */
function memoryStore(): DeviceKeyStore & { writes: number; record: StoredDeviceKey | null } {
  const store = {
    writes: 0,
    record: null as StoredDeviceKey | null,
    async read() {
      return store.record ? structuredClone(store.record) : null;
    },
    async write(record: StoredDeviceKey) {
      store.writes += 1;
      store.record = structuredClone(record);
    },
  };
  return store;
}

function verifies(publicKeySpki: string, payload: string, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeySpki, 'base64url'), format: 'der', type: 'spki' });
  return createVerify('sha256').update(payload, 'utf8').verify(key, Buffer.from(signature, 'base64url'));
}

test('a device key is P-256, and its private half cannot be exported', async () => {
  const key = await generateDeviceKey();

  assert.equal(key.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', key.privateKey));
  await assert.rejects(crypto.subtle.exportKey('jwk', key.privateKey));

  assert.ok(key.publicKeySpki.startsWith(P256_SPKI_PREFIX));
  assert.equal(Buffer.from(key.publicKeySpki, 'base64url').length, 91);
  const parsed = createPublicKey({ key: Buffer.from(key.publicKeySpki, 'base64url'), format: 'der', type: 'spki' });
  assert.equal(parsed.asymmetricKeyDetails?.namedCurve, 'prime256v1');
});

test("a WebCrypto signature, converted to DER, verifies with the server's verifier", async () => {
  const keys = createDeviceKeys(memoryStore(), browserLock('test'), () => new Date('2026-09-15T10:00:00.123Z'));
  const key = await keys.ensure();
  const proof = await keys.sign(key, DEVICE, BINDING);

  assert.equal(proof.signedAt, '2026-09-15T10:00:00.123Z');
  assert.match(proof.signature, /^[A-Za-z0-9_-]+$/);
  assert.equal(verifies(key.publicKeySpki, webRefreshProofPayload(DEVICE, BINDING, proof.signedAt), proof.signature), true);

  // Bound to what was signed: another binding, device or time does not verify.
  assert.equal(verifies(key.publicKeySpki, webRefreshProofPayload(DEVICE, BINDING.replace('r', 's'), proof.signedAt), proof.signature), false);
  assert.equal(verifies(key.publicKeySpki, webRefreshProofPayload('01J9ZQK7T0000000000000000E', BINDING, proof.signedAt), proof.signature), false);
  assert.equal(verifies(key.publicKeySpki, webRefreshProofPayload(DEVICE, BINDING, '2026-09-15T10:00:00.124Z'), proof.signature), false);
});

test('raw r‖s becomes minimal DER integers, padded where the top bit is set', () => {
  const raw = new Uint8Array(64);
  raw[31] = 0x01; // r = 1: thirty-one leading zero bytes dropped
  raw[32] = 0x80; // s has its top bit set: a zero byte added
  const der = ecdsaSignatureToDer(raw);

  assert.deepEqual(
    Array.from(der),
    [0x30, 3 + 35, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00, 0x80, ...new Array(31).fill(0)],
  );

  const zero = ecdsaSignatureToDer(new Uint8Array(64));
  assert.deepEqual(Array.from(zero), [0x30, 6, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00], 'a zero integer keeps one byte');

  assert.throws(() => ecdsaSignatureToDer(new Uint8Array(63)), DeviceKeyError);
});

test('the conversion agrees with Node for every shape of signature it produces', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (let round = 0; round < 400; round += 1) {
    const data = Buffer.from(`payload ${round}`);
    const raw = nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const der = Buffer.from(ecdsaSignatureToDer(new Uint8Array(raw)));

    assert.equal(createVerify('sha256').update(data).verify({ key: publicKey, dsaEncoding: 'der' }, der), true, `round ${round}`);
    // Minimal integers: no leading zero byte unless the next byte's top bit needs it.
    for (let offset = 2; offset < der.length; offset += 2 + der[offset + 1]!) {
      assert.equal(der[offset], 0x02);
      if (der[offset + 1]! > 1 && der[offset + 2] === 0) assert.ok(der[offset + 3]! & 0x80, `round ${round}: padded needlessly`);
    }
  }
});

test('ensure makes one key, keeps it, and hands the same one back afterwards', async () => {
  const store = memoryStore();
  const keys = createDeviceKeys(store, browserLock('test'));

  const first = await keys.ensure();
  const second = await keys.ensure();
  assert.equal(second.publicKeySpki, first.publicKeySpki);
  assert.equal(store.writes, 1);
  assert.equal((await keys.load())?.publicKeySpki, first.publicKeySpki);
});

test('tabs signing in at once under the shared lock end up with one key', async () => {
  const store = memoryStore();
  const lock = browserLock('shared');
  const tabs = Array.from({ length: 5 }, () => createDeviceKeys(store, lock));

  const made = await Promise.all(tabs.map((tab) => tab.ensure()));
  assert.equal(new Set(made.map((key) => key.publicKeySpki)).size, 1);
  assert.equal(store.writes, 1);
});

test('a key the storage did not keep is refused, not handed back as if it were', async () => {
  const forgetful: DeviceKeyStore = { read: async () => null, write: async () => undefined };
  const keys = createDeviceKeys(forgetful, browserLock('test'));

  await assert.rejects(keys.ensure(), (error: unknown) => {
    assert.ok(error instanceof DeviceKeyError);
    assert.equal(error.failure, 'not-persisted');
    assert.equal(error.problem.referenceId, 'WOLF-AUTH-KEYPERSIST');
    assert.ok(error.problem.cause && error.problem.currentState && error.problem.recommendedAction);
    return true;
  });
});

test('storage that throws is reported as unavailable storage', async () => {
  const broken: DeviceKeyStore = {
    read: async () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    write: async () => undefined,
  };
  await assert.rejects(createDeviceKeys(broken, browserLock('test')).load(), (error: unknown) => {
    assert.ok(error instanceof DeviceKeyError);
    assert.equal(error.failure, 'storage-unavailable');
    assert.match(error.problem.cause, /SecurityError/);
    return true;
  });
});

test('without IndexedDB the store says so instead of pretending it holds nothing', async () => {
  await assert.rejects(indexedDbDeviceKeyStore(() => undefined).read(), (error: unknown) => {
    assert.ok(error instanceof DeviceKeyError);
    assert.equal(error.problem.referenceId, 'WOLF-AUTH-KEYSTORE');
    return true;
  });
});

test('a record that is not a usable key is not loaded, and ensure replaces it', async () => {
  const store = memoryStore();
  const exportable = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const valid = await generateDeviceKey();
  store.record = { ...valid, privateKey: exportable.privateKey };

  const keys = createDeviceKeys(store, browserLock('test'));
  assert.equal(await keys.load(), null, 'an exportable private key is not a device key');

  const replaced = await keys.ensure();
  assert.equal(replaced.privateKey.extractable, false);
});

test('a device id is recorded only against the key that is still stored', async () => {
  const store = memoryStore();
  const keys = createDeviceKeys(store, browserLock('test'));
  const key = await keys.ensure();

  await keys.bind('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'B'.repeat(86), DEVICE);
  assert.equal((await keys.load())?.deviceId, null);

  await keys.bind(key.publicKeySpki, DEVICE);
  assert.equal((await keys.load())?.deviceId, DEVICE);
});

test('without Web Locks, work in this tab still takes turns', async () => {
  const lock = browserLock('fallback');
  const order: string[] = [];
  const slow = lock(async () => {
    order.push('a-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a-end');
  });
  const fast = lock(async () => {
    order.push('b');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('with Web Locks, the browser lock is the one used', async () => {
  const requested: string[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request: (name: string, _options: unknown, task: () => Promise<unknown>) => {
          requested.push(name);
          return task();
        },
      },
    },
  });
  try {
    assert.equal(await browserLock('wolf-session')(async () => 42), 42);
    assert.deepEqual(requested, ['wolf-session']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

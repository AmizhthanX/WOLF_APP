import { base64UrlEncode, hasP256SpkiShape, webRefreshProofPayload } from '@wolf/protocol/device-proof';
import type { WolfProblem } from './problem.js';

/**
 * This browser's WOLF device key.
 *
 * An ECDSA P-256 key made by WebCrypto with its private half marked non-extractable, and kept in
 * IndexedDB — which stores the key object itself, not its bytes. Page JavaScript can ask the browser to
 * sign with it; nothing, this code included, can read it out. The public half is registered at sign-in,
 * and every refresh after that must carry the key's signature, so the refresh cookie on its own — copied
 * out of a profile, a backup, or a proxy log — no longer renews anything.
 *
 * What it is not: hardware-backed. Browsers keep these keys in the profile on disk, protected as well as
 * the rest of the profile and no better, so malware with the profile can take the key along with the
 * cookie. And script running in the page — an XSS bug — can have it sign while it runs, though it cannot
 * carry the key away. The security model states both.
 *
 * If the key is gone — site data cleared, storage evicted, a different profile — the sign-in bound to
 * it cannot be proven again. The session code then ends that sign-in and asks for a new one, which
 * registers a new key as a new device. Nothing falls back to an unsigned refresh.
 */

export interface StoredDeviceKey {
  /** Non-extractable. Usable only for `sign`. */
  readonly privateKey: CryptoKey;
  /** SPKI DER, base64url: what the API stores. */
  readonly publicKeySpki: string;
  /** The device the API bound this key to at the last sign-in, so signing in again keeps the same device. */
  readonly deviceId: string | null;
  readonly createdAt: string;
}

/** Where the key record lives. One record per browser profile and origin. */
export interface DeviceKeyStore {
  read(): Promise<StoredDeviceKey | null>;
  write(record: StoredDeviceKey): Promise<void>;
}

/** Runs a task while holding a lock, so tabs of this origin take turns. */
export type Lock = <T>(task: () => Promise<T>) => Promise<T>;

export interface DeviceProofSignature {
  readonly signedAt: string;
  readonly signature: string;
}

export interface DeviceKeys {
  /** The key this browser holds, or null when it holds none it can sign with. */
  load(): Promise<StoredDeviceKey | null>;
  /** The key this browser holds, made and stored first if it holds none. Fails rather than hand back a key that was not kept. */
  ensure(): Promise<StoredDeviceKey>;
  /** Record the device a sign-in bound the key to. Only for the key that is still stored. */
  bind(publicKeySpki: string, deviceId: string): Promise<void>;
  /** Sign a web refresh proof for the binding the broker handed out. */
  sign(key: StoredDeviceKey, deviceId: string, binding: string): Promise<DeviceProofSignature>;
}

export type DeviceKeyFailure = 'crypto-unavailable' | 'storage-unavailable' | 'not-persisted' | 'signing-failed';

/** A device-key operation that did not happen, and why. `problem` describes it at sign-in. */
export class DeviceKeyError extends Error {
  readonly failure: DeviceKeyFailure;
  readonly problem: WolfProblem;

  constructor(failure: DeviceKeyFailure, detail: string) {
    super(`${failure}: ${detail}`);
    this.name = 'DeviceKeyError';
    this.failure = failure;
    this.problem = deviceKeyProblem(failure, detail);
  }
}

const NOT_SIGNED_IN = 'You are not signed in. Nothing was sent to WOLF.';

function deviceKeyProblem(failure: DeviceKeyFailure, detail: string): WolfProblem {
  switch (failure) {
    case 'crypto-unavailable':
      return {
        code: 'device.key_unavailable',
        problem: 'This browser cannot create a WOLF device key.',
        cause: `WebCrypto could not make a non-exportable P-256 key (${detail}). Browsers offer it only on HTTPS pages and on localhost.`,
        currentState: NOT_SIGNED_IN,
        recommendedAction: 'Open the dashboard over HTTPS in an up-to-date browser, then sign in.',
        referenceId: 'WOLF-AUTH-WEBCRYPTO',
        httpStatus: 0,
      };
    case 'storage-unavailable':
      return {
        code: 'device.key_storage',
        problem: 'This browser cannot keep a WOLF device key.',
        cause: `Its site storage could not be used (${detail}). Some private windows and privacy settings block it.`,
        currentState: NOT_SIGNED_IN,
        recommendedAction: 'Allow this site to store data, or use a normal window, then try again.',
        referenceId: 'WOLF-AUTH-KEYSTORE',
        httpStatus: 0,
      };
    case 'not-persisted':
      return {
        code: 'device.key_not_kept',
        problem: 'This browser did not keep its WOLF device key.',
        cause: `The key was written to site storage but did not read back (${detail}), so it would be gone before the next refresh.`,
        currentState: NOT_SIGNED_IN,
        recommendedAction: 'Allow this site to store data, or use a normal window, then sign in again.',
        referenceId: 'WOLF-AUTH-KEYPERSIST',
        httpStatus: 0,
      };
    case 'signing-failed':
      return {
        code: 'device.key_signing',
        problem: 'This browser could not sign with its WOLF device key.',
        cause: `The browser refused to sign (${detail}).`,
        currentState: NOT_SIGNED_IN,
        recommendedAction: 'Reload the dashboard and try again. If it repeats, sign out and sign in again.',
        referenceId: 'WOLF-AUTH-KEYSIGN',
        httpStatus: 0,
      };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

const KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGNATURE_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DeviceKeyError(
      'crypto-unavailable',
      globalThis.isSecureContext === false ? 'this page is not a secure context' : 'crypto.subtle is missing',
    );
  }
  return subtle;
}

/** A new key whose private half the browser will not export. */
export async function generateDeviceKey(now: Date = new Date()): Promise<StoredDeviceKey> {
  const subtle = subtleCrypto();
  let pair: CryptoKeyPair;
  try {
    pair = await subtle.generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
  } catch (error) {
    throw new DeviceKeyError('crypto-unavailable', describe(error));
  }
  if (pair.privateKey.extractable) {
    throw new DeviceKeyError('crypto-unavailable', 'the browser made the private key exportable');
  }

  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeySpki: base64UrlEncode(spki),
    deviceId: null,
    createdAt: now.toISOString(),
  };
}

/** A record this code can sign with: a non-extractable ECDSA private key and a P-256 public key to match. */
function isUsable(record: StoredDeviceKey | null | undefined): record is StoredDeviceKey {
  return Boolean(
    record &&
      record.privateKey &&
      record.privateKey.type === 'private' &&
      record.privateKey.algorithm?.name === 'ECDSA' &&
      record.privateKey.extractable === false &&
      record.privateKey.usages.includes('sign') &&
      typeof record.publicKeySpki === 'string' &&
      hasP256SpkiShape(record.publicKeySpki),
  );
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DeviceKeyError) throw error;
    throw new DeviceKeyError('storage-unavailable', describe(error));
  }
}

/**
 * WebCrypto returns an ECDSA signature as r‖s, 32 bytes each for P-256. Every WOLF verifier expects the
 * DER form — SEQUENCE { INTEGER r, INTEGER s } — which is what Node, .NET and the Android Keystore write.
 * Each integer is minimal: leading zero bytes dropped, one zero byte added back if the top bit is set so
 * it does not read as negative.
 */
export function ecdsaSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) {
    throw new DeviceKeyError('signing-failed', `a P-256 signature is 64 bytes, and this one is ${raw.length}`);
  }

  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = Array.from(bytes.subarray(start));
    if ((body[0] ?? 0) & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };

  const r = integer(raw.subarray(0, 32));
  const s = integer(raw.subarray(32));
  // At most 2 × (2 + 33) = 70 bytes, so the length always fits the short form.
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export function createDeviceKeys(store: DeviceKeyStore, lock: Lock, clock: () => Date = () => new Date()): DeviceKeys {
  const read = () => guarded(() => store.read());

  return {
    async load() {
      const record = await read();
      return isUsable(record) ? record : null;
    },

    ensure() {
      // Under a lock: two tabs signing in at once must not each make a key and leave one stored that
      // the other registered.
      return lock(async () => {
        const existing = await read();
        if (isUsable(existing)) return existing;

        const created = await generateDeviceKey(clock());
        await guarded(() => store.write(created));

        // Read it back. A private window or a storage policy can accept a write and keep nothing; a key
        // that is not really kept would register a device this browser cannot prove on its next visit.
        const kept = await read();
        if (!isUsable(kept) || kept.publicKeySpki !== created.publicKeySpki) {
          throw new DeviceKeyError('not-persisted', kept ? 'a different record was read back' : 'nothing was read back');
        }
        return kept;
      });
    },

    bind(publicKeySpki, deviceId) {
      return lock(async () => {
        const record = await read();
        if (!isUsable(record) || record.publicKeySpki !== publicKeySpki || record.deviceId === deviceId) return;
        await guarded(() => store.write({ ...record, deviceId }));
      });
    },

    async sign(key, deviceId, binding) {
      const signedAt = clock().toISOString();
      const payload = new TextEncoder().encode(webRefreshProofPayload(deviceId, binding, signedAt));
      let raw: ArrayBuffer;
      try {
        raw = await subtleCrypto().sign(SIGNATURE_ALGORITHM, key.privateKey, payload);
      } catch (error) {
        if (error instanceof DeviceKeyError) throw error;
        throw new DeviceKeyError('signing-failed', describe(error));
      }
      return { signedAt, signature: base64UrlEncode(ecdsaSignatureToDer(new Uint8Array(raw))) };
    },
  };
}

export const DEVICE_KEY_DATABASE = 'wolf-device';
const OBJECT_STORE = 'identity';
const RECORD_KEY = 'device-key';

/**
 * The key record in IndexedDB.
 *
 * The factory is looked up per call, not at import: this module is also evaluated while the dashboard
 * renders on the server, where there is no IndexedDB and nothing should be touched.
 */
export function indexedDbDeviceKeyStore(factory: () => IDBFactory | undefined = () => globalThis.indexedDB): DeviceKeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const idb = factory();
      if (!idb) {
        reject(new DeviceKeyError('storage-unavailable', 'IndexedDB is not available'));
        return;
      }
      try {
        const request = idb.open(DEVICE_KEY_DATABASE, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(OBJECT_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new DeviceKeyError('storage-unavailable', describe(request.error)));
        request.onblocked = () =>
          reject(new DeviceKeyError('storage-unavailable', 'another tab holds an older copy of the key database open'));
      } catch (error) {
        reject(new DeviceKeyError('storage-unavailable', describe(error)));
      }
    });

  const run = async <T>(mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest | undefined): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        try {
          const transaction = db.transaction(OBJECT_STORE, mode);
          const request = work(transaction.objectStore(OBJECT_STORE));
          // Resolved on commit, not on the request's success: a write is kept only once the transaction is.
          transaction.oncomplete = () => resolve((request ? request.result : undefined) as T);
          transaction.onerror = () => reject(new DeviceKeyError('storage-unavailable', describe(transaction.error)));
          transaction.onabort = () =>
            reject(new DeviceKeyError('storage-unavailable', describe(transaction.error ?? 'the transaction was aborted')));
        } catch (error) {
          reject(new DeviceKeyError('storage-unavailable', describe(error)));
        }
      });
    } finally {
      db.close();
    }
  };

  return {
    read: async () => (await run<StoredDeviceKey | undefined>('readonly', (objects) => objects.get(RECORD_KEY))) ?? null,
    write: (record) =>
      run<void>('readwrite', (objects) => {
        objects.put(record, RECORD_KEY);
        return undefined;
      }),
  };
}

/**
 * A lock shared by every tab of this origin.
 *
 * Web Locks where the browser has them — every current browser does. Without them, tabs are not
 * coordinated and only calls within this tab take turns; the broker's binding check then turns a
 * collision into a retry rather than a revoked sign-in, and the security model says so.
 */
export function browserLock(name: string): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
    if (locks) return locks.request(name, { mode: 'exclusive' }, task) as Promise<T>;

    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Ask the browser not to evict this origin's storage. Best effort: a browser may say no, and that is not a failure. */
export async function askToKeepStorage(): Promise<boolean> {
  try {
    return (await globalThis.navigator?.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Sortable, URL-safe identifiers (ULID-style: 48-bit timestamp + 80 bits of entropy,
 * Crockford base32). Lexicographic order matches creation order, which keeps
 * time-partitioned Postgres tables and cursor pagination cheap.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** Branded id type so a PcId can never be passed where a DeviceId is expected. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WolfId = string;
export type UserId = Brand<string, 'UserId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type PcId = Brand<string, 'PcId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type AuditId = Brand<string, 'AuditId'>;
export type RequestId = Brand<string, 'RequestId'>;

const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    const mod = time % 32;
    out = CROCKFORD[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_CHARS);
  // Web Crypto rather than `node:crypto`: identical entropy, and the same call works in
  // Node and in the browser. The dashboard mints stream ids, and a Node-only import here
  // would either fail to bundle or be silently polyfilled with something weaker.
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    // Rejection-free: map each byte into 32 buckets. The tiny modulo bias over 80 bits
    // of entropy is irrelevant for collision resistance here.
    out += CROCKFORD[bytes[i]! % 32];
  }
  return out;
}

/** Generate a new sortable WOLF identifier. */
export function newId<T extends WolfId = WolfId>(now: number = Date.now()): T {
  return (encodeTime(now) + encodeRandom()) as T;
}

/** True when `value` is a syntactically valid WOLF identifier. */
export function isWolfId(value: unknown): value is WolfId {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Extract the creation time encoded in a WOLF identifier. */
export function idTimestamp(id: WolfId): Date {
  let time = 0;
  for (let i = 0; i < TIME_CHARS; i++) {
    const index = CROCKFORD.indexOf(id[i]!);
    if (index < 0) throw new Error('Invalid WOLF identifier');
    time = time * 32 + index;
  }
  return new Date(time);
}

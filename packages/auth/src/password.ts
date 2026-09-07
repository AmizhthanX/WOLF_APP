import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to the three-argument overload, which drops the cost parameters.
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing for the single owner account.
 *
 * scrypt is used rather than a native Argon2 binding: it is memory-hard, it ships with
 * Node, and it therefore adds no compiled dependency to a build that has to run on
 * Windows, Cloud Run, and CI alike. Parameters are stored inside the encoded hash, so they
 * can be raised later without invalidating existing credentials.
 */

export interface ScryptParameters {
  /** CPU/memory cost. Must be a power of two. */
  readonly cost: number;
  /** Block size. */
  readonly blockSize: number;
  /** Parallelization. */
  readonly parallelization: number;
  /** Derived key length in bytes. */
  readonly keyLength: number;
}

/** ~64 MiB of memory per hash (128 * r * N), a deliberate cost for an interactive login. */
export const CURRENT_PARAMETERS: ScryptParameters = Object.freeze({
  cost: 2 ** 16,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
});

const SALT_BYTES = 16;
const PREFIX = 'scrypt';

/** scrypt needs maxmem above the default 32 MiB for these parameters. */
function maxmem(params: ScryptParameters): number {
  return 256 * params.cost * params.blockSize;
}

/** Hash a password into a self-describing string safe to store in the database. */
export async function hashPassword(
  password: string,
  params: ScryptParameters = CURRENT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password.normalize('NFKC'), salt, params.keyLength, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    maxmem: maxmem(params),
  }));

  return [
    PREFIX,
    params.cost,
    params.blockSize,
    params.parallelization,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  readonly params: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) {
    return null;
  }
  // Bound the parameters read from storage: a tampered row must not be able to make the
  // verifier allocate arbitrary memory.
  if (cost < 2 ** 12 || cost > 2 ** 20 || blockSize < 1 || blockSize > 32) return null;
  if (parallelization < 1 || parallelization > 16) return null;

  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const hash = Buffer.from(parts[5]!, 'base64url');
    if (salt.length === 0 || hash.length === 0) return null;
    return {
      params: { cost, blockSize, parallelization, keyLength: hash.length },
      salt,
      hash,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a password against a stored hash in constant time.
 *
 * Returns false for malformed stored hashes rather than throwing, so a corrupted row
 * cannot be distinguished from a wrong password by an attacker watching error behaviour.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;

  const derived = (await scrypt(password.normalize('NFKC'), parsed.salt, parsed.params.keyLength, {
    N: parsed.params.cost,
    r: parsed.params.blockSize,
    p: parsed.params.parallelization,
    maxmem: maxmem(parsed.params),
  }));

  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/** True when the stored hash uses weaker parameters than the current policy. */
export function needsRehash(encoded: string, params: ScryptParameters = CURRENT_PARAMETERS): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  return (
    parsed.params.cost < params.cost ||
    parsed.params.blockSize < params.blockSize ||
    parsed.params.keyLength < params.keyLength
  );
}

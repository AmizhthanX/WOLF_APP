import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Refresh tokens.
 *
 * A refresh token is opaque, single-use, and belongs to a family. Every use rotates it:
 * the presented token is retired and a successor is issued. If a retired token is ever
 * presented again, the token was copied, so the entire family is revoked and the device
 * must sign in again. That is the whole point of rotation — detection, not just expiry.
 *
 * Storage keeps only a SHA-256 of the secret half, so a database disclosure does not hand
 * an attacker usable refresh tokens.
 */

const SECRET_BYTES = 32;

export interface RefreshTokenMaterial {
  /** Value handed to the client. Never stored. */
  readonly token: string;
  /** Family the token belongs to; shared by every rotation of one device's session. */
  readonly familyId: string;
  /** This token's own id, stored alongside the hash. */
  readonly tokenId: string;
  /** SHA-256 of the secret, base64url. This is what gets persisted. */
  readonly secretHash: string;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/** Mint a new refresh token, optionally continuing an existing family. */
export function createRefreshToken(familyId?: string): RefreshTokenMaterial {
  const family = familyId ?? randomBytes(16).toString('base64url');
  const tokenId = randomBytes(16).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `${family}.${tokenId}.${secret}`,
    familyId: family,
    tokenId,
    secretHash: hashSecret(secret),
  };
}

export interface ParsedRefreshToken {
  readonly familyId: string;
  readonly tokenId: string;
  readonly secret: string;
}

export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [familyId, tokenId, secret] = parts as [string, string, string];
  if (!familyId || !tokenId || !secret) return null;
  return { familyId, tokenId, secret };
}

/** Stored representation of one issued refresh token. */
export interface StoredRefreshToken {
  readonly tokenId: string;
  readonly familyId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly secretHash: string;
  readonly expiresAt: Date;
  /** Set once the token has been rotated or explicitly revoked. */
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type RefreshDecision =
  | { readonly outcome: 'rotate'; readonly stored: StoredRefreshToken }
  | { readonly outcome: 'reject'; readonly reason: RefreshRejection }
  /** The token was already used: treat as theft and revoke every token in the family. */
  | { readonly outcome: 'revoke-family'; readonly familyId: string };

export type RefreshRejection =
  | 'malformed'
  | 'unknown'
  | 'expired'
  | 'revoked'
  | 'bad-secret'
  | 'device-mismatch';

export interface EvaluateRefreshOptions {
  /** Token as presented by the client. */
  readonly token: string;
  /** Stored record for the presented token id, or null when no such record exists. */
  readonly stored: StoredRefreshToken | null;
  /** Device the request authenticated as, to stop a token being replayed from elsewhere. */
  readonly deviceId: string;
  readonly now?: Date;
}

/**
 * Decide what to do with a presented refresh token. Pure: the caller performs the storage
 * writes the decision implies.
 */
export function evaluateRefresh(options: EvaluateRefreshOptions): RefreshDecision {
  const parsed = parseRefreshToken(options.token);
  if (!parsed) return { outcome: 'reject', reason: 'malformed' };

  const stored = options.stored;
  if (!stored || stored.tokenId !== parsed.tokenId || stored.familyId !== parsed.familyId) {
    return { outcome: 'reject', reason: 'unknown' };
  }

  const providedHash = Buffer.from(hashSecret(parsed.secret), 'base64url');
  const storedHash = Buffer.from(stored.secretHash, 'base64url');
  const secretMatches =
    providedHash.length === storedHash.length && timingSafeEqual(providedHash, storedHash);

  if (!secretMatches) {
    // A wrong secret for a real token id is not a rotation replay; it is a guess.
    return { outcome: 'reject', reason: 'bad-secret' };
  }

  if (stored.consumedAt !== null) {
    // Correct secret, already-consumed token: the token leaked. Burn the family.
    return { outcome: 'revoke-family', familyId: stored.familyId };
  }
  if (stored.revokedAt !== null) return { outcome: 'reject', reason: 'revoked' };
  if (stored.deviceId !== options.deviceId) {
    return { outcome: 'reject', reason: 'device-mismatch' };
  }

  const now = options.now ?? new Date();
  if (stored.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'reject', reason: 'expired' };
  }

  return { outcome: 'rotate', stored };
}

/** Hash a refresh secret for storage or lookup. Exposed for repository implementations. */
export function refreshSecretHash(secret: string): string {
  return hashSecret(secret);
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionCapability } from '@wolf/shared-types';

/**
 * Access tokens.
 *
 * Short-lived, signed, and stateless so that every API instance can verify one without a
 * database round trip. Long-lived authority lives in refresh tokens, which are opaque,
 * stored hashed, rotated on every use, and revocable per device.
 *
 * The signing algorithm is HMAC-SHA-256 over a compact JWS. `TokenSigner` is an interface
 * so an asymmetric signer (KMS, Cloud HSM) can replace the shared secret without touching
 * any call site.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 600;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Clock skew tolerated when validating `nbf` and `exp`. */
const CLOCK_SKEW_SECONDS = 30;

export interface AccessTokenClaims {
  /** Subject: the owner account id. */
  sub: string;
  /** Device the token was issued to. Tokens are never valid across devices. */
  did: string;
  /** Session id, when the token is scoped to a PC session. */
  sid?: string;
  /** PC id, when the token is scoped to a PC session. */
  pid?: string;
  /** Capabilities granted to this token. Absent means account-level access only. */
  cap?: SessionCapability[];
  /** Unix seconds when the user last proved their password. Drives high-risk re-auth. */
  auth_time: number;
  /** Token identifier, logged for correlation and replay detection. */
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
}

export interface TokenSigner {
  readonly algorithm: string;
  sign(data: string): string;
  verify(data: string, signature: string): boolean;
}

/** HMAC-SHA-256 signer. The secret must be at least 32 bytes of real entropy. */
export function createHmacSigner(secret: string | Buffer): TokenSigner {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (key.length < 32) {
    throw new Error('Token signing secret must be at least 32 bytes.');
  }
  return {
    algorithm: 'HS256',
    sign(data: string): string {
      return createHmac('sha256', key).update(data).digest('base64url');
    },
    verify(data: string, signature: string): boolean {
      const expected = createHmac('sha256', key).update(data).digest();
      let provided: Buffer;
      try {
        provided = Buffer.from(signature, 'base64url');
      } catch {
        return false;
      }
      return expected.length === provided.length && timingSafeEqual(expected, provided);
    },
  };
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export interface IssueAccessTokenOptions {
  signer: TokenSigner;
  issuer: string;
  audience: string;
  subject: string;
  deviceId: string;
  authTime: number;
  sessionId?: string;
  pcId?: string;
  capabilities?: readonly SessionCapability[];
  ttlSeconds?: number;
  now?: number;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: Date;
}

export function issueAccessToken(options: IssueAccessTokenOptions): IssuedAccessToken {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const ttl = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const jti = randomBytes(16).toString('base64url');

  const claims: AccessTokenClaims = {
    sub: options.subject,
    did: options.deviceId,
    auth_time: options.authTime,
    jti,
    iss: options.issuer,
    aud: options.audience,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + ttl,
    ...(options.sessionId ? { sid: options.sessionId } : {}),
    ...(options.pcId ? { pid: options.pcId } : {}),
    ...(options.capabilities?.length ? { cap: [...options.capabilities] } : {}),
  };

  const header = encodeSegment({ alg: options.signer.algorithm, typ: 'JWT' });
  const payload = encodeSegment(claims);
  const signingInput = `${header}.${payload}`;
  const signature = options.signer.sign(signingInput);

  return {
    token: `${signingInput}.${signature}`,
    jti,
    expiresAt: new Date((nowSeconds + ttl) * 1000),
  };
}

export type TokenRejection =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'unsupported-algorithm';

export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: TokenRejection };

export interface VerifyOptions {
  signer: TokenSigner;
  issuer: string;
  audience: string;
  now?: number;
}

export function verifyAccessToken(token: string, options: VerifyOptions): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];

  let decodedHeader: { alg?: unknown; typ?: unknown };
  try {
    decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // Pinned to the configured algorithm: accepting the token's own `alg` is how "none" and
  // algorithm-confusion attacks get in.
  if (decodedHeader.alg !== options.signer.algorithm) {
    return { ok: false, reason: 'unsupported-algorithm' };
  }

  if (!options.signer.verify(`${header}.${payload}`, signature)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.did !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.nbf !== 'number' ||
    typeof claims.auth_time !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.iss !== options.issuer) return { ok: false, reason: 'wrong-issuer' };
  if (claims.aud !== options.audience) return { ok: false, reason: 'wrong-audience' };

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (nowSeconds + CLOCK_SKEW_SECONDS < claims.nbf) return { ok: false, reason: 'not-yet-valid' };
  if (nowSeconds - CLOCK_SKEW_SECONDS >= claims.exp) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

/** True when the password re-authentication behind this token is fresh enough. */
export function reauthIsFresh(
  claims: AccessTokenClaims,
  maxAgeSeconds: number,
  now: number = Date.now(),
): boolean {
  return Math.floor(now / 1000) - claims.auth_time <= maxAgeSeconds;
}

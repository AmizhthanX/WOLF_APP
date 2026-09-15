import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

/**
 * Cryptographic identity for PCs and client devices.
 *
 * Every PC and every authorized device holds its own key pair. The private key never
 * leaves the machine — on Windows it is protected by DPAPI, on Android by the platform
 * keystore. The cloud stores only the public key, so revoking one machine's trust never
 * touches any other.
 *
 * The algorithm is ECDSA on P-256 with SHA-256, encoded as SPKI/PKCS#8 with DER
 * signatures. That combination is implemented natively by both Node and .NET, which keeps
 * a third-party crypto library out of the privileged Windows agent; the same encodings map
 * directly onto `ECDsa.ExportSubjectPublicKeyInfo` and
 * `DSASignatureFormat.Rfc3279DerSequence` on the Windows side.
 */

export const IDENTITY_CURVE = 'prime256v1';
export const IDENTITY_HASH = 'sha256';

export interface IdentityKeyPair {
  /** SPKI DER, base64url. Safe to store and transmit. */
  readonly publicKey: string;
  /** PKCS#8 DER, base64url. Must be written only to protected local storage. */
  readonly privateKey: string;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: IDENTITY_CURVE });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

/** Sign a canonical payload with an identity private key. */
export function signPayload(privateKeyBase64Url: string, payload: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64Url, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return createSign(IDENTITY_HASH).update(payload, 'utf8').sign(key).toString('base64url');
}

/**
 * Verify a signature against an identity public key.
 *
 * Returns false rather than throwing for malformed keys or signatures, so callers cannot
 * accidentally treat a parse failure as a different outcome from a verification failure.
 */
export function verifySignature(
  publicKeyBase64Url: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64Url, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return createVerify(IDENTITY_HASH)
      .update(payload, 'utf8')
      .verify(key, Buffer.from(signatureBase64Url, 'base64url'));
  } catch {
    return false;
  }
}

/** Per-connection challenge issued before a PC or device is allowed to speak. */
export interface Challenge {
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export const CHALLENGE_TTL_SECONDS = 30;

export function createChallenge(now: Date = new Date()): Challenge {
  return {
    nonce: randomBytes(32).toString('base64url'),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000),
  };
}

export type ChallengeRejection = 'expired' | 'nonce-mismatch' | 'bad-signature';

export type ChallengeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ChallengeRejection };

export interface VerifyChallengeOptions {
  readonly challenge: Challenge;
  /** Nonce echoed back by the peer. */
  readonly presentedNonce: string;
  /** Exact string the peer was required to sign. */
  readonly signingPayload: string;
  readonly signature: string;
  readonly publicKey: string;
  readonly now?: Date;
}

/**
 * Verify a challenge response. The nonce is single-use and short-lived, and the payload
 * binds the signature to a specific PC, so a captured signature cannot be replayed on a
 * later connection or for a different machine.
 */
export function verifyChallengeResponse(options: VerifyChallengeOptions): ChallengeResult {
  const now = options.now ?? new Date();
  if (now.getTime() > options.challenge.expiresAt.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  const expected = Buffer.from(options.challenge.nonce, 'utf8');
  const presented = Buffer.from(options.presentedNonce, 'utf8');
  if (expected.length !== presented.length || !expected.equals(presented)) {
    return { ok: false, reason: 'nonce-mismatch' };
  }

  if (!verifySignature(options.publicKey, options.signingPayload, options.signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}

/**
 * Whether a string is an identity public key this module can verify with: SPKI DER, base64url, on the
 * P-256 curve.
 *
 * Checked when a client registers a key at sign-in. A key that does not parse, or is on another curve,
 * would bind a device to something no signature can ever satisfy — and the first refresh would then be
 * answered as a stolen token instead of the sign-in being refused as malformed.
 */
export function isIdentityPublicKey(publicKeyBase64Url: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(publicKeyBase64Url)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64Url, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === IDENTITY_CURVE;
  } catch {
    return false;
  }
}

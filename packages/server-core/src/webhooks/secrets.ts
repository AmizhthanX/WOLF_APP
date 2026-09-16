import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { webhookSignedPayload } from '@wolf/protocol';

/**
 * The two secrets a webhook has, neither of which is in the database in a usable form.
 *
 * Both come from `WOLF_WEBHOOK_KEY`, a server key held in secret management:
 *
 * - **The URL**, encrypted with AES-256-GCM under a key derived for that purpose. A database copy without the
 *   server key does not hand over anybody's Slack or Discord credential.
 * - **The signing secret**, never stored: derived from the server key, the webhook's id and a random salt that
 *   is stored. Rotating it is replacing the salt.
 *
 * Distinct derivations (HKDF with distinct labels), so the encryption key and the signing secrets are never the
 * same bytes put to two uses.
 */
export class WebhookSecrets {
  private readonly urlKey: Buffer;
  private readonly signingRoot: Buffer;

  constructor(serverKey: string) {
    if (Buffer.byteLength(serverKey) < 32) throw new Error('The webhook key must be at least 32 bytes.');
    const root = Buffer.from(serverKey);
    this.urlKey = Buffer.from(hkdfSync('sha256', root, Buffer.from('wolf-webhooks'), Buffer.from('url-encryption v1'), 32));
    this.signingRoot = Buffer.from(hkdfSync('sha256', root, Buffer.from('wolf-webhooks'), Buffer.from('signing v1'), 32));
  }

  newSalt(): string {
    return randomBytes(24).toString('base64url');
  }

  /** The secret shown to the owner, and used to sign. */
  signingSecret(webhookId: string, salt: string): string {
    return `whsec_${createHmac('sha256', this.signingRoot).update(`${webhookId}\0${salt}`).digest('base64url')}`;
  }

  /** `v1.<iv>.<ciphertext>.<tag>`, base64url. The webhook id is bound in, so a ciphertext cannot be moved to another row. */
  encryptUrl(webhookId: string, url: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.urlKey, iv);
    cipher.setAAD(Buffer.from(webhookId));
    const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  decryptUrl(webhookId: string, sealed: string): string {
    const [version, iv, ciphertext, tag] = sealed.split('.');
    if (version !== 'v1' || !iv || !ciphertext || !tag) throw new Error('Unreadable webhook URL.');
    const decipher = createDecipheriv('aes-256-gcm', this.urlKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(webhookId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** The `WOLF-Signature` header value for a body sent at a time. */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(webhookSignedPayload(timestampSeconds, body)).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * What a receiver does, written down as code so the documentation's example is one that works: parse, check
 * the time is recent, recompute, compare in constant time.
 */
export function verifyWebhook(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=', 2) as [string, string]));
  const timestamp = Number(parts['t']);
  const given = parts['v1'];
  if (!Number.isInteger(timestamp) || !given || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(webhookSignedPayload(timestamp, body)).digest();
  const received = Buffer.from(given, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

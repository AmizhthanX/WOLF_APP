import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PUSH_WAKE } from '@wolf/protocol';
import { ConfigurationError } from '../../config.js';
import type { PushOutcome, PushSender, PushTarget } from '../push.js';

/**
 * Firebase Cloud Messaging, through its HTTP v1 API.
 *
 * Authenticated as a service account: a JWT signed with the account's private key is exchanged for a
 * short-lived OAuth token, cached until a minute before it expires. Node's own crypto signs it, so no Google
 * client library is added for one assertion.
 *
 * **What goes to Google is the device's registration token and `{kind: "wolf.wake", v: "1"}`.** No
 * notification block, so Android never displays anything from the push itself; the app decides what to
 * show after fetching it from WOLF. High priority, so the phone is allowed to wake for it; a one-hour time to
 * live, after which news is no longer news; one collapse key, so a phone that was offline gets one wake-up
 * rather than a queue of them.
 */

export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const FCM_ENDPOINT = 'https://fcm.googleapis.com';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmCredentials {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

export interface FcmOptions {
  readonly projectId: string;
  readonly credentials: FcmCredentials;
  /** Overridable for tests. HTTPS, or HTTP on this machine only. */
  readonly endpoint?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/** The message, exactly. Exported so a test can hold it to "nothing but that there is news". */
export function wakeMessage(token: string): Record<string, unknown> {
  return {
    message: {
      token,
      data: { ...PUSH_WAKE },
      android: { priority: 'HIGH', ttl: '3600s', collapse_key: 'wolf-wake' },
    },
  };
}

/** HTTPS anywhere; plain HTTP only to this machine, which is what a test server is. */
function acceptableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}

export async function readFcmCredentials(file: string): Promise<FcmCredentials> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // The path, not the contents: the file holds a private key.
    throw new ConfigurationError('WOLF_FCM_CREDENTIALS_FILE could not be read as a JSON service-account file.');
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];
  const tokenUri = record['token_uri'] ?? GOOGLE_TOKEN_URI;

  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY') || typeof tokenUri !== 'string') {
    throw new ConfigurationError('WOLF_FCM_CREDENTIALS_FILE does not hold a service account (client_email and private_key).');
  }
  if (!acceptableUrl(tokenUri)) {
    throw new ConfigurationError('The service account names a token endpoint that is not HTTPS.');
  }

  return { clientEmail, privateKey, tokenUri };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export class FcmPushSender implements PushSender {
  readonly provider = 'fcm' as const;

  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private access: { readonly value: string; readonly expiresAt: number } | null = null;

  constructor(private readonly options: FcmOptions) {
    this.endpoint = (options.endpoint ?? FCM_ENDPOINT).replace(/\/+$/, '');
    if (!acceptableUrl(this.endpoint)) throw new ConfigurationError('The FCM endpoint must be HTTPS.');
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async wake(target: PushTarget): Promise<PushOutcome> {
    const first = await this.send(target);
    if (first !== 'unauthorized') return first;

    // A cached token the provider no longer accepts: fetch a new one, once.
    this.access = null;
    const second = await this.send(target);
    return second === 'unauthorized' ? 'failed' : second;
  }

  private async send(target: PushTarget): Promise<PushOutcome | 'unauthorized'> {
    let bearer: string;
    try {
      bearer = await this.accessToken();
    } catch {
      return 'failed';
    }

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(wakeMessage(target.token)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return 'failed';
    }

    if (response.ok) return 'delivered';
    if (response.status === 401) return 'unauthorized';

    const code = await errorCode(response);
    // UNREGISTERED: the app is gone or the token rotated. SENDER_ID_MISMATCH: a token from another project.
    if (response.status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return 'token-invalid';
    return 'failed';
  }

  private async accessToken(): Promise<string> {
    const now = this.now().getTime();
    if (this.access && this.access.expiresAt - 60_000 > now) return this.access.value;

    const { clientEmail, privateKey, tokenUri } = this.options.credentials;
    const issuedAt = Math.floor(now / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
      JSON.stringify({ iss: clientEmail, scope: FCM_SCOPE, aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 }),
    )}`;
    const assertion = `${unsigned}.${base64url(createSign('RSA-SHA256').update(unsigned).sign(privateKey))}`;

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`The token endpoint answered ${response.status}.`);

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('The token endpoint returned no access token.');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;

    this.access = { value: body.access_token, expiresAt: now + expiresIn * 1000 };
    return body.access_token;
  }
}

/** The FCM error code from a v1 error body, if there is one. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> } };
    const detail = body.error?.details?.find((entry) => typeof entry.errorCode === 'string');
    if (detail) return String(detail.errorCode);
    return typeof body.error?.status === 'string' ? body.error.status : null;
  } catch {
    return null;
  }
}

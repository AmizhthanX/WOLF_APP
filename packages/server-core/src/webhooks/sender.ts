import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { WEBHOOK_DELIVERY_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMEOUT_MS, type WebhookDeliveryOutcome } from '@wolf/protocol';
import { checkEgress, systemResolver, type EgressVerdict, type Resolver } from './egress.js';
import { signWebhook } from './secrets.js';

export interface WebhookDelivery {
  readonly url: string;
  readonly secret: string;
  readonly body: string;
  readonly deliveryId: string;
  readonly now: Date;
}

export interface WebhookResult {
  readonly outcome: WebhookDeliveryOutcome;
  /** The HTTP status, when there was one. */
  readonly status: number | null;
  /** For the owner: why, in words. Never contains the URL's path or query. */
  readonly detail: string;
}

export interface WebhookSenderOptions {
  readonly resolve?: Resolver;
  /** Extra trust anchors. Tests only: production verifies against the system's roots and nothing else. */
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
  /**
   * Tests only: open the socket here instead of at the address that passed the check, so a test can prove
   * the request goes wherever the pinned lookup says — to a server on this machine — without the check
   * itself being loosened. Nothing in the server's wiring sets it.
   */
  readonly testConnectAddress?: { readonly address: string; readonly family: 4 | 6 };
}

const MAX_RESPONSE_BYTES = 1024;

/**
 * One signed HTTPS POST to a checked address.
 *
 * The name is resolved and checked here, every time, and the socket is opened to the address that passed —
 * through a `lookup` that returns only that address — while TLS still verifies the certificate against the
 * name. A DNS answer that changes between the check and the connect cannot redirect the request.
 */
export class WebhookSender {
  private readonly resolve: Resolver;
  private readonly timeoutMs: number;

  constructor(private readonly options: WebhookSenderOptions = {}) {
    this.resolve = options.resolve ?? systemResolver;
    this.timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  }

  /** The same check a delivery makes, for saying at once whether a URL WOLF will send to. */
  check(url: string): Promise<EgressVerdict> {
    return checkEgress(url, this.resolve);
  }

  async deliver(delivery: WebhookDelivery): Promise<WebhookResult> {
    const verdict = await checkEgress(delivery.url, this.resolve);
    if (!verdict.ok) return { outcome: 'address-refused', status: null, detail: verdict.detail };

    const url = new URL(delivery.url);
    const timestamp = Math.floor(delivery.now.getTime() / 1000);
    const target = this.options.testConnectAddress ?? { address: verdict.address, family: verdict.family };
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
          { address: target.address, family: target.family },
        ]);
      } else {
        callback(null, target.address, target.family);
      }
    };

    const requestOptions: RequestOptions = {
      method: 'POST',
      host: verdict.hostname,
      // SNI carries a name, never an address literal.
      ...(isIP(verdict.hostname) === 0 ? { servername: verdict.hostname } : {}),
      port: verdict.port,
      path: `${url.pathname}${url.search}`,
      lookup: pinned,
      agent: false,
      rejectUnauthorized: true,
      ...(this.options.ca ? { ca: this.options.ca } : {}),
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(delivery.body),
        'user-agent': 'WOLF-Webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(delivery.secret, timestamp, delivery.body),
        [WEBHOOK_DELIVERY_HEADER]: delivery.deliveryId,
      },
    };

    return new Promise<WebhookResult>((resolve) => {
      let settled = false;
      const finish = (result: WebhookResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const outgoing = httpsRequest(requestOptions, (response) => {
        const status = response.statusCode ?? 0;
        let read = 0;
        response.on('data', (chunk: Buffer) => {
          read += chunk.length;
          // Nothing in the answer is used; reading a little lets a well-behaved server finish cleanly.
          if (read > MAX_RESPONSE_BYTES) response.destroy();
        });
        response.on('close', () => {
          if (status >= 200 && status < 300) {
            finish({ outcome: 'delivered', status, detail: `Accepted with ${status}.` });
          } else if (status >= 300 && status < 400) {
            finish({ outcome: 'redirect', status, detail: `Answered with a redirect (${status}), which WOLF does not follow.` });
          } else {
            finish({ outcome: 'http-error', status, detail: `Answered with ${status}.` });
          }
        });
        response.on('error', () => undefined);
      });

      const timer = setTimeout(() => {
        outgoing.destroy();
        finish({ outcome: 'timeout', status: null, detail: `No answer within ${Math.round(this.timeoutMs / 1000)} seconds.` });
      }, this.timeoutMs);

      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        const tls = typeof error.code === 'string' && /CERT|SSL|TLS|SELF_SIGNED|ALTNAME/i.test(error.code);
        finish(
          tls
            ? { outcome: 'tls', status: null, detail: 'The certificate could not be verified.' }
            : { outcome: 'network', status: null, detail: 'The connection failed.' },
        );
      });

      outgoing.end(delivery.body);
    });
  }
}

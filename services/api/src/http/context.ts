import type { TokenSigner } from '@wolf/auth';
import type { ServerContext, WebhookSender } from '@wolf/server-core';
import type { RateLimiter } from './rate-limit.js';

/** The shared server context plus what only the HTTP API needs. */
export interface AppContext extends ServerContext {
  readonly signer: TokenSigner;
  readonly rateLimiter: RateLimiter;
  /**
   * Sends webhooks and checks their URLs. Absent, the API makes the real one — which resolves names with the
   * system resolver and trusts the system's roots, and nothing else.
   */
  readonly webhookSender?: WebhookSender;
}

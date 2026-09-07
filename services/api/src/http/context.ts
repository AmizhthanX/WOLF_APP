import type { TokenSigner } from '@wolf/auth';
import type { ServerContext } from '@wolf/server-core';
import type { RateLimiter } from './rate-limit.js';

/** The shared server context plus what only the HTTP API needs. */
export interface AppContext extends ServerContext {
  readonly signer: TokenSigner;
  readonly rateLimiter: RateLimiter;
}

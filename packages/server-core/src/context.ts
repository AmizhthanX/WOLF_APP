import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Database } from './db/pool.js';
import type { Repositories } from './db/repositories/index.js';

/**
 * What every WOLF backend service needs: configuration, a database, repositories, a
 * logger, and an injectable clock. Individual services extend this with what only they
 * need — the API adds a token signer and a rate limiter, the realtime service adds its
 * connection registry.
 */
export interface ServerContext {
  readonly config: Config;
  readonly db: Database;
  readonly repos: Repositories;
  readonly logger: Logger;
  /** Injectable clock so time-dependent behaviour is testable without waiting. */
  readonly now: () => Date;
}

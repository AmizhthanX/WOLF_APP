import { createHmacSigner } from '@wolf/auth';
import { loadConfig } from '@wolf/server-core';
import { createLogger } from '@wolf/server-core';
import { createDatabase } from '@wolf/server-core';
import { createRepositories } from '@wolf/server-core';
import { InMemoryRateLimiter } from './http/rate-limit.js';
import { buildApp } from './http/app.js';
import { MaintenanceJob } from '@wolf/server-core';
import type { AppContext } from './http/context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config);

  const context: AppContext = {
    config,
    db,
    repos: createRepositories(db),
    logger,
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => new Date(),
  };

  // Fail fast if the database is unreachable: a WOLF API that cannot audit must not serve.
  await db.query('SELECT 1');

  const app = await buildApp(context);
  const maintenance = new MaintenanceJob(context);
  maintenance.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    maintenance.stop();
    try {
      await app.close();
      await db.end();
      process.exit(0);
    } catch (error) {
      logger.error({ err: String(error) }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, env: config.env }, 'WOLF API listening');
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this path writes directly to stderr.
  process.stderr.write(
    `WOLF API failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

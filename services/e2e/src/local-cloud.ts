import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { pino } from 'pino';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { AgentLink } from '@wolf/realtime/agent-link';
import { ClientLink } from '@wolf/realtime/client-link';
import { AgentRegistry } from '@wolf/realtime/registry';
import { ClientRegistry } from '@wolf/realtime/client-registry';
import type { RealtimeContext } from '@wolf/realtime/context';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
// Test-only: an in-process Postgres. Kept behind its own export so a production import
// graph can never reach it, and imported here rather than in any service for the same
// reason — this file is development tooling, not a service.
import { createTestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';

/**
 * The whole cloud, on this machine, for driving with a real browser and a real agent.
 *
 * Every layer here is the shipping implementation: the real Fastify app with its real
 * authorization pipeline, the real relay with its real handshake and direction checks, the
 * real migrations. Nothing is stubbed and no service is modified to accommodate this file.
 *
 * **The one substitution is the database engine.** It is PGlite — genuine Postgres compiled
 * to WebAssembly, the same engine the test suites run against — rather than a Postgres
 * server, because installing one is not something this should require of a developer's
 * machine. Migrations, constraints, and partitioning behave as they will in production;
 * anything that depends on a *server* (connection pooling under load, replication) does not
 * exist here and is not being exercised.
 *
 * **Its state lives only in memory.** Every restart is a fresh cloud: the owner is created
 * again, and any PC enrolled against the previous run is gone. That is deliberate — a
 * development harness that accumulates state is one whose failures depend on what you did
 * last week.
 *
 * Not for deployment, and it refuses to start if anything suggests it is being asked to
 * stand in for one.
 */

const API_PORT = Number(process.env['WOLF_LOCAL_API_PORT'] ?? 8080);
const REALTIME_PORT = Number(process.env['WOLF_LOCAL_REALTIME_PORT'] ?? 8081);
const WEB_ORIGIN = process.env['WOLF_LOCAL_WEB_ORIGIN'] ?? 'http://localhost:3000';

const OWNER_EMAIL = process.env['WOLF_OWNER_EMAIL'] ?? 'owner@example.com';
const OWNER_PASSWORD = process.env['WOLF_OWNER_PASSWORD'] ?? 'a-long-local-passphrase';

/**
 * Refuse to run anywhere that looks like a deployment.
 *
 * The database is in-memory and the owner password has a default, so the failure mode if
 * this ever ran on a server is losing every record on restart while holding a password
 * somebody can read in this file. Cheaper to make it impossible.
 */
if (process.env['NODE_ENV'] === 'production') {
  console.error('local-cloud is development tooling and will not run with NODE_ENV=production.');
  process.exit(1);
}

async function main(): Promise<void> {
  const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

  const db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://local/wolf',
    WOLF_TOKEN_SECRET: process.env['WOLF_TOKEN_SECRET'] ?? 'local-development-secret-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: WEB_ORIGIN,
  } as NodeJS.ProcessEnv);

  const repos = createRepositories(db);
  const signer = createHmacSigner(config.tokens.secret);

  const apiContext: AppContext = {
    config,
    db,
    repos,
    logger,
    signer,
    rateLimiter: new InMemoryRateLimiter(),
    now: () => new Date(),
  };

  const realtime: RealtimeContext = {
    config,
    db,
    repos,
    logger,
    now: () => new Date(),
    signer,
    agents: new AgentRegistry(),
    clients: new ClientRegistry(),
  };

  // Deliberately cheap. This is the parameter set the test suites use, chosen so a local
  // sign-in is not a two-second wait; production reads its cost from configuration.
  await repos.users.createOwner({
    id: newId(),
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(OWNER_PASSWORD, {
      cost: 2 ** 12,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
    }),
    displayName: 'Owner',
  });

  const app = await buildApp(apiContext);
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  // One socket server, routed by path, exactly as the deployed relay does it.
  const wsServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  wsServer.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (path === '/agent') {
        new AgentLink({ socket: ws, context: realtime, remoteAddress: '127.0.0.1' });
      } else {
        new ClientLink({ socket: ws, context: realtime, remoteAddress: '127.0.0.1' });
      }
    });
  });

  await new Promise<void>((resolve) => wsServer.listen(REALTIME_PORT, '127.0.0.1', resolve));

  logger.info(
    {
      api: `http://127.0.0.1:${API_PORT}`,
      agentSocket: `ws://127.0.0.1:${REALTIME_PORT}/agent`,
      clientSocket: `ws://127.0.0.1:${REALTIME_PORT}/client`,
      dashboard: WEB_ORIGIN,
      owner: OWNER_EMAIL,
    },
    'Local cloud is up. The database is in memory: restarting loses every PC enrolled against it.',
  );

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down.');
    realtime.agents.closeAll('local-cloud-shutdown');
    await app.close();
    wss.close();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await db.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

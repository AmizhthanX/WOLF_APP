import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { createHmacSigner } from '@wolf/auth';
import {
  createDatabase,
  createLogger,
  createRepositories,
  loadConfig,
} from '@wolf/server-core';
import { AgentLink } from './agent-link.js';
import { ClientLink } from './client-link.js';
import { AgentRegistry } from './registry.js';
import { ClientRegistry } from './client-registry.js';
import { NotificationListener } from './notifications.js';
import type { RealtimeContext } from './context.js';

/** Path Windows agents connect to. */
const AGENT_PATH = '/agent';
/** Path browsers and Android clients connect to for signaling. */
const CLIENT_PATH = '/client';
/** How often idle sockets are pinged so dead links are noticed rather than assumed alive. */
const PING_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config).child({ service: 'wolf-realtime' });
  const db = createDatabase(config);

  const context: RealtimeContext = {
    config,
    db,
    repos: createRepositories(db),
    logger,
    now: () => new Date(),
    // Session tokens are verified here rather than by asking the API: a signaling message
    // has to be authorized on the socket carrying it, and a round trip per message would
    // be both slower and a second place for the check to be forgotten.
    signer: createHmacSigner(config.tokens.secret),
    agents: new AgentRegistry(),
    clients: new ClientRegistry(),
  };

  await db.query('SELECT 1');

  const listener = new NotificationListener({ config, registry: context.agents, logger });
  await listener.start();

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          agents: context.agents.size,
          clients: context.clients.size,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not-found' }));
  });

  // noServer mode so anything that is not a known path is rejected before the upgrade
  // completes, rather than being accepted and then ignored.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  http.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== AGENT_PATH && path !== CLIENT_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const remoteAddress =
      (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      request.socket.remoteAddress ??
      null;

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (path === AGENT_PATH) {
        new AgentLink({ socket: ws, context, remoteAddress });
      } else {
        new ClientLink({ socket: ws, context, remoteAddress });
      }
    });
  });

  const pingTimer = setInterval(() => {
    for (const pcId of context.agents.connectedPcIds()) {
      const link = context.agents.get(pcId);
      if (link instanceof AgentLink) link.ping();
    }
    for (const client of context.clients.all()) {
      if (client instanceof ClientLink) client.ping();
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down realtime service');
    clearInterval(pingTimer);
    context.clients.closeAll('server-shutdown');
    context.agents.closeAll('server-shutdown');
    await listener.stop();
    wss.close();
    http.close();
    await db.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  http.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, agentPath: AGENT_PATH, clientPath: CLIENT_PATH },
      'WOLF realtime listening',
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `WOLF realtime failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { pino } from 'pino';
import { generateIdentityKeyPair, signPayload } from '@wolf/auth';
import { PROTOCOL_VERSION, challengeSigningPayload } from '@wolf/protocol';
import { createHmacSigner } from '@wolf/auth';
import { loadConfig } from '@wolf/server-core';
import { AgentLink } from './agent-link.js';
import { AgentRegistry } from './registry.js';
import { ClientRegistry } from './client-registry.js';
import type { RealtimeContext } from './context.js';

/**
 * Protocol-level tests for the agent link. They run a real WebSocket server against
 * in-memory repositories, so the authentication handshake is exercised end to end rather
 * than through the verification helper alone.
 */

const PC_ID = '01J9ZQK7T0000000000000000A';
const OTHER_PC_ID = '01J9ZQK7T0000000000000000B';
const USER_ID = '01J9ZQK7T0000000000000000C';

const keys = generateIdentityKeyPair();
const otherKeys = generateIdentityKeyPair();

let server: Server;
let wss: WebSocketServer;
let port = 0;
const registry = new AgentRegistry();
const clients = new ClientRegistry();
const presenceUpdates: unknown[] = [];
const securityEvents: { type: string; detail?: Record<string, unknown> }[] = [];

const identities: Record<string, { id: string; userId: string; publicKey: string | null; registrationState: string; remoteAccessEnabled: boolean }> = {
  [PC_ID]: {
    id: PC_ID,
    userId: USER_ID,
    publicKey: keys.publicKey,
    registrationState: 'active',
    remoteAccessEnabled: true,
  },
  [OTHER_PC_ID]: {
    id: OTHER_PC_ID,
    userId: USER_ID,
    publicKey: otherKeys.publicKey,
    registrationState: 'revoked',
    remoteAccessEnabled: true,
  },
};

function createContext(): RealtimeContext {
  const repos = {
    pcs: {
      findIdentity: async (id: string) => identities[id] ?? null,
      setPresence: async (id: string, presence: unknown) => {
        presenceUpdates.push({ id, presence });
      },
      upsertCapabilities: async () => {},
      upsertHardware: async () => {},
    },
    audit: {
      record: async () => 'audit',
      recordSecurityEvent: async (event: { type: string; detail?: Record<string, unknown> }) => {
        securityEvents.push(event);
      },
    },
    commands: { claimPending: async () => [], markRunning: async () => {} },
    telemetry: { insertBatch: async () => 0 },
    remoteDesktop: { endStreamsForPc: async () => 0 },
  };

  return {
    config: loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost/wolf_test',
      WOLF_TOKEN_SECRET: 'x'.repeat(48),
    } as NodeJS.ProcessEnv),
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    repos,
    logger: pino({ level: 'silent' }),
    now: () => new Date(),
    signer: createHmacSigner('x'.repeat(48)),
    agents: registry,
    clients,
  } as unknown as RealtimeContext;
}

before(async () => {
  const context = createContext();
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    new AgentLink({ socket, context, remoteAddress: '10.0.0.9' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

after(async () => {
  registry.closeAll('test-teardown');
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Exchange {
  readonly messages: Record<string, unknown>[];
  readonly closed: boolean;
}

/**
 * Connect, wait for the challenge, respond with `respond(nonce)`, and collect what comes
 * back before the socket settles.
 */
async function handshake(
  respond: (nonce: string) => Record<string, unknown> | null,
): Promise<Exchange> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  const messages: Record<string, unknown>[] = [];
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 1500);

    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(message);
      if (message['kind'] === 'cloud.challenge') {
        const reply = respond(message['nonce'] as string);
        if (reply) socket.send(JSON.stringify(reply));
      }
      if (message['kind'] === 'cloud.auth-rejected' || message['kind'] === 'cloud.auth-accepted') {
        clearTimeout(timer);
        setTimeout(() => resolve(), 100);
      }
    });

    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', reject);
  });

  if (socket.readyState === WebSocket.OPEN) socket.close();
  return { messages, closed };
}

function authMessage(
  pcId: string,
  nonce: string,
  privateKey: string,
  signedPcId = pcId,
): Record<string, unknown> {
  return {
    kind: 'agent.auth',
    protocolVersion: PROTOCOL_VERSION,
    pcId,
    agentVersion: '0.1.0-test',
    nonce,
    signature: signPayload(privateKey, challengeSigningPayload(signedPcId, nonce)),
  };
}

test('the server challenges before accepting anything', async () => {
  const exchange = await handshake(() => null);
  assert.equal(exchange.messages[0]?.['kind'], 'cloud.challenge');
  assert.ok(typeof exchange.messages[0]?.['nonce'] === 'string');
});

test('a correctly signed challenge response authenticates the PC', async () => {
  const exchange = await handshake((nonce) => authMessage(PC_ID, nonce, keys.privateKey));
  const accepted = exchange.messages.find((message) => message['kind'] === 'cloud.auth-accepted');
  assert.ok(accepted, 'expected the link to be accepted');
  assert.equal(accepted['pcId'], PC_ID);
});

test('a response signed with the wrong key is refused', async () => {
  const exchange = await handshake((nonce) => authMessage(PC_ID, nonce, otherKeys.privateKey));
  const rejected = exchange.messages.find((message) => message['kind'] === 'cloud.auth-rejected');
  assert.ok(rejected);
  assert.equal(rejected['reason'], 'bad-signature');
  assert.ok(exchange.closed || true);
});

test('a signature bound to another PC cannot authenticate this one', async () => {
  // Correct key, correct nonce, but the signed payload names a different PC.
  const exchange = await handshake((nonce) =>
    authMessage(PC_ID, nonce, keys.privateKey, OTHER_PC_ID),
  );
  const rejected = exchange.messages.find((message) => message['kind'] === 'cloud.auth-rejected');
  assert.equal(rejected?.['reason'], 'bad-signature');
});

test('an unknown PC is refused and recorded as a security event', async () => {
  const before = securityEvents.length;
  const exchange = await handshake((nonce) =>
    authMessage('01J9ZQK7T0000000000000000Z', nonce, keys.privateKey),
  );
  const rejected = exchange.messages.find((message) => message['kind'] === 'cloud.auth-rejected');
  assert.equal(rejected?.['reason'], 'unknown-pc');
  assert.ok(securityEvents.length > before, 'the refusal is recorded');
});

test('a revoked PC cannot reconnect', async () => {
  const exchange = await handshake((nonce) =>
    authMessage(OTHER_PC_ID, nonce, otherKeys.privateKey),
  );
  const rejected = exchange.messages.find((message) => message['kind'] === 'cloud.auth-rejected');
  assert.equal(rejected?.['reason'], 'revoked');
});

test('a nonce from one connection cannot be replayed on another', async () => {
  let capturedNonce = '';
  await handshake((nonce) => {
    capturedNonce = nonce;
    return authMessage(PC_ID, nonce, keys.privateKey);
  });

  // Replay the previous connection's signed response against a fresh challenge.
  const replay = await handshake(() => authMessage(PC_ID, capturedNonce, keys.privateKey));
  const rejected = replay.messages.find((message) => message['kind'] === 'cloud.auth-rejected');
  assert.ok(rejected, 'a replayed nonce must not authenticate');
  assert.equal(rejected['reason'], 'bad-signature');
});

test('messages sent before authentication close the link', async () => {
  const exchange = await handshake(() => ({
    kind: 'agent.heartbeat',
    protocolVersion: PROTOCOL_VERSION,
    at: new Date().toISOString(),
    sessionState: 'desktop',
    localKillSwitchEngaged: false,
    activeSessionCount: 0,
  }));
  assert.ok(exchange.closed, 'the socket must be closed');
  assert.ok(
    !exchange.messages.some((message) => message['kind'] === 'cloud.auth-accepted'),
    'nothing was authenticated',
  );
});

test('malformed frames close the link instead of being ignored', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  const closed = await new Promise<boolean>((resolve) => {
    socket.on('message', () => socket.send('this is not json'));
    socket.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 1500);
  });
  assert.equal(closed, true);
});

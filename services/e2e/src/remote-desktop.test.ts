import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { AgentLink } from '@wolf/realtime/agent-link';
import { ClientLink } from '@wolf/realtime/client-link';
import { AgentRegistry } from '@wolf/realtime/registry';
import { ClientRegistry } from '@wolf/realtime/client-registry';
import type { RealtimeContext } from '@wolf/realtime/context';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, generateIdentityKeyPair, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';
import { FakeAgent } from './fake-agent.js';
import { FakeClient } from './fake-client.js';

/**
 * Remote desktop signaling, end to end.
 *
 * The relay standing between an authenticated user and a live desktop is the most
 * security-sensitive component WOLF has, so these tests are mostly about what it refuses:
 * an account token, a session without the screen capability, a message aimed at somebody
 * else's session, a payload sent in the wrong direction, and an agent trying to speak for
 * a PC that is not its own.
 */

const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let httpServer: Server;
let wss: WebSocketServer;
let realtime: RealtimeContext;
let agentUrl = '';
let clientUrl = '';

let accessToken = '';
let pcA = '';
let pcB = '';
let agentA: FakeAgent;
const keysA = generateIdentityKeyPair();
const keysB = generateIdentityKeyPair();

const openClients: FakeClient[] = [];

before(async () => {
  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const logger = pino({ level: 'silent' });
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

  realtime = {
    config,
    db,
    repos,
    logger,
    now: () => new Date(),
    signer,
    agents: new AgentRegistry(),
    clients: new ClientRegistry(),
  };

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

  app = await buildApp(apiContext);
  await app.ready();

  httpServer = createServer();
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (path === '/agent') {
        new AgentLink({ socket: ws, context: realtime, remoteAddress: '127.0.0.1' });
      } else {
        new ClientLink({ socket: ws, context: realtime, remoteAddress: '127.0.0.1' });
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  agentUrl = `ws://127.0.0.1:${port}/agent`;
  clientUrl = `ws://127.0.0.1:${port}/client`;

  // Sign in and enrol two PCs, so cross-PC isolation can actually be tested.
  accessToken = await signIn();
  pcA = await enrol('Studio', keysA.publicKey);
  pcB = await enrol('Laptop', keysB.publicKey);

  agentA = buildAgent();
  await agentA.connect();
});

/**
 * A fresh agent for this PC.
 *
 * Extracted because one test closes the agent to prove that watching clients are told, and
 * everything after it would otherwise run against a PC that is not there — passing or
 * failing for reasons unrelated to what it set out to check.
 */
function buildAgent(): FakeAgent {
  return new FakeAgent({
    url: agentUrl,
    pcId: pcA,
    keys: keysA,
    supportedCommands: ['remote-desktop.list-displays', 'remote-desktop.status'],
    // Answer a stream request the way a real agent would: settle the negotiation, then offer.
    onSignal: (envelope, agent) => {
      if (envelope.payload.type !== 'stream.request') return;

      agent.sendSignal(envelope.sessionId, envelope.streamId, {
        type: 'stream.ready',
        negotiation: {
          streamId: envelope.streamId,
          display: {
            id: 'DISPLAY-1',
            name: 'Generic Monitor',
            widthPixels: 2560,
            heightPixels: 1440,
            refreshHz: 60,
            primary: true,
            scaleFactor: 1,
            hdr: false,
            originX: 0,
            originY: 0,
          },
          videoCodec: 'h264',
          hardwareEncoded: false,
          audioCodec: null,
          effectiveProfile: {
            ...envelope.payload.request.profile,
            // The machine has no hardware encoder, so the frame rate is clamped and the
            // client is told which setting could not be honoured.
            targetFps: 30,
          },
          adjustments: [
            {
              setting: 'targetFps',
              requested: String(envelope.payload.request.profile.targetFps),
              applied: '30',
              reason: 'No hardware encoder is available on this PC.',
            },
          ],
          startedAt: new Date().toISOString(),
        },
      });

      agent.sendSignal(envelope.sessionId, envelope.streamId, {
        type: 'sdp.offer',
        sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=WOLF\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
      });
    },
  });
}

/**
 * Reconnect the agent, discarding what the old one saw.
 *
 * The fresh instance matters as much as the connection: a test that waited for a signal on
 * an agent carrying messages from earlier tests would be satisfied by one of those instead
 * of by the message it sent.
 */
async function reconnectAgent(): Promise<void> {
  agentA.close();
  agentA = buildAgent();
  await agentA.connect();
}

after(async () => {
  for (const client of openClients) client.close();
  agentA?.close();
  realtime.clients.closeAll('test-teardown');
  realtime.agents.closeAll('test-teardown');
  await app?.close();
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.end();
});

/* ------------------------------------------------------------------------- */

async function signIn(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      device: { kind: 'web', name: 'E2E browser' },
    },
  });
  assert.equal(response.statusCode, 200);
  return String(JSON.parse(response.payload)['accessToken']);
}

async function enrol(name: string, publicKey: string): Promise<string> {
  const tokenResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/pcs/enrollment-tokens',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { label: name },
  });
  const enrollmentToken = String(JSON.parse(tokenResponse.payload)['enrollmentToken']);

  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/enroll',
    payload: {
      enrollmentToken,
      name,
      hostname: name,
      agentVersion: '0.1.0-e2e',
      publicKey,
    },
  });
  assert.equal(enrolled.statusCode, 201);
  return String(JSON.parse(enrolled.payload)['pcId']);
}

async function openSession(pcId: string, capabilities: string[]): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/sessions`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { mode: 'control', capabilities },
  });
  assert.equal(response.statusCode, 201);
  return String(JSON.parse(response.payload)['sessionToken']);
}

async function connectClient(sessionToken: string): Promise<FakeClient> {
  const client = new FakeClient({ url: clientUrl, sessionToken });
  openClients.push(client);
  return client;
}

const PROFILE = {
  name: 'Test',
  maxWidthPixels: null,
  maxHeightPixels: null,
  targetFps: 60,
  minBitrateBps: 1_000_000,
  maxBitrateBps: 20_000_000,
  codecPreference: [],
  audioEnabled: false,
  qualityBias: 'balanced' as const,
  adaptive: true,
};

/* ------------------------------------------------------------------------- */
/* Authentication                                                             */
/* ------------------------------------------------------------------------- */

test('a session token with the screen capability opens a signaling link', async () => {
  const client = await connectClient(await openSession(pcA, ['screen', 'input']));
  const outcome = await client.connect();

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.pcId, pcA);
  assert.equal(outcome.agentConnected, true, 'the client is told the agent is reachable');
});

test('an account token cannot open a signaling link', async () => {
  // An account token can browse. Watching a desktop requires a session that was granted
  // the capability, which is a different thing entirely.
  const client = await connectClient(accessToken);
  const outcome = await client.connect();

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'bad-token');
});

test('a session without the screen capability is refused', async () => {
  const client = await connectClient(await openSession(pcA, ['processes']));
  const outcome = await client.connect();

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'capability-missing');
});

test('a garbage token is refused without a stack trace reaching the client', async () => {
  const client = await connectClient('not.a.token');
  const outcome = await client.connect();

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'bad-token');
  assert.ok(!outcome.detail?.includes('Error'), 'the detail is a reason, not an exception');
});

test('a client told the agent is absent does not have to discover it by timing out', async () => {
  // PC B has no agent connected.
  const client = await connectClient(await openSession(pcB, ['screen']));
  const outcome = await client.connect();

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.agentConnected, false);
});

/* ------------------------------------------------------------------------- */
/* Signaling round trip                                                       */
/* ------------------------------------------------------------------------- */

test('a stream request reaches the agent and its offer comes back', async () => {
  const sessionToken = await openSession(pcA, ['screen', 'input']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264', 'vp8'],
      requestAudio: false,
    },
  });

  const request = await agentA.waitForSignal('stream.request');
  assert.equal(request.streamId, streamId);
  assert.equal(request.sessionId, outcome.sessionId);

  const ready = await client.waitForSignal('stream.ready');
  assert.equal(ready.payload.type, 'stream.ready');
  if (ready.payload.type === 'stream.ready') {
    assert.equal(ready.payload.negotiation.videoCodec, 'h264');
    assert.equal(ready.payload.negotiation.hardwareEncoded, false);
    assert.equal(
      ready.payload.negotiation.effectiveProfile.targetFps,
      30,
      'the client is shown what was actually applied, not what it asked for',
    );
    assert.equal(
      ready.payload.negotiation.adjustments.length,
      1,
      'and is told which setting could not be honoured, and why',
    );
  }

  const offer = await client.waitForSignal('sdp.offer');
  assert.equal(offer.payload.type, 'sdp.offer');

  // The answer goes back the other way.
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'sdp.answer',
    sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=WOLF\r\nt=0 0\r\n',
  });
  const answer = await agentA.waitForSignal('sdp.answer');
  assert.equal(answer.streamId, streamId);
});

test('the stream is recorded with what was negotiated, and nothing about the screen', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcA}/streams`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.statusCode, 200);

  const streams = JSON.parse(response.payload)['streams'] as {
    videoCodec: string | null;
    hardwareEncoded: boolean | null;
    state: string;
  }[];

  assert.ok(streams.length >= 1);
  const stream = streams[0]!;
  assert.equal(stream.videoCodec, 'h264');
  assert.equal(stream.hardwareEncoded, false);

  // The record describes the transport, never the content.
  const serialized = JSON.stringify(streams);
  assert.ok(!serialized.includes('frame'));
  assert.ok(!serialized.includes('sdp'));
});

/* ------------------------------------------------------------------------- */
/* What the relay refuses                                                     */
/* ------------------------------------------------------------------------- */

test('a client cannot signal a session that is not its own', async () => {
  const mine = await openSession(pcA, ['screen']);
  const other = await openSession(pcA, ['screen']);

  const otherClient = await connectClient(other);
  const otherOutcome = await otherClient.connect();
  assert.ok(otherOutcome.accepted && otherOutcome.sessionId);

  const client = await connectClient(mine);
  const outcome = await client.connect();
  assert.ok(outcome.accepted);

  // Aim a message at the other session. The relay closes the link rather than delivering.
  client.sendSignal(otherOutcome.sessionId, newId(), { type: 'ice.complete' });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(client.isOpen, false, 'the link is closed on a session mismatch');
  assert.equal(
    otherClient.received.length,
    0,
    'and nothing reached the session that was targeted',
  );
});

test('a client cannot send a payload only an agent may send', async () => {
  const client = await connectClient(await openSession(pcA, ['screen']));
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  // Publishing stats would let a client make the record claim a stream was healthy.
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.stats',
    stats: {
      streamId,
      at: new Date().toISOString(),
      state: 'STREAMING',
      route: 'lan',
      fps: 60,
      bitrateBps: 20_000_000,
      widthPixels: 2560,
      heightPixels: 1440,
      latencyMs: 4,
      jitterMs: 1,
      packetLossPercent: 0,
      keyFramesSent: 1,
      encoder: 'h264-qsv',
      encoderHardware: true,
      encodeMsPerFrame: 2,
      degradedReason: null,
    },
  });

  const error = await client.waitForSignal('stream.error');
  assert.equal(error.payload.type, 'stream.error');
  if (error.payload.type === 'stream.error') {
    assert.equal(error.payload.code, 'signal.wrong-direction');
  }
  assert.equal(
    agentA.signalsReceived.some((envelope) => envelope.payload.type === 'stream.stats'),
    false,
    'and it never reached the agent',
  );
});

test('an agent cannot signal a session belonging to another PC', async () => {
  // A session on PC B, while the misbehaving agent is PC A.
  const sessionToken = await openSession(pcB, ['screen']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const before = client.received.length;
  agentA.sendSignal(outcome.sessionId, newId(), {
    type: 'stream.state',
    state: 'STREAMING',
    unavailableReason: null,
    detail: null,
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    client.received.length,
    before,
    'a compromised agent must not inject state into another PC session',
  );
});

test('a malformed client message closes the link rather than being ignored', async () => {
  const client = await connectClient(await openSession(pcA, ['screen']));
  const outcome = await client.connect();
  assert.ok(outcome.accepted);

  client.sendRaw({ kind: 'client.signal', protocolVersion: 1, envelope: { nonsense: true } });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(client.isOpen, false);
});

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* ------------------------------------------------------------------------- */

test('the kill switch refuses new signaling links for that PC', async () => {
  const sessionToken = await openSession(pcB, ['screen']);

  const engaged = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcB}/kill-switch`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { remoteAccessEnabled: false, reason: 'e2e' },
  });
  assert.equal(engaged.statusCode, 200);

  const client = await connectClient(sessionToken);
  const outcome = await client.connect();

  // The session token is still cryptographically valid; the kill switch is checked against
  // live state, which is the point.
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'kill-switch');
});

test('when the agent disconnects, watching clients are told rather than left waiting', async () => {
  const client = await connectClient(await openSession(pcA, ['screen']));
  const outcome = await client.connect();
  assert.ok(outcome.accepted);

  agentA.close();

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && client.peerGone.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(client.peerGone.length > 0, true);
  assert.equal(client.peerGone[0]?.reason, 'agent-disconnected');
});

test('streams are closed when the agent goes away', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcA}/streams`,
    headers: { authorization: `Bearer ${accessToken}` },
  });

  const streams = JSON.parse(response.payload)['streams'] as unknown[];
  assert.equal(streams.length, 0, 'no stream is left looking live once its PC is gone');
});

/* ------------------------------------------------------------------------- */
/* ICE                                                                        */
/* ------------------------------------------------------------------------- */

test('ICE servers require the screen capability', async () => {
  const withoutScreen = await openSession(pcA, ['processes']);
  const refused = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcA}/ice-servers`,
    headers: { authorization: `Bearer ${withoutScreen}` },
  });
  assert.equal(refused.statusCode, 403);

  const withScreen = await openSession(pcA, ['screen']);
  const allowed = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcA}/ice-servers`,
    headers: { authorization: `Bearer ${withScreen}` },
  });
  assert.equal(allowed.statusCode, 200);
});

test('a stream request carries the ICE servers the agent is to use', async () => {
  await reconnectAgent();
  const sessionToken = await openSession(pcA, ['screen']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264'],
      requestAudio: false,
    },
  });

  const message = await agentA.waitForSignalMessage('stream.request', streamId);

  // The agent holds no TURN secret, so it cannot mint credentials and must be given them.
  // The field arriving — empty, with nothing configured in this deployment — is what
  // distinguishes "no relay is configured" from "the relay was never delivered".
  assert.ok(Array.isArray(message['iceServers']), 'the relay attached no ICE server list');
  assert.equal((message['iceServers'] as unknown[]).length, 0);
});

test('a client cannot choose the relay the agent will use', async () => {
  await reconnectAgent();
  const sessionToken = await openSession(pcA, ['screen']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264'],
      requestAudio: false,
    },
    // A client trying to point this PC's media at a server of its choosing. Relay
    // credentials are minted server-side, and the payload is validated against a schema
    // that has no such field, so this is dropped rather than forwarded.
    iceServers: [{ urls: ['turn:attacker.example.net:3478'], username: 'a', credential: 'b' }],
  } as never);

  const message = await agentA.waitForSignalMessage('stream.request', streamId);
  assert.deepEqual(message['iceServers'], []);

  const relayed = JSON.stringify(message);
  assert.ok(!relayed.includes('attacker.example.net'), 'a client-supplied relay reached the agent');
});

test('a session without the audio capability is not offered the sound', async () => {
  // `screen` but not `audio`: this operator may watch the machine and not listen to it.
  const sessionToken = await openSession(pcA, ['screen']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264'],
      // Asking is allowed; being given it is not the same thing.
      requestAudio: true,
    },
  });

  const message = await agentA.waitForSignalMessage('stream.request', streamId);

  // The PC cannot know what the session was granted — only the cloud sees that — so the
  // decision travels with the request rather than being left to the agent to assume.
  assert.equal(message['audioAllowed'], false);
});

test('a session granted audio is allowed to hear the PC', async () => {
  const sessionToken = await openSession(pcA, ['screen', 'audio']);
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264'],
      requestAudio: true,
    },
  });

  const message = await agentA.waitForSignalMessage('stream.request', streamId);
  assert.equal(message['audioAllowed'], true);
});

test('with no STUN or TURN configured, the limitation is stated rather than discovered', async () => {
  const sessionToken = await openSession(pcA, ['screen']);
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcA}/ice-servers`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });

  const body = JSON.parse(response.payload) as {
    reachability: string;
    note: string | null;
    configuration: { iceServers: unknown[] };
  };

  assert.equal(body.reachability, 'lan-only');
  assert.match(body.note ?? '', /local network/i);
  assert.equal(body.configuration.iceServers.length, 0);
});

/* ------------------------------------------------------------------------- */
/* Input arbitration                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Who is allowed to drive somebody's PC.
 *
 * The relay decides this, and it is the only party that can: the PC cannot see two sessions
 * competing for it, and a client deciding for itself is not a decision. These tests are
 * about that boundary — that a grant reaches both ends, that a second operator cannot take
 * the keyboard out of the first one's hands, and that a client cannot simply announce it
 * has control.
 */

async function openControlledStream(sessionToken: string): Promise<{
  client: FakeClient;
  sessionId: string;
  streamId: string;
}> {
  await reconnectAgent();
  const client = await connectClient(sessionToken);
  const outcome = await client.connect();
  assert.ok(outcome.accepted && outcome.sessionId);

  const streamId = newId();
  client.sendSignal(outcome.sessionId, streamId, {
    type: 'stream.request',
    request: {
      displayId: null,
      profile: PROFILE,
      clientCodecs: ['h264'],
      requestAudio: false,
    },
  });

  await agentA.waitForSignal('stream.request');
  return { client, sessionId: outcome.sessionId, streamId };
}

test('a session granted input receives control, and so does the PC', async () => {
  const sessionToken = await openSession(pcA, ['screen', 'input']);
  const { client, sessionId, streamId } = await openControlledStream(sessionToken);

  client.sendSignal(sessionId, streamId, { type: 'input.request' });

  const answer = await client.waitForSignal('input.control');
  assert.equal(answer.payload.type, 'input.control');
  if (answer.payload.type !== 'input.control') return;

  assert.equal(answer.payload.granted, true);
  assert.equal(answer.payload.holderSessionId, sessionId);
  assert.ok(answer.payload.expiresAt, 'a grant with no expiry would never lapse');

  // The PC is told the same thing. It is what gates injection, so a grant that reached only
  // the browser would leave a client believing it can type into a machine that will refuse.
  const toAgent = await agentA.waitForSignal('input.control');
  assert.equal(toAgent.payload.type, 'input.control');
  if (toAgent.payload.type !== 'input.control') return;
  assert.equal(toAgent.payload.granted, true);
  assert.equal(toAgent.payload.holderSessionId, sessionId);

  client.sendSignal(sessionId, streamId, { type: 'input.release' });
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('a session without the input capability is refused control and told why', async () => {
  const sessionToken = await openSession(pcA, ['screen']);
  const { client, sessionId, streamId } = await openControlledStream(sessionToken);

  client.sendSignal(sessionId, streamId, { type: 'input.request' });

  const answer = await client.waitForSignal('input.control');
  if (answer.payload.type !== 'input.control') throw new Error('wrong payload');

  // Watching and driving are separate grants. A session that asked only to watch does not
  // acquire the keyboard by asking a second time on a different channel.
  assert.equal(answer.payload.granted, false);
  assert.equal(answer.payload.reason, 'capability-missing');
});

test('a second operator cannot take the keyboard from the first', async () => {
  const firstToken = await openSession(pcA, ['screen', 'input']);
  const first = await openControlledStream(firstToken);

  first.client.sendSignal(first.sessionId, first.streamId, { type: 'input.request' });
  const granted = await first.client.waitForSignal('input.control');
  if (granted.payload.type !== 'input.control') throw new Error('wrong payload');
  assert.equal(granted.payload.granted, true);

  const secondToken = await openSession(pcA, ['screen', 'input']);
  const second = await openControlledStream(secondToken);

  second.client.sendSignal(second.sessionId, second.streamId, { type: 'input.request' });
  const refused = await second.client.waitForSignal('input.control');
  if (refused.payload.type !== 'input.control') throw new Error('wrong payload');

  // Taking control out of somebody's hands silently is what makes remote support
  // frightening. The second operator is told who has it, and an explicit transfer is a
  // separate, deliberate act.
  assert.equal(refused.payload.granted, false);
  assert.equal(refused.payload.reason, 'held-by-another-session');
  assert.equal(refused.payload.holderSessionId, first.sessionId);

  first.client.sendSignal(first.sessionId, first.streamId, { type: 'input.release' });
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('control is released when the operator lets go, and the PC is told', async () => {
  const sessionToken = await openSession(pcA, ['screen', 'input']);
  const { client, sessionId, streamId } = await openControlledStream(sessionToken);

  client.sendSignal(sessionId, streamId, { type: 'input.request' });
  await client.waitForSignal('input.control');

  client.sendSignal(sessionId, streamId, { type: 'input.release' });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const decisions = agentA.signalsReceived.filter(
    (envelope) => envelope.payload.type === 'input.control',
  );
  const last = decisions.at(-1);
  assert.ok(last);
  if (last.payload.type !== 'input.control') throw new Error('wrong payload');

  // The PC stops accepting input the moment it is told, rather than when the lease would
  // have lapsed on its own.
  assert.equal(last.payload.granted, false);
  assert.equal(last.payload.reason, 'released');

  // And the lease is free for the next session that asks.
  const nextToken = await openSession(pcA, ['screen', 'input']);
  const next = await openControlledStream(nextToken);
  next.client.sendSignal(next.sessionId, next.streamId, { type: 'input.request' });

  const answer = await next.client.waitForSignal('input.control');
  if (answer.payload.type !== 'input.control') throw new Error('wrong payload');
  assert.equal(answer.payload.granted, true);

  next.client.sendSignal(next.sessionId, next.streamId, { type: 'input.release' });
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('a client cannot announce that it has control', async () => {
  const sessionToken = await openSession(pcA, ['screen', 'input']);
  const { client, sessionId, streamId } = await openControlledStream(sessionToken);

  const before = agentA.signalsReceived.length;

  // `input.control` is in neither direction list, so neither end may author it. A client
  // that could would be granting itself the keyboard.
  client.sendSignal(sessionId, streamId, {
    type: 'input.control',
    granted: true,
    holderSessionId: sessionId,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    reason: 'granted',
  } as never);

  const error = await client.waitForSignal('stream.error');
  if (error.payload.type !== 'stream.error') throw new Error('wrong payload');
  assert.equal(error.payload.code, 'signal.wrong-direction');

  const forwarded = agentA.signalsReceived
    .slice(before)
    .filter((envelope) => envelope.payload.type === 'input.control');
  assert.equal(forwarded.length, 0, 'a forged grant reached the PC');
});

/* ------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* ------------------------------------------------------------------------- */

test('built-in profiles are offered so a new account has something usable', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/remote-desktop/profiles',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.payload) as {
    builtIn: { id: string; settings: { targetFps: number } }[];
    profiles: unknown[];
  };
  assert.equal(body.builtIn.length, 3);
  assert.deepEqual(body.profiles, []);
});

test('a saved profile round-trips and is validated on the way in', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/remote-desktop/profiles',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: 'Office',
      settings: { ...PROFILE, name: 'Office', targetFps: 30 },
      isDefault: true,
    },
  });
  assert.equal(created.statusCode, 201);

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/remote-desktop/profiles',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: 'Impossible',
      // Maximum below minimum: rejected at the schema, not stored and puzzled over later.
      settings: { ...PROFILE, name: 'Impossible', minBitrateBps: 20_000_000, maxBitrateBps: 1_000_000 },
    },
  });
  assert.equal(invalid.statusCode, 400);

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/remote-desktop/profiles',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = JSON.parse(listed.payload) as {
    profiles: { name: string; isDefault: boolean }[];
  };
  assert.equal(body.profiles.length, 1);
  assert.equal(body.profiles[0]?.name, 'Office');
  assert.equal(body.profiles[0]?.isDefault, true);
});

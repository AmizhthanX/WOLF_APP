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
import { AgentRegistry } from '@wolf/realtime/registry';
import { ClientRegistry } from '@wolf/realtime/client-registry';
import type { RealtimeContext } from '@wolf/realtime/context';
import { createRepositories, loadConfig, migrate } from '@wolf/server-core';
// Test-only: an in-process Postgres. Kept behind its own export so a production import
// graph can never reach it.
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, generateIdentityKeyPair, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';
import { FakeAgent } from './fake-agent.js';

/**
 * End to end: web client -> cloud API -> realtime link -> agent -> back again.
 *
 * Everything here is the real implementation: the real HTTP app with its real
 * authorization pipeline, the real agent link with its real handshake, and a real Postgres
 * engine. Only the Windows agent is substituted, by a Node process that speaks the same
 * protocol, because the point of this suite is the path between the pieces rather than the
 * Windows internals — those have their own tests in the .NET suite.
 */

const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let wsServer: Server;
let wss: WebSocketServer;
let registry: AgentRegistry;
let agentUrl: string;

let accessToken: string;
let pcId: string;
let agent: FakeAgent;
const agentKeys = generateIdentityKeyPair();

before(async () => {
  db = await createTestDatabase();
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/wolf',
    WOLF_TOKEN_SECRET: 'e2e-secret-key-that-is-long-enough-to-pass',
    WOLF_ALLOWED_ORIGINS: 'http://localhost:3000',
    WOLF_COMMAND_TTL_SECONDS: '60',
  } as NodeJS.ProcessEnv);

  const logger = pino({ level: 'silent' });
  const repos = createRepositories(db);

  context = {
    config,
    db,
    repos,
    logger,
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => new Date(),
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

  app = await buildApp(context);
  await app.ready();

  // The realtime service holds agent links; the API and it share one database.
  registry = new AgentRegistry();
  const realtimeContext: RealtimeContext = {
    config,
    db,
    repos,
    logger,
    now: () => new Date(),
    signer: createHmacSigner(config.tokens.secret),
    agents: registry,
    clients: new ClientRegistry(),
  };

  wsServer = createServer();
  wss = new WebSocketServer({ server: wsServer });
  wss.on('connection', (socket) => {
    new AgentLink({ socket, context: realtimeContext, remoteAddress: '127.0.0.1' });
  });

  await new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const address = wsServer.address();
  agentUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/agent`;
});

after(async () => {
  agent?.close();
  registry.closeAll('test-teardown');
  await app?.close();
  wss.close();
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await db.end();
});

async function json(response: { payload: string }): Promise<Record<string, never>> {
  return JSON.parse(response.payload);
}

test('the owner signs in and receives a short-lived access token', async () => {
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
  const body = await json(response);
  assert.ok(body['accessToken']);
  assert.ok(body['refreshToken']);
  accessToken = String(body['accessToken']);

  const lifetimeSeconds =
    (new Date(String(body['accessTokenExpiresAt'])).getTime() - Date.now()) / 1000;
  assert.ok(lifetimeSeconds <= 900, 'access tokens must stay short lived');
});

test('a wrong password is refused without revealing whether the account exists', async () => {
  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: OWNER_EMAIL,
      password: 'not-the-right-password',
      device: { kind: 'web', name: 'E2E browser' },
    },
  });
  const unknownAccount = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: 'nobody@example.com',
      password: 'not-the-right-password',
      device: { kind: 'web', name: 'E2E browser' },
    },
  });

  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(unknownAccount.statusCode, 401);

  const a = (await json(wrongPassword))['error'] as unknown as { cause: string };
  const b = (await json(unknownAccount))['error'] as unknown as { cause: string };
  assert.equal(a.cause, b.cause, 'the two failures must be indistinguishable');
});

test('unauthenticated requests are refused with a structured problem', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/pcs' });
  assert.equal(response.statusCode, 401);

  const problem = (await json(response))['error'] as unknown as {
    problem: string;
    cause: string;
    recommendedAction: string;
    referenceId: string;
  };
  assert.ok(problem.problem.length > 0);
  assert.ok(problem.cause.length > 0);
  assert.ok(problem.recommendedAction.length > 0);
  assert.match(problem.referenceId, /^WOLF-[A-Z]+-[0-9A-F]{4}$/);
});

test('a PC enrols with a single-use token and its identity key', async () => {
  const tokenResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/pcs/enrollment-tokens',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { label: 'E2E' },
  });
  assert.equal(tokenResponse.statusCode, 201);
  const enrollmentToken = String((await json(tokenResponse))['enrollmentToken']);

  const enrollResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/enroll',
    payload: {
      enrollmentToken,
      name: 'E2E PC',
      hostname: 'E2E-PC',
      agentVersion: '0.1.0-e2e',
      publicKey: agentKeys.publicKey,
    },
  });
  assert.equal(enrollResponse.statusCode, 201);
  pcId = String((await json(enrollResponse))['pcId']);

  // The token is single use: a second enrollment with it must fail.
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/enroll',
    payload: {
      enrollmentToken,
      name: 'Rogue PC',
      hostname: 'ROGUE',
      agentVersion: '0.1.0-e2e',
      publicKey: generateIdentityKeyPair().publicKey,
    },
  });
  assert.equal(replay.statusCode, 401);
});

test('the agent connects, authenticates, and reports its capabilities', async () => {
  agent = new FakeAgent({
    url: agentUrl,
    pcId,
    keys: agentKeys,
    supportedCommands: ['system.info', 'process.list', 'process.terminate', 'power.action', 'power.wake'],
    onCommand: (type, payload) => {
      if (type === 'power.wake') {
        return {
          targetPcId: (payload as { targetPcId: string }).targetPcId,
          method: 'lan-broadcast',
          packetsSent: 6,
          networks: 1,
          sentAt: new Date().toISOString(),
          confirmationPending: true,
        };
      }

      if (type === 'process.list') {
        return {
          sampledAt: new Date().toISOString(),
          processes: [
            {
              pid: 4821,
              parentPid: 900,
              name: 'notepad.exe',
              path: 'C:\\Windows\\System32\\notepad.exe',
              commandLine: null,
              userName: null,
              sessionId: 1,
              status: 'running',
              startedAt: new Date().toISOString(),
              cpuPercent: 0.4,
              cpuTimeSeconds: 12,
              workingSetBytes: 40_000_000,
              privateBytes: 30_000_000,
              gpuPercent: null,
              gpuMemoryBytes: null,
              threadCount: 12,
              handleCount: 300,
              diskReadBytesPerSecond: null,
              diskWriteBytesPerSecond: null,
              networkBytesPerSecond: null,
              priority: 'normal',
              publisher: null,
              signature: 'unknown',
              serviceNames: [],
              protectedProcess: false,
            },
          ],
          truncated: false,
          totalCount: 1,
        };
      }

      if (type === 'process.terminate') {
        return {
          pid: 4821,
          name: 'notepad.exe',
          method: 'graceful-close',
          childrenTerminated: 0,
          endedAt: new Date().toISOString(),
        };
      }

      if (type === 'power.action') {
        return {
          action: (payload as { action: string }).action,
          pendingActionId: null,
          runAt: new Date().toISOString(),
          completed: true,
        };
      }

      throw new Error(`unexpected command ${type}`);
    },
  });

  await agent.connect();
  assert.equal(agent.isAuthenticated, true);

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcId}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.statusCode, 200);

  const pc = (await json(response))['pc'] as unknown as {
    status: string;
    windowsSessionState: string;
    capabilities: { supportedCommands: string[]; secureDesktopCaptureAvailable: boolean };
    hardware: { cpuModel: string };
  };

  assert.equal(pc.status, 'online');
  assert.equal(pc.windowsSessionState, 'desktop');
  assert.equal(pc.hardware.cpuModel, 'Test CPU');
  assert.ok(pc.capabilities.supportedCommands.includes('process.list'));
  assert.equal(
    pc.capabilities.secureDesktopCaptureAvailable,
    false,
    'an unimplemented capability is reported as unavailable, not omitted',
  );
});

test('an impostor cannot connect with the right PC id but the wrong key', async () => {
  const impostor = new FakeAgent({
    url: agentUrl,
    pcId,
    keys: generateIdentityKeyPair(),
    supportedCommands: [],
  });

  await assert.rejects(impostor.connect(), /auth rejected: bad-signature/);
  impostor.close();
});

test('telemetry from the agent is stored and served back', async () => {
  agent.sendTelemetry(37.5);
  await waitFor(async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pcs/${pcId}/telemetry/latest`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sample = (await json(response))['sample'] as unknown as {
      cpu: { usagePercent: number };
    } | null;
    return sample?.cpu.usagePercent === 37.5;
  });
});

test('a session grants named capabilities and nothing more', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/sessions`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { mode: 'control', capabilities: ['processes'] },
  });

  assert.equal(response.statusCode, 201);
  const body = await json(response);
  const sessionToken = String(body['sessionToken']);

  // The granted capability works.
  const allowed = await dispatchCommand(sessionToken, { type: 'process.list', payload: {} });
  assert.equal(allowed.statusCode, 202);

  // A capability that was not granted does not.
  const refused = await dispatchCommand(sessionToken, {
    type: 'power.action',
    payload: { action: 'restart' },
  });
  assert.equal(refused.statusCode, 403);
  const problem = (await json(refused))['error'] as unknown as { code: string };
  assert.equal(problem.code, 'session.capability_missing');
});

test('a privileged capability cannot be requested at session start', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/sessions`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { mode: 'control', capabilities: ['privileged'] },
  });

  assert.equal(response.statusCode, 403);
});

test('a read command reaches the agent and its result comes back', async () => {
  const sessionToken = await openSession(['processes']);

  const dispatched = await dispatchCommand(sessionToken, {
    type: 'process.list',
    payload: { limit: 50 },
  });
  assert.equal(dispatched.statusCode, 202);
  const commandId = String(
    ((await json(dispatched))['command'] as unknown as { id: string }).id,
  );

  // The realtime instance holding this agent delivers the queued work.
  await registry.get(pcId)?.deliverPending();

  const command = await waitForCommand(commandId);
  assert.equal(command.status, 'completed');

  const result = command.result as { processes: { name: string }[]; totalCount: number };
  assert.equal(result.totalCount, 1);
  assert.equal(result.processes[0]?.name, 'notepad.exe');
  assert.ok(agent.received.some((entry) => entry.type === 'process.list'));
});

test('a medium-risk action is refused without a matching confirmation', async () => {
  const sessionToken = await openSession(['processes']);

  const unconfirmed = await dispatchCommand(sessionToken, {
    type: 'process.terminate',
    payload: { pid: 4821, expectedName: 'notepad.exe' },
  });

  assert.equal(unconfirmed.statusCode, 428);
  const problem = (await json(unconfirmed))['error'] as unknown as {
    code: string;
    context?: { riskLevel?: string };
  };
  assert.equal(problem.code, 'command.confirmation_required');
  assert.equal(problem.context?.riskLevel, 'medium', 'the client is told the level to confirm');

  const confirmed = await dispatchCommand(
    sessionToken,
    { type: 'process.terminate', payload: { pid: 4821, expectedName: 'notepad.exe' } },
    { confirmedRiskLevel: 'medium' },
  );
  assert.equal(confirmed.statusCode, 202);

  await registry.get(pcId)?.deliverPending();
  const command = await waitForCommand(
    String(((await json(confirmed))['command'] as unknown as { id: string }).id),
  );
  assert.equal(command.status, 'completed');
});

test('confirming a lower risk level than the server assigns is refused', async () => {
  const sessionToken = await openSession(['processes']);

  // The server escalates termination of a critical system process to critical risk, so a
  // "medium" confirmation must not authorize it.
  const response = await dispatchCommand(
    sessionToken,
    { type: 'process.terminate', payload: { pid: 704, expectedName: 'lsass.exe' } },
    { confirmedRiskLevel: 'medium' },
  );

  assert.equal(response.statusCode, 428);
  const problem = (await json(response))['error'] as unknown as { context?: { riskLevel?: string } };
  assert.equal(problem.context?.riskLevel, 'critical');
});

test('a high-risk action needs a fresh password even after confirmation', async () => {
  const sessionToken = await openSession(['power']);

  const response = await dispatchCommand(
    sessionToken,
    { type: 'power.action', payload: { action: 'restart' } },
    { confirmedRiskLevel: 'high' },
  );

  // The password was proven at sign-in moments ago, so this one is allowed through.
  assert.equal(response.statusCode, 202);

  await registry.get(pcId)?.deliverPending();
  const command = await waitForCommand(
    String(((await json(response))['command'] as unknown as { id: string }).id),
  );
  assert.equal(command.status, 'completed');
  assert.equal((command.result as { action: string }).action, 'restart');
});

test('a command an agent does not support is refused rather than queued', async () => {
  const sessionToken = await openSession(['processes']);

  const response = await dispatchCommand(sessionToken, { type: 'process.tree', payload: {} });
  assert.equal(response.statusCode, 409);

  const problem = (await json(response))['error'] as unknown as { code: string };
  assert.equal(problem.code, 'command.unsupported');
});

test('a repeated idempotency key does not run the action twice', async () => {
  const sessionToken = await openSession(['processes']);
  const listCommandsBefore = agent.received.filter((entry) => entry.type === 'process.list').length;

  const first = await dispatchCommand(
    sessionToken,
    { type: 'process.list', payload: {} },
    { idempotencyKey: 'e2e-repeat-0001' },
  );
  const second = await dispatchCommand(
    sessionToken,
    { type: 'process.list', payload: {} },
    { idempotencyKey: 'e2e-repeat-0001' },
  );

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 200);
  assert.equal((await json(second))['deduplicated'], true);

  await registry.get(pcId)?.deliverPending();
  await waitFor(
    async () =>
      agent.received.filter((entry) => entry.type === 'process.list').length >
      listCommandsBefore,
  );
  assert.equal(
    agent.received.filter((entry) => entry.type === 'process.list').length,
    listCommandsBefore + 1,
    'the retried command must reach the agent only once',
  );
});

test('every action is recorded in the audit log without payload secrets', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/pcs/${pcId}/audit?limit=100`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.statusCode, 200);

  const events = (await json(response))['events'] as unknown as {
    action: string;
    outcome: string;
    riskLevel: string;
    target: Record<string, unknown> | null;
  }[];

  assert.ok(events.some((event) => event.action === 'pc.enroll'));
  assert.ok(events.some((event) => event.action === 'session.create'));
  assert.ok(events.some((event) => event.action === 'process.terminate'));
  assert.ok(
    events.some((event) => event.action === 'process.terminate' && event.outcome === 'denied'),
    'the refused attempt is recorded too',
  );

  const terminate = events.find(
    (event) => event.action === 'process.terminate' && event.outcome === 'success',
  );
  assert.deepEqual(terminate?.target, { kind: 'process', pid: 4821, name: 'notepad.exe' });
});

test('a PC that reported a wired adapter and went offline is woken through another, at the address it reported', async () => {
  const towerKeys = generateIdentityKeyPair();
  const tokenResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/pcs/enrollment-tokens',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { label: 'Tower' },
  });
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/enroll',
    payload: {
      enrollmentToken: String((await json(tokenResponse))['enrollmentToken']),
      name: 'Tower',
      hostname: 'TOWER',
      agentVersion: '0.1.0-e2e',
      publicKey: towerKeys.publicKey,
    },
  });
  assert.equal(enrolled.statusCode, 201);
  const towerId = String((await json(enrolled))['pcId']);

  // The tower connects once, reporting its wired adapter, and goes to sleep.
  const tower = new FakeAgent({
    url: agentUrl,
    pcId: towerId,
    keys: towerKeys,
    supportedCommands: ['system.info'],
    capabilities: { wakeOnLanCapable: true, wakeMacAddress: '02:00:5e:77:00:01' },
  });
  await tower.connect();
  tower.close();
  await waitFor(async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/pcs/${towerId}`, headers: { authorization: `Bearer ${accessToken}` } });
    return ((await json(response))['pc'] as unknown as { status: string }).status !== 'online';
  });

  const listed = await app.inject({ method: 'GET', url: `/api/v1/pcs/${towerId}`, headers: { authorization: `Bearer ${accessToken}` } });
  const asleep = (await json(listed))['pc'] as unknown as { capabilities: Record<string, unknown> };
  assert.equal(asleep.capabilities['wakeAddressKnown'], true);
  assert.equal(asleep.capabilities['wakeOnLanCapable'], true);
  assert.ok(!listed.payload.includes('02:00:5e:77:00:01'), 'the address itself never reaches a client');

  const sessionToken = await openSession(['power']);

  // A PC cannot wake itself.
  const self = await dispatchCommand(sessionToken, { type: 'power.wake', payload: { targetPcId: pcId } }, { confirmedRiskLevel: 'medium' });
  assert.equal(self.statusCode, 409);

  // An address a client supplies is replaced with the one the tower reported.
  const woken = await dispatchCommand(
    sessionToken,
    { type: 'power.wake', payload: { targetPcId: towerId, macAddress: '02:00:00:00:00:99' } },
    { confirmedRiskLevel: 'medium' },
  );
  assert.equal(woken.statusCode, 202, woken.payload);
  await registry.get(pcId)?.deliverPending();
  const command = await waitForCommand(String(((await json(woken))['command'] as unknown as { id: string }).id));

  assert.equal(command.status, 'completed');
  assert.equal((command.result as { confirmationPending: boolean }).confirmationPending, true);
  const received = agent.received.find((entry) => entry.type === 'power.wake');
  assert.deepEqual(received?.payload, { targetPcId: towerId, macAddress: '02:00:5e:77:00:01' });

  const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM audit_logs WHERE action = 'power.wake'`);
  assert.ok(rows.length >= 2, 'the wake and the refused self-wake are both audited');
  assert.ok(!JSON.stringify(rows).includes('02:00:5e:77:00:01'), 'the audit trail names the PC, not its address');
});

test('the kill switch stops commands and cannot be released remotely', async () => {
  const sessionToken = await openSession(['processes']);

  const engage = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/kill-switch`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { remoteAccessEnabled: false, reason: 'e2e' },
  });
  assert.equal(engage.statusCode, 200);

  const refused = await dispatchCommand(sessionToken, { type: 'process.list', payload: {} });
  assert.equal(refused.statusCode, 409);
  const problem = (await json(refused))['error'] as unknown as { code: string };
  assert.equal(problem.code, 'pc.remote_access_disabled');

  // There is no request shape that re-enables it: the endpoint only accepts `false`.
  const release = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/kill-switch`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { remoteAccessEnabled: true },
  });
  assert.equal(release.statusCode, 400);
});

/* ------------------------------------------------------------------------- */

async function openSession(capabilities: string[]): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/sessions`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { mode: 'control', capabilities },
  });
  assert.equal(response.statusCode, 201);
  return String((await json(response))['sessionToken']);
}

async function dispatchCommand(
  sessionToken: string,
  command: { type: string; payload: Record<string, unknown> },
  options: { confirmedRiskLevel?: string; idempotencyKey?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/pcs/${pcId}/commands`,
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: {
      command,
      waitSeconds: 0,
      ...(options.confirmedRiskLevel ? { confirmedRiskLevel: options.confirmedRiskLevel } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    },
  });
}

async function waitForCommand(commandId: string): Promise<{ status: string; result: unknown }> {
  let command: { status: string; result: unknown } | null = null;

  await waitFor(async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pcs/${pcId}/commands/${commandId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await json(response))['command'] as unknown as {
      status: string;
      result: unknown;
    };
    command = body;
    return ['completed', 'failed', 'cancelled', 'expired', 'rejected'].includes(body.status);
  });

  assert.ok(command, 'the command never reached a terminal state');
  return command;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('timed out waiting for a condition');
}

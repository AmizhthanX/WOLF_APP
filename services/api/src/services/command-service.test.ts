import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { createHmacSigner } from '@wolf/auth';
import { isWolfError, newId, type SessionCapability } from '@wolf/shared-types';
import { ALL_COMMAND_TYPES } from '@wolf/protocol';
import { loadConfig } from '@wolf/server-core';
import { InMemoryRateLimiter } from '../http/rate-limit.js';
import type { AppContext } from '../http/context.js';
import type { RequestAuth } from '../http/auth.js';
import { CommandService } from './command-service.js';

/**
 * These tests exercise the authorization pipeline with in-memory doubles. They deliberately
 * assert on rejection reasons rather than on HTTP shape: the point is that a command that
 * should not run never reaches the command table at all.
 */

const USER = newId();
const DEVICE = newId();
const SESSION = newId();
const PC = newId();

interface Harness {
  context: AppContext;
  inserted: unknown[];
  audits: { action: string; outcome: string; errorCode?: string | null }[];
  notifications: unknown[];
  setPc(patch: Partial<{ status: string; remoteAccessEnabled: boolean }>): void;
  setSupportedCommands(commands: string[] | null): void;
  setGrant(valid: boolean): void;
  /** Another of the user's PCs, with the wake address it reported, if any. */
  addPc(pc: { id: string; name: string; status: string; remoteAccessEnabled?: boolean; registrationState?: string }, wakeAddress: string | null): void;
}

function createHarness(): Harness {
  const inserted: unknown[] = [];
  const audits: { action: string; outcome: string; errorCode?: string | null }[] = [];
  const notifications: unknown[] = [];

  const pc = {
    id: PC,
    userId: USER,
    name: 'Studio',
    status: 'online',
    registrationState: 'active',
    remoteAccessEnabled: true,
  };
  let supportedCommands: string[] | null = [...ALL_COMMAND_TYPES];
  let grantValid = true;
  const otherPcs = new Map<string, Record<string, unknown>>();
  const wakeAddresses = new Map<string, string | null>();

  const fakeClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  };

  const db = {
    query: async (sql: string) => {
      if (sql.includes('pg_notify')) {
        notifications.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM privileged_grants')) {
        return { rows: grantValid ? [{ id: 'grant' }] : [], rowCount: grantValid ? 1 : 0 };
      }
      if (sql.includes('UPDATE privileged_grants')) {
        return { rows: [], rowCount: grantValid ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => fakeClient,
  };

  const repos = {
    pcs: {
      findById: async (id: string) => (id === PC ? { ...pc } : otherPcs.has(id) ? { ...otherPcs.get(id) } : null),
      wakeAddress: async (id: string) => wakeAddresses.get(id) ?? null,
      getCapabilities: async () =>
        supportedCommands === null ? null : { supportedCommands },
    },
    sessions: {
      findActive: async () => ({ id: SESSION, route: 'lan' }),
      acquireResource: async () => ({ acquired: true, heldBy: SESSION }),
    },
    commands: {
      create: async (input: unknown) => {
        inserted.push(input);
        return { created: true, command: { ...(input as object), status: 'pending' } };
      },
      findById: async () => null,
      complete: async () => true,
    },
    audit: {
      record: async (entry: { action: string; outcome: string; errorCode?: string | null }) => {
        audits.push(entry);
        return 'audit-id';
      },
      recordSecurityEvent: async () => {},
    },
  };

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/wolf_test',
    WOLF_TOKEN_SECRET: 'x'.repeat(48),
  } as NodeJS.ProcessEnv);

  const context = {
    config,
    db,
    repos,
    logger: pino({ level: 'silent' }),
    signer: createHmacSigner('x'.repeat(48)),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => new Date('2026-09-06T12:00:00.000Z'),
  } as unknown as AppContext;

  return {
    context,
    inserted,
    audits,
    notifications,
    setPc(patch) {
      Object.assign(pc, patch);
    },
    setSupportedCommands(commands) {
      supportedCommands = commands;
    },
    setGrant(valid) {
      grantValid = valid;
    },
    addPc(other, wakeAddress) {
      otherPcs.set(other.id, { userId: USER, registrationState: 'active', remoteAccessEnabled: true, ...other });
      wakeAddresses.set(other.id, wakeAddress);
    },
  };
}

function authFor(capabilities: SessionCapability[], authTimeSecondsAgo = 10): RequestAuth {
  const nowSeconds = Math.floor(new Date('2026-09-06T12:00:00.000Z').getTime() / 1000);
  return {
    userId: USER,
    deviceId: DEVICE,
    sessionId: SESSION,
    pcId: PC,
    capabilities,
    claims: {
      sub: USER,
      did: DEVICE,
      sid: SESSION,
      pid: PC,
      cap: capabilities,
      auth_time: nowSeconds - authTimeSecondsAgo,
      jti: 'jti',
      iss: 'https://api.amizhthan.app',
      aud: 'wolf-client',
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + 600,
    },
  };
}

function dispatchInput(overrides: Record<string, unknown> = {}) {
  return {
    auth: authFor(['processes', 'power']),
    pcId: PC,
    command: { type: 'process.list', payload: {} },
    idempotencyKey: 'key-0001',
    requestId: newId(),
    sourceIp: '10.0.0.5',
    ...overrides,
  } as Parameters<CommandService['dispatch']>[0];
}

async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    assert.fail(`expected the command to be rejected with ${code}`);
  } catch (error) {
    assert.ok(isWolfError(error), `expected a WolfError, got ${String(error)}`);
    assert.equal(error.code, code);
  }
}

/* ------------------------------------------------------------------------- */
/* Wake-on-LAN                                                               */
/* ------------------------------------------------------------------------- */

const ASLEEP = newId();

function wakeInput(targetPcId: string, extra: Record<string, unknown> = {}) {
  return dispatchInput({
    command: { type: 'power.wake', payload: { targetPcId, ...extra } },
    confirmedRiskLevel: 'medium',
  });
}

test('a wake goes to an online PC, addressed with what the sleeping PC reported', async () => {
  const harness = createHarness();
  harness.addPc({ id: ASLEEP, name: 'Tower', status: 'offline' }, 'd8:bb:c1:0a:2b:3c');

  await new CommandService(harness.context).dispatch(wakeInput(ASLEEP));

  const created = harness.inserted[0] as { pcId: string; payload: { payload: Record<string, unknown> } };
  assert.equal(created.pcId, PC, 'sent to the PC that is awake');
  assert.deepEqual(created.payload.payload, { targetPcId: ASLEEP, macAddress: 'd8:bb:c1:0a:2b:3c' });
});

test('an address a client puts in a wake is replaced, never used', async () => {
  const harness = createHarness();
  harness.addPc({ id: ASLEEP, name: 'Tower', status: 'offline' }, 'd8:bb:c1:0a:2b:3c');

  await new CommandService(harness.context).dispatch(wakeInput(ASLEEP, { macAddress: '02:00:00:00:00:99' }));

  const created = harness.inserted[0] as { payload: { payload: { macAddress: string } } };
  assert.equal(created.payload.payload.macAddress, 'd8:bb:c1:0a:2b:3c');
});

test('a wake is refused before anything is queued when it cannot be addressed', async () => {
  const cases: [string, (harness: Harness) => string, string, string][] = [
    ['a PC that is not the caller’s', () => newId(), 'resource.not_found', 'wake-target-unknown'],
    ['the sending PC itself', () => PC, 'resource.conflict', 'wake-self'],
    [
      'a PC already online',
      (harness) => {
        harness.addPc({ id: ASLEEP, name: 'Tower', status: 'online' }, 'd8:bb:c1:0a:2b:3c');
        return ASLEEP;
      },
      'resource.conflict',
      'wake-target-online',
    ],
    [
      'a PC with remote access switched off',
      (harness) => {
        harness.addPc({ id: ASLEEP, name: 'Tower', status: 'offline', remoteAccessEnabled: false }, 'd8:bb:c1:0a:2b:3c');
        return ASLEEP;
      },
      'pc.remote_access_disabled',
      'kill-switch',
    ],
    [
      'a PC that never reported a wired adapter',
      (harness) => {
        harness.addPc({ id: ASLEEP, name: 'Laptop', status: 'offline' }, null);
        return ASLEEP;
      },
      'pc.wake_address_unknown',
      'wake-address-unknown',
    ],
  ];

  for (const [label, target, code, audited] of cases) {
    const harness = createHarness();
    const targetId = target(harness);
    await expectRejection(new CommandService(harness.context).dispatch(wakeInput(targetId)), code);
    assert.equal(harness.inserted.length, 0, `${label}: nothing queued`);
    assert.equal(harness.audits.at(-1)?.errorCode, audited, label);
  }
});

test('a wake still needs the confirmation its risk level asks for', async () => {
  const harness = createHarness();
  harness.addPc({ id: ASLEEP, name: 'Tower', status: 'offline' }, 'd8:bb:c1:0a:2b:3c');

  await expectRejection(
    new CommandService(harness.context).dispatch(
      dispatchInput({ command: { type: 'power.wake', payload: { targetPcId: ASLEEP } } }),
    ),
    'command.confirmation_required',
  );
  assert.equal(harness.inserted.length, 0);
});

test('a low-risk read dispatches without confirmation', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  const outcome = await service.dispatch(dispatchInput());
  assert.equal(outcome.created, true);
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.notifications.length, 1, 'the agent link is notified');
});

test('a command without the required capability is refused and audited', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  await expectRejection(
    service.dispatch(dispatchInput({ auth: authFor(['screen']) })),
    'session.capability_missing',
  );
  assert.equal(harness.inserted.length, 0, 'nothing was queued');
  assert.equal(harness.audits.at(-1)?.outcome, 'denied');
  assert.equal(harness.audits.at(-1)?.errorCode, 'capability-missing');
});

test('a medium-risk action requires a matching confirmation', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);
  const command = {
    type: 'process.terminate',
    payload: { pid: 4821, expectedName: 'notepad.exe' },
  };

  await expectRejection(
    service.dispatch(dispatchInput({ command })),
    'command.confirmation_required',
  );

  const outcome = await service.dispatch(
    dispatchInput({ command, confirmedRiskLevel: 'medium' }),
  );
  assert.equal(outcome.created, true);
});

test('confirming the wrong risk level does not authorize an escalated command', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  // The operator confirmed a routine termination; the server classifies this one critical.
  await expectRejection(
    service.dispatch(
      dispatchInput({
        command: { type: 'process.terminate', payload: { pid: 704, expectedName: 'lsass.exe' } },
        confirmedRiskLevel: 'medium',
      }),
    ),
    'command.confirmation_required',
  );
  assert.equal(harness.inserted.length, 0);
});

test('a high-risk action requires a recent password re-entry', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);
  const command = { type: 'power.action', payload: { action: 'restart' } };

  await expectRejection(
    service.dispatch(
      dispatchInput({
        auth: authFor(['processes', 'power'], 1200),
        command,
        confirmedRiskLevel: 'high',
      }),
    ),
    'command.reauth_required',
  );

  const outcome = await service.dispatch(
    dispatchInput({
      auth: authFor(['processes', 'power'], 30),
      command,
      confirmedRiskLevel: 'high',
    }),
  );
  assert.equal(outcome.created, true);
});

test('a critical action requires a privileged grant even with a fresh password', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);
  const command = { type: 'power.unlock', payload: { credentialId: 'unlock-1' } };

  await expectRejection(
    service.dispatch(
      dispatchInput({
        auth: authFor(['privileged'], 10),
        command,
        confirmedRiskLevel: 'critical',
      }),
    ),
    'command.privileged_grant_required',
  );

  const outcome = await service.dispatch(
    dispatchInput({
      auth: authFor(['privileged'], 10),
      command,
      confirmedRiskLevel: 'critical',
      privilegedGrantId: newId(),
    }),
  );
  assert.equal(outcome.created, true);
});

test('an invalid or already-consumed grant does not authorize a critical action', async () => {
  const harness = createHarness();
  harness.setGrant(false);
  const service = new CommandService(harness.context);

  await expectRejection(
    service.dispatch(
      dispatchInput({
        auth: authFor(['privileged'], 10),
        command: { type: 'power.unlock', payload: { credentialId: 'unlock-1' } },
        confirmedRiskLevel: 'critical',
        privilegedGrantId: newId(),
      }),
    ),
    'command.privileged_grant_required',
  );
});

test('the kill switch blocks every command, including reads', async () => {
  const harness = createHarness();
  harness.setPc({ remoteAccessEnabled: false });
  const service = new CommandService(harness.context);

  await expectRejection(service.dispatch(dispatchInput()), 'pc.remote_access_disabled');
  assert.equal(harness.inserted.length, 0);
});

test('a command an agent does not support is refused rather than queued', async () => {
  const harness = createHarness();
  harness.setSupportedCommands(['system.info']);
  const service = new CommandService(harness.context);

  await expectRejection(service.dispatch(dispatchInput()), 'command.unsupported');
  assert.equal(harness.inserted.length, 0, 'work that can never run must not be queued');
});

test('a command for an offline PC is refused rather than queued', async () => {
  const harness = createHarness();
  harness.setPc({ status: 'offline' });
  const service = new CommandService(harness.context);

  await expectRejection(service.dispatch(dispatchInput()), 'pc.offline');
  assert.equal(harness.inserted.length, 0);
});

test('a malformed command payload never reaches the command table', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  await expectRejection(
    service.dispatch(dispatchInput({ command: { type: 'process.terminate', payload: { pid: 0 } } })),
    'validation.failed',
  );
  await expectRejection(
    service.dispatch(dispatchInput({ command: { type: 'process.inject', payload: {} } })),
    'validation.failed',
  );
  assert.equal(harness.inserted.length, 0);
});

test('the queued command records the authorization it was granted under', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  await service.dispatch(
    dispatchInput({
      command: { type: 'process.terminate', payload: { pid: 4821, expectedName: 'notepad.exe' } },
      confirmedRiskLevel: 'medium',
    }),
  );

  const record = harness.inserted[0] as {
    riskLevel: string;
    authorization: { confirmedAt: string | null; grantedCapabilities: string[] };
  };
  assert.equal(record.riskLevel, 'medium');
  assert.equal(record.authorization.confirmedAt, '2026-09-06T12:00:00.000Z');
  assert.deepEqual(record.authorization.grantedCapabilities, ['processes', 'power']);
});

test('audit records for a queued command carry the target, not the payload', async () => {
  const harness = createHarness();
  const service = new CommandService(harness.context);

  await service.dispatch(
    dispatchInput({
      command: { type: 'process.terminate', payload: { pid: 4821, expectedName: 'notepad.exe' } },
      confirmedRiskLevel: 'medium',
    }),
  );

  const audit = harness.audits.at(-1) as unknown as {
    action: string;
    outcome: string;
    target: Record<string, unknown>;
  };
  assert.equal(audit.action, 'process.terminate');
  assert.equal(audit.outcome, 'pending');
  assert.deepEqual(audit.target, { kind: 'process', pid: 4821, name: 'notepad.exe' });
});

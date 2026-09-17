import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newId, type SessionCapability } from '@wolf/shared-types';
import { BUILT_IN_PROFILES } from '@wolf/protocol';
import { migrate } from './migrate.js';
import { createRepositories, type Repositories } from './repositories/index.js';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.js';

/**
 * Schema and repository behaviour, exercised against a real Postgres engine.
 *
 * These cover the guarantees that live in the database rather than in application code:
 * only one owner account can exist, an idempotency key cannot run a command twice, an
 * exclusive resource cannot be held by two sessions, and a revoked PC stops resolving.
 * Asserting them here means they survive a refactor of the code above them.
 */

let db: TestDatabase;
let repos: Repositories;
let userId: string;

before(async () => {
  db = await createTestDatabase();
  await migrate(db);
  repos = createRepositories(db);

  const owner = await repos.users.createOwner({
    id: newId(),
    email: 'owner@example.com',
    passwordHash: 'scrypt$4096$8$1$c2FsdA$aGFzaA',
    displayName: 'Owner',
  });
  userId = owner.id;
});

after(async () => {
  await db.end();
});

async function createPc(name: string): Promise<string> {
  const pc = await repos.pcs.create({
    id: newId(),
    userId,
    name,
    hostname: `${name}-host`,
    publicKey: 'cHVibGljLWtleQ',
    agentVersion: '0.1.0',
  });
  return pc.id;
}

test('every migration applies and is recorded', async () => {
  const { rows } = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  assert.ok(rows.length >= 3, 'expected the core, telemetry, and privilege migrations');
});

test('migrations are idempotent', async () => {
  const result = await migrate(db);
  assert.equal(result.applied.length, 0);
  assert.ok(result.skipped.length >= 3);
});

test('a second owner account cannot be created', async () => {
  await assert.rejects(
    repos.users.createOwner({
      id: newId(),
      email: 'intruder@example.com',
      passwordHash: 'scrypt$4096$8$1$c2FsdA$aGFzaA',
      displayName: 'Intruder',
    }),
    /duplicate key|unique/i,
    'the single-owner index must reject a second account',
  );
});

test('the owner can be found by email, case-insensitively on input', async () => {
  const found = await repos.users.findByEmail('OWNER@EXAMPLE.COM');
  assert.equal(found?.id, userId);
});

test('a PC round-trips and appears in the account listing', async () => {
  const pcId = await createPc('Studio');
  const pc = await repos.pcs.findById(pcId, userId);

  assert.equal(pc?.name, 'Studio');
  assert.equal(pc?.status, 'offline');
  assert.equal(pc?.remoteAccessEnabled, true);

  const listed = await repos.pcs.listForUser(userId);
  assert.ok(listed.some((entry) => entry.id === pcId));
});

test('two PCs on one account cannot share a name', async () => {
  await createPc('Duplicate');
  await assert.rejects(createPc('Duplicate'), /duplicate key|unique/i);
});

test('a revoked PC drops out of the listing and loses remote access', async () => {
  const pcId = await createPc('Retired');
  assert.equal(await repos.pcs.revoke(pcId, userId), true);

  const listed = await repos.pcs.listForUser(userId);
  assert.ok(!listed.some((entry) => entry.id === pcId));

  const identity = await repos.pcs.findIdentity(pcId);
  assert.equal(identity?.registrationState, 'revoked');
  assert.equal(identity?.remoteAccessEnabled, false);
});

test('the cloud cannot re-enable remote access, only disable it', async () => {
  const pcId = await createPc('KillSwitch');

  assert.equal(await repos.pcs.setRemoteAccess(pcId, userId, false, 'remote'), true);
  assert.equal((await repos.pcs.findById(pcId, userId))?.remoteAccessEnabled, false);

  await assert.rejects(
    repos.pcs.setRemoteAccess(pcId, userId, true, 'remote'),
    /cannot re-enable/i,
    'only a local operator may release the kill switch',
  );

  // A local release, reported by the agent, is allowed.
  assert.equal(await repos.pcs.setRemoteAccess(pcId, userId, true, 'local'), true);
  assert.equal((await repos.pcs.findById(pcId, userId))?.remoteAccessEnabled, true);
});

test('capabilities and hardware upsert rather than duplicate', async () => {
  const pcId = await createPc('Capable');

  await repos.pcs.upsertCapabilities(pcId, {
    hardwareVideoEncoders: [],
    preferredVideoCodec: null,
    displayCount: 2,
    audioCaptureAvailable: false,
    wakeOnLanCapable: false,
    privilegedHelperAvailable: false,
    secureDesktopCaptureAvailable: false,
    remoteUnlockProvisioned: false,
    gpuVendors: ['NVIDIA'],
    windowsBuild: '26100.1',
    supportedCommands: ['system.info', 'process.list'],
    remoteDesktopAvailable: false,
    remoteDesktopUnavailableReason: 'no-session-host',
    videoEncoders: [],
  });

  await repos.pcs.upsertCapabilities(pcId, {
    hardwareVideoEncoders: ['h264'],
    preferredVideoCodec: 'h264',
    displayCount: 3,
    audioCaptureAvailable: true,
    wakeOnLanCapable: true,
    privilegedHelperAvailable: false,
    secureDesktopCaptureAvailable: false,
    remoteUnlockProvisioned: false,
    gpuVendors: ['NVIDIA'],
    windowsBuild: '26100.2',
    supportedCommands: ['system.info', 'process.list', 'power.action'],
    remoteDesktopAvailable: true,
    remoteDesktopUnavailableReason: null,
    videoEncoders: ['h264-hardware', 'h264-software'],
  });

  const capabilities = await repos.pcs.getCapabilities(pcId);
  assert.equal(capabilities?.displayCount, 3);
  assert.deepEqual(capabilities?.supportedCommands, [
    'system.info',
    'process.list',
    'power.action',
  ]);

  // Having an encoder and being able to stream are separate facts, and both round-trip.
  assert.equal(capabilities?.remoteDesktopAvailable, true);
  assert.equal(capabilities?.remoteDesktopUnavailableReason, null);
  assert.deepEqual(capabilities?.videoEncoders, ['h264-hardware', 'h264-software']);
});

test('a wake address is kept, never cleared by a report without one, and only whether it is known is exposed', async () => {
  const pcId = await createPc('Wakeable');
  const base = {
    hardwareVideoEncoders: [],
    preferredVideoCodec: null,
    displayCount: 1,
    audioCaptureAvailable: false,
    wakeOnLanCapable: true,
    privilegedHelperAvailable: false,
    secureDesktopCaptureAvailable: false,
    remoteUnlockProvisioned: false,
    gpuVendors: [],
    windowsBuild: null,
    supportedCommands: ['power.wake'],
    remoteDesktopAvailable: false,
    remoteDesktopUnavailableReason: null,
    videoEncoders: [],
  };
  await repos.pcs.upsertCapabilities(pcId, base);
  assert.equal((await repos.pcs.getCapabilities(pcId))?.wakeAddressKnown, false);

  await repos.pcs.recordWakeAddress(pcId, 'd8:bb:c1:0a:2b:3c');
  await repos.pcs.recordWakeAddress(pcId, null);

  assert.equal((await repos.pcs.getCapabilities(pcId))?.wakeAddressKnown, true);
  assert.equal(await repos.pcs.wakeAddress(pcId, userId), 'd8:bb:c1:0a:2b:3c');
  assert.equal(await repos.pcs.wakeAddress(pcId, '01J9ZQK7T0000000000000ZZZZ'), null, 'another user is not told it');
});

test('a PC with encoders but no way to capture is not reported as able to stream', async () => {
  const pcId = await createPc('EncoderNoCapture');

  await repos.pcs.upsertCapabilities(pcId, {
    hardwareVideoEncoders: ['h264-hardware'],
    preferredVideoCodec: 'h264',
    displayCount: 1,
    audioCaptureAvailable: false,
    wakeOnLanCapable: false,
    privilegedHelperAvailable: false,
    secureDesktopCaptureAvailable: false,
    remoteUnlockProvisioned: false,
    gpuVendors: ['Intel'],
    windowsBuild: '26100.1',
    supportedCommands: ['system.info'],
    // The machine can encode. Nobody is signed in, so it cannot capture.
    remoteDesktopAvailable: false,
    remoteDesktopUnavailableReason: 'no-session-host',
    videoEncoders: ['h264-hardware', 'h264-software'],
  });

  const capabilities = await repos.pcs.getCapabilities(pcId);
  assert.equal(capabilities?.hardwareVideoEncoders.length, 1, 'the hardware is present');
  assert.equal(capabilities?.remoteDesktopAvailable, false, 'but streaming is not possible');
  assert.equal(capabilities?.remoteDesktopUnavailableReason, 'no-session-host');
});

test('a repeated idempotency key returns the original command', async () => {
  const pcId = await createPc('Idempotent');
  const deviceId = await createDevice();

  const input = {
    pcId,
    sessionId: null,
    userId,
    deviceId,
    requestId: newId(),
    type: 'process.list' as const,
    riskLevel: 'low' as const,
    payload: { type: 'process.list', payload: { limit: 100 } } as never,
    authorization: {} as never,
    idempotencyKey: 'retry-me-0001',
    expiresAt: new Date(Date.now() + 60_000),
  };

  const first = await repos.commands.create({ ...input, id: newId() });
  const second = await repos.commands.create({ ...input, id: newId() });

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'a retry must not create a second command');
  assert.equal(second.command.id, first.command.id);
});

test('claiming pending commands hands each one out exactly once', async () => {
  const pcId = await createPc('Claiming');
  const deviceId = await createDevice();

  for (let index = 0; index < 3; index++) {
    await repos.commands.create({
      id: newId(),
      pcId,
      sessionId: null,
      userId,
      deviceId,
      requestId: newId(),
      type: 'process.list',
      riskLevel: 'low',
      payload: { type: 'process.list', payload: {} } as never,
      authorization: {} as never,
      idempotencyKey: `claim-${index}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  const firstClaim = await repos.commands.claimPending(pcId);
  const secondClaim = await repos.commands.claimPending(pcId);

  assert.equal(firstClaim.length, 3);
  assert.equal(secondClaim.length, 0, 'claimed commands must not be handed out again');
});

test('an overdue command expires instead of waiting to run late', async () => {
  const pcId = await createPc('Expiring');
  const deviceId = await createDevice();

  const created = await repos.commands.create({
    id: newId(),
    pcId,
    sessionId: null,
    userId,
    deviceId,
    requestId: newId(),
    type: 'power.action',
    riskLevel: 'high',
    payload: { type: 'power.action', payload: { action: 'shutdown' } } as never,
    authorization: {} as never,
    idempotencyKey: 'overdue-1',
    expiresAt: new Date(Date.now() - 1000),
  });

  const expired = await repos.commands.expireOverdue(new Date());
  assert.ok(expired.some((command) => command.id === created.command.id));

  const reloaded = await repos.commands.findById(created.command.id);
  assert.equal(reloaded?.status, 'expired');

  const claimed = await repos.commands.claimPending(pcId);
  assert.equal(claimed.length, 0, 'an expired command is never delivered');
});

test('an exclusive resource is held by one session at a time', async () => {
  const pcId = await createPc('Arbitrated');
  const deviceId = await createDevice();
  const expiresAt = new Date(Date.now() + 3_600_000);

  const first = await repos.sessions.create({
    id: newId(),
    userId,
    deviceId,
    pcId,
    mode: 'control',
    capabilities: ['power'],
    route: 'lan',
    expiresAt,
  });
  const second = await repos.sessions.create({
    id: newId(),
    userId,
    deviceId,
    pcId,
    mode: 'control',
    capabilities: ['power'],
    route: 'lan',
    expiresAt,
  });

  const taken = await repos.sessions.acquireResource({
    pcId,
    resource: 'power',
    sessionId: first.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(taken.acquired, true);

  const contested = await repos.sessions.acquireResource({
    pcId,
    resource: 'power',
    sessionId: second.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(contested.acquired, false);
  assert.equal(contested.heldBy, first.id);

  // A different resource is arbitrated independently.
  const terminal = await repos.sessions.acquireResource({
    pcId,
    resource: 'terminal',
    sessionId: second.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(terminal.acquired, true);

  // Releasing hands it over.
  assert.equal(await repos.sessions.releaseResource(pcId, 'power', first.id), true);
  const afterRelease = await repos.sessions.acquireResource({
    pcId,
    resource: 'power',
    sessionId: second.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(afterRelease.acquired, true);
});

test('a PC is in use only while a session streams or holds a lease, not while one merely stays open', async () => {
  const pcId = await createPc('InUse');
  const deviceId = await createDevice();
  const open = (capabilities: SessionCapability[]) =>
    repos.sessions.create({ id: newId(), userId, deviceId, pcId, mode: 'control', capabilities, route: 'lan', expiresAt: new Date(Date.now() + 3_600_000) });

  // The session a phone opens to show the PC's page.
  const browsing = await open(['power']);
  assert.equal(await repos.sessions.countActiveForPc(pcId), 1);
  assert.equal(await repos.sessions.countInUseForPc(pcId), 0, 'looking at a PC is not using it');

  const watching = await open(['screen']);
  const stream = await repos.remoteDesktop.createStream({
    id: newId(), sessionId: watching.id, pcId, userId, deviceId, displayId: null, audioEnabled: false,
    requestedProfile: BUILT_IN_PROFILES['lan-maximum-quality']!,
  });
  assert.equal(await repos.sessions.countInUseForPc(pcId), 1);
  await repos.remoteDesktop.endStream(stream.id, 'client-closed');
  assert.equal(await repos.sessions.countInUseForPc(pcId), 0);

  await repos.sessions.acquireResource({ pcId, resource: 'terminal', sessionId: browsing.id, expiresAt: new Date(Date.now() + 60_000) });
  assert.equal(await repos.sessions.countInUseForPc(pcId), 1, 'a held terminal is somebody at the PC');
  await repos.sessions.releaseResource(pcId, 'terminal', browsing.id);
  assert.equal(await repos.sessions.countInUseForPc(pcId), 0);
});

test('an expired lease can be taken over without an explicit release', async () => {
  const pcId = await createPc('LeaseExpiry');
  const deviceId = await createDevice();
  const expiresAt = new Date(Date.now() + 3_600_000);

  const idle = await repos.sessions.create({
    id: newId(),
    userId,
    deviceId,
    pcId,
    mode: 'control',
    capabilities: ['power'],
    route: 'lan',
    expiresAt,
  });
  const waiting = await repos.sessions.create({
    id: newId(),
    userId,
    deviceId,
    pcId,
    mode: 'control',
    capabilities: ['power'],
    route: 'lan',
    expiresAt,
  });

  await repos.sessions.acquireResource({
    pcId,
    resource: 'input',
    sessionId: idle.id,
    expiresAt: new Date(Date.now() - 1000),
  });

  const takeover = await repos.sessions.acquireResource({
    pcId,
    resource: 'input',
    sessionId: waiting.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(takeover.acquired, true, 'an idle operator must not hold input forever');
});

test('telemetry lands in a daily partition and reads back', async () => {
  const pcId = await createPc('Telemetry');
  const sampledAt = new Date().toISOString();

  const inserted = await repos.telemetry.insertBatch(pcId, [
    { sampledAt, cpu: { usagePercent: 42 } } as never,
  ]);
  assert.equal(inserted, 1);

  // A resent sample from an agent replaying its offline buffer must not fail the batch.
  const duplicate = await repos.telemetry.insertBatch(pcId, [
    { sampledAt, cpu: { usagePercent: 42 } } as never,
  ]);
  assert.equal(duplicate, 0);

  const latest = await repos.telemetry.latestSample(pcId);
  assert.equal((latest?.sample as { cpu: { usagePercent: number } }).cpu.usagePercent, 42);
});

test('audit records are written and queried back in time order', async () => {
  const pcId = await createPc('Audited');

  await repos.audit.record({
    category: 'process',
    action: 'process.terminate',
    outcome: 'success',
    riskLevel: 'medium',
    userId,
    pcId,
    target: { kind: 'process', pid: 4821, name: 'notepad.exe' },
  });

  const events = await repos.audit.query({ userId, pcId });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, 'process.terminate');
  assert.deepEqual(events[0]?.target, { kind: 'process', pid: 4821, name: 'notepad.exe' });
});

test('audit records never persist secrets handed to them', async () => {
  const pcId = await createPc('Redacted');

  await repos.audit.record({
    category: 'terminal',
    action: 'terminal.execute',
    outcome: 'success',
    riskLevel: 'high',
    userId,
    pcId,
    afterValue: { stdout: 'C:\\> whoami', password: 'hunter2', exitCode: 0 },
  });

  const events = await repos.audit.query({ userId, pcId });
  const after = events[0]?.afterValue as Record<string, unknown>;
  assert.equal(after['stdout'], '[redacted]');
  assert.equal(after['password'], '[redacted]');
  assert.equal(after['exitCode'], 0, 'metadata is still recorded');
});

async function createDevice(): Promise<string> {
  const device = await repos.devices.create({
    id: newId(),
    userId,
    kind: 'web',
    name: 'Test browser',
    platform: 'test',
    publicKey: null,
  });
  return device.id;
}

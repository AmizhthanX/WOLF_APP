import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { AutomationExecutor, AutomationJob } from '@wolf/api/automation';
import { createRepositories, loadConfig, migrate, withTransaction, type CommandRecord } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';

/**
 * Automations, end to end: saving one is authorizing it, and running one acts on that authority.
 *
 * The things that must hold, each a test: nothing critical can be automated; a high-risk automation
 * needs the same confirmation and password a person's command does; a run sends commands on the same
 * audited path; a cooldown and a scheduled minute are claimed once however many instances race; and
 * revoking the device an automation was saved from ends its authority.
 *
 * The agent is played by completing command rows directly, which is what the realtime service does
 * when an agent answers.
 */

const OWNER_EMAIL = 'automation-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let userId: string;
let pcId: string;
let token: string;
let deviceId: string;
let clock: Date;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function login(name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, device: { kind: 'web', name } },
  });
  assert.equal(response.statusCode, 200, response.payload);
  return String(JSON.parse(response.payload).accessToken);
}

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

  clock = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const repos = createRepositories(db);
  context = {
    config,
    db,
    repos,
    logger: pino({ level: 'silent' }),
    signer: createHmacSigner(config.tokens.secret),
    rateLimiter: new InMemoryRateLimiter(),
    now: () => clock,
  };

  const owner = await repos.users.createOwner({
    id: newId(),
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(OWNER_PASSWORD, { cost: 2 ** 12, blockSize: 8, parallelization: 1, keyLength: 32 }),
    displayName: 'Owner',
  });
  userId = owner.id;

  app = await buildApp(context);
  await app.ready();

  token = await login('Automation browser');
  deviceId = (await repos.devices.listForUser(userId))[0]!.id;
});

beforeEach(async () => {
  clock = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  await db.query('DELETE FROM automations');
  await db.query('DELETE FROM notifications');

  const pc = await context.repos.pcs.create({
    id: newId(),
    userId,
    name: `PC-${newId().slice(-4)}`,
    hostname: null,
    publicKey: 'a'.repeat(64),
    agentVersion: null,
  });
  pcId = pc.id;
  await db.query(`UPDATE pcs SET registration_state = 'active', status = 'online' WHERE id = $1`, [pcId]);
});

after(async () => {
  await app?.close();
  await db.end();
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, bearer = token) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const notify = { kind: 'notify', severity: 'info', message: 'Nightly check ran' };
const restartService = {
  kind: 'command',
  command: { type: 'service.control', payload: { name: 'Spooler', action: 'start', expectedDisplayName: 'Print Spooler' } },
};
const restartPc = {
  kind: 'command',
  command: { type: 'power.action', payload: { action: 'restart', delaySeconds: 60, force: false } },
};

function manual(actions: unknown[], overrides: Record<string, unknown> = {}) {
  return { name: 'By hand', trigger: { kind: 'manual' }, actions, targets: { mode: 'pcs', pcIds: [pcId] }, ...overrides };
}

async function create(automation: unknown, confirmedRiskLevel?: string) {
  const response = await call('POST', '/automations', { automation, confirmedRiskLevel });
  assert.equal(response.statusCode, 201, response.payload);
  return JSON.parse(response.payload).automation as { id: string; enabled: boolean; authorizedRiskLevel: string };
}

async function runs(automationId: string) {
  return context.repos.automations.listRuns(automationId, userId);
}

async function waitForRun(automationId: string, done: (run: Awaited<ReturnType<typeof runs>>[number]) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = (await runs(automationId)).find(done);
    if (found) return found;
    await sleep(50);
  }
  throw new Error('the run never reached the expected state');
}

/** Play the agent: complete the next command of a type as soon as it is dispatched. */
async function answerNextCommand(type: string, status: 'completed' | 'failed' = 'completed'): Promise<CommandRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pending = (await context.repos.commands.listForPc(pcId, 20)).find(
      (command) => command.type === type && command.status === 'pending',
    );
    if (pending) {
      await context.repos.commands.complete({
        id: pending.id,
        status,
        startedAt: clock,
        completedAt: clock,
        errorCode: status === 'failed' ? 'access-denied' : null,
        errorMessage: null,
        errorIsLimitation: false,
        result: status === 'completed' ? { ok: true } : null,
      });
      return pending;
    }
    await sleep(25);
  }
  throw new Error(`no ${type} command was dispatched`);
}

/* ------------------------------------------------------------------------- */
/* Saving is authorizing                                                      */
/* ------------------------------------------------------------------------- */

test('automations require a signed-in caller', async () => {
  for (const [method, url] of [
    ['GET', '/api/v1/automations'],
    ['POST', '/api/v1/automations'],
  ] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 401);
  }
});

test('what cannot be automated is refused at save time', async () => {
  const refusals = [
    // Names a live PID: a PID saved today is a different process tomorrow.
    manual([{ kind: 'command', command: { type: 'process.terminate', payload: { pid: 1234, expectedName: 'notepad.exe' } } }]),
    // Forced restart is critical.
    manual([{ kind: 'command', command: { type: 'power.action', payload: { action: 'restart', force: true } } }]),
    // "The alert's PC" without an alert.
    manual([notify], { targets: { mode: 'alert-pc' } }),
    { ...manual([notify]), trigger: { kind: 'schedule', time: '03:00', days: ['mon'], timeZone: 'Mars/Olympus_Mons' } },
    manual([]),
  ];

  for (const automation of refusals) {
    const response = await call('POST', '/automations', { automation, confirmedRiskLevel: 'critical' });
    assert.equal(response.statusCode, 400, response.payload);
  }

  const strangerPc = await call('POST', '/automations', { automation: manual([notify], { targets: { mode: 'pcs', pcIds: [newId()] } }) });
  assert.equal(strangerPc.statusCode, 404);
});

test('a notification-only automation saves without confirmation and is audited', async () => {
  const automation = await create(manual([notify]));
  assert.equal(automation.authorizedRiskLevel, 'low');

  const { rows } = await db.query<{ after_value: { actions: string[] } }>(
    `SELECT after_value FROM audit_logs WHERE action = 'automation.create' AND target->>'automationId' = $1`,
    [automation.id],
  );
  assert.deepEqual(rows[0]?.after_value.actions, ['notify']);
  // The owner's message is not copied into the audit trail.
  assert.ok(!JSON.stringify(rows[0]).includes('Nightly check ran'));
});

test('a high-risk automation needs the matching confirmation and a fresh password', async () => {
  const automation = manual([notify, restartPc]);

  const unconfirmed = await call('POST', '/automations', { automation });
  assert.equal(unconfirmed.statusCode, 428);
  assert.equal(JSON.parse(unconfirmed.payload).error.code, 'command.confirmation_required');
  assert.equal(JSON.parse(unconfirmed.payload).error.context.riskLevel, 'high');

  const milder = await call('POST', '/automations', { automation, confirmedRiskLevel: 'medium' });
  assert.equal(milder.statusCode, 428);

  // Six minutes after signing in, the password is too old for a high-risk decision.
  clock = new Date(clock.getTime() + 6 * 60_000);
  const stale = await call('POST', '/automations', { automation, confirmedRiskLevel: 'high' });
  assert.equal(stale.statusCode, 428);
  assert.equal(JSON.parse(stale.payload).error.code, 'command.reauth_required');

  const fresh = await login('Fresh password');
  const saved = await call('POST', '/automations', { automation, confirmedRiskLevel: 'high' }, fresh);
  assert.equal(saved.statusCode, 201, saved.payload);
  assert.equal(JSON.parse(saved.payload).automation.authorizedRiskLevel, 'high');
});

test('renaming or turning off needs nothing; widening re-authorizes', async () => {
  const automation = await create(manual([notify]));

  assert.equal((await call('PATCH', `/automations/${automation.id}`, { automation: { name: 'Renamed' } })).statusCode, 200);
  assert.equal((await call('PATCH', `/automations/${automation.id}`, { automation: { enabled: false } })).statusCode, 200);

  // Adding a service action is a new decision.
  const widened = await call('PATCH', `/automations/${automation.id}`, { automation: { actions: [notify, restartService], enabled: true } });
  assert.equal(widened.statusCode, 428);

  const confirmed = await call('PATCH', `/automations/${automation.id}`, {
    automation: { actions: [notify, restartService], enabled: true },
    confirmedRiskLevel: 'medium',
  });
  assert.equal(confirmed.statusCode, 200, confirmed.payload);
  assert.equal(JSON.parse(confirmed.payload).automation.authorizedRiskLevel, 'medium');
});

/* ------------------------------------------------------------------------- */
/* Running                                                                    */
/* ------------------------------------------------------------------------- */

test('a run notifies, sends its command on the audited path, and waits for the result', async () => {
  const automation = await create(manual([notify, restartService]), 'medium');

  const accepted = await call('POST', `/automations/${automation.id}/run`);
  assert.equal(accepted.statusCode, 202);

  const command = await answerNextCommand('service.control');
  const run = await waitForRun(automation.id, (candidate) => candidate.status === 'completed');

  assert.equal(run.triggerKind, 'manual');
  assert.deepEqual(run.steps.map((step) => [step.kind, step.status]), [['notify', 'completed'], ['command', 'completed']]);
  assert.equal(run.steps[1]?.commandId, command.id);

  // No session, and the confirmation is dated when it was given: at save time.
  assert.equal(command.sessionId, null);
  assert.equal(command.deviceId, deviceId);
  assert.equal(command.riskLevel, 'medium');
  assert.ok(command.authorization.confirmedAt);
  assert.deepEqual(command.authorization.grantedCapabilities, ['services']);

  const { rows } = await db.query<{ action: string; outcome: string }>(
    `SELECT action, outcome FROM audit_logs WHERE request_id = $1 ORDER BY occurred_at`,
    [run.id],
  );
  assert.deepEqual(rows.map((row) => `${row.action}:${row.outcome}`).sort(), ['automation.run:success', 'service.control:pending']);

  const inbox = await context.repos.alerts.listNotifications(userId, { unreadOnly: false, limit: 10 });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.kind, 'automation');
  assert.equal(inbox[0]?.automationId, automation.id);
});

test('a failed command stops the run, skips the rest and tells the owner', async () => {
  const automation = await create(manual([restartService, notify]), 'medium');

  await call('POST', `/automations/${automation.id}/run`);
  await answerNextCommand('service.control', 'failed');
  const run = await waitForRun(automation.id, (candidate) => candidate.status === 'failed');

  assert.deepEqual(run.steps.map((step) => step.status), ['failed', 'skipped']);
  assert.equal(run.reason, 'access-denied');

  const inbox = await context.repos.alerts.listNotifications(userId, { unreadOnly: false, limit: 10 });
  assert.equal(inbox.length, 1, 'the failure, and not the skipped notify action');
  assert.match(inbox[0]!.title, /did not finish/);
});

test('an offline PC is refused before anything is queued, and that is not news', async () => {
  await db.query(`UPDATE pcs SET status = 'offline' WHERE id = $1`, [pcId]);
  const automation = await create(manual([restartService]), 'medium');

  await call('POST', `/automations/${automation.id}/run`);
  const run = await waitForRun(automation.id, (candidate) => candidate.status === 'failed');

  assert.equal(run.reason, 'pc-offline');
  assert.equal((await context.repos.commands.listForPc(pcId)).length, 0, 'never queued to run late');
  assert.equal((await context.repos.alerts.listNotifications(userId, { unreadOnly: false, limit: 10 })).length, 0);

  const { rows } = await db.query(`SELECT 1 FROM audit_logs WHERE outcome = 'denied' AND error_code = 'pc-offline' AND request_id = $1`, [run.id]);
  assert.equal(rows.length, 1);
});

test('a live session holding power control is never overridden', async () => {
  const automation = await create(manual([restartPc]), 'high');

  // Somebody is connected and holding the PC's power control.
  const sessionId = newId();
  await context.repos.sessions.create({
    id: sessionId,
    userId,
    deviceId,
    pcId,
    mode: 'control',
    capabilities: ['power'],
    route: 'relay',
    expiresAt: new Date(Date.now() + 600_000),
  });
  await context.repos.sessions.acquireResource({ pcId, resource: 'power', sessionId, expiresAt: new Date(Date.now() + 600_000) });

  await call('POST', `/automations/${automation.id}/run`);
  const run = await waitForRun(automation.id, (candidate) => candidate.status === 'failed');
  assert.equal(run.reason, 'resource-held');
});

/* ------------------------------------------------------------------------- */
/* Cooldowns and limits                                                       */
/* ------------------------------------------------------------------------- */

test('two instances reaching the same automation start one run; the other is cooling down', async () => {
  const saved = await create(manual([notify], { cooldownMinutes: 30 }));
  const automation = (await context.repos.automations.findById(saved.id, userId))!;

  const first = new AutomationExecutor(context);
  const second = new AutomationExecutor(context);
  first.start(automation, [pcId], 'schedule');
  second.start(automation, [pcId], 'schedule');
  await Promise.all([first.drain(), second.drain()]);

  const statuses = (await runs(saved.id)).map((run) => `${run.status}:${run.reason ?? ''}`).sort();
  assert.deepEqual(statuses, ['completed:', 'skipped:cooldown']);
});

test('the daily limit bounds even runs started by hand', async () => {
  const saved = await create(manual([notify], { maxRunsPerDay: 1 }));

  await call('POST', `/automations/${saved.id}/run`);
  await waitForRun(saved.id, (run) => run.status === 'completed');
  await call('POST', `/automations/${saved.id}/run`);
  const limited = await waitForRun(saved.id, (run) => run.status === 'skipped');

  assert.equal(limited.reason, 'daily-limit');
});

test('conditions are checked before the cooldown is used', async () => {
  const saved = await create(manual([notify], { conditions: [{ kind: 'metric', metric: 'cpu.usage', comparison: 'below', threshold: 20 }] }));
  const automation = (await context.repos.automations.findById(saved.id, userId))!;

  const executor = new AutomationExecutor(context);
  executor.start(automation, [pcId], 'schedule');
  await executor.drain();

  const [run] = await runs(saved.id);
  assert.equal(run?.status, 'skipped');
  assert.match(run!.reason!, /^condition-not-met: No recent telemetry/);
  const { rows } = await db.query('SELECT 1 FROM automation_pc_state WHERE automation_id = $1', [saved.id]);
  assert.equal(rows.length, 0, 'a run that never acted did not start the cooldown');
});

/* ------------------------------------------------------------------------- */
/* Authority ends                                                             */
/* ------------------------------------------------------------------------- */

test('an automation whose authorizing device was revoked turns itself off and says so', async () => {
  const saved = await create(manual([notify]));
  const automation = (await context.repos.automations.findById(saved.id, userId))!;

  // Revoked underneath the automation, as if by a path that did not disable it.
  await db.query(`UPDATE user_devices SET status = 'revoked', revoked_at = now() WHERE id = $1`, [deviceId]);
  try {
    const executor = new AutomationExecutor(context);
    executor.start(automation, [pcId], 'schedule');
    await executor.drain();

    const [run] = await runs(saved.id);
    assert.equal(run?.status, 'skipped');
    assert.match(run!.reason!, /^authority-revoked/);
    assert.equal((await context.repos.automations.findById(saved.id, userId))?.enabled, false);

    const inbox = await context.repos.alerts.listNotifications(userId, { unreadOnly: false, limit: 10 });
    assert.match(inbox[0]!.title, /was turned off/);
  } finally {
    await db.query(`UPDATE user_devices SET status = 'active', revoked_at = NULL WHERE id = $1`, [deviceId]);
  }
});

test('revoking a device through the API turns off its automations in the same transaction', async () => {
  const other = await login('Second device');
  const devices = await context.repos.devices.listForUser(userId);
  const target = devices.find((device) => device.name === 'Second device' && device.status === 'active')!;

  const saved = await create(manual([notify]));
  // Authorized from the second device.
  await db.query('UPDATE automations SET authorized_device_id = $2 WHERE id = $1', [saved.id, target.id]);

  const revoked = await call('DELETE', `/devices/${target.id}`);
  assert.equal(revoked.statusCode, 204, revoked.payload);
  void other;

  assert.equal((await context.repos.automations.findById(saved.id, userId))?.enabled, false);
});

/* ------------------------------------------------------------------------- */
/* Triggers                                                                   */
/* ------------------------------------------------------------------------- */

test('a scheduled minute runs once, however many instances reach it', async () => {
  const time = clock.toISOString().slice(11, 16);
  const saved = await create({
    ...manual([notify]),
    trigger: { kind: 'schedule', time, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], timeZone: 'UTC' },
  });

  const jobs = [new AutomationJob(context), new AutomationJob(context)];
  await Promise.all(jobs.map((job) => job.runOnce()));
  await Promise.all(jobs.map((job) => job.executor.drain()));

  // A minute later, still within the grace window: the slot is already claimed.
  clock = new Date(clock.getTime() + 60_000);
  await jobs[0]!.runOnce();
  await jobs[0]!.executor.drain();

  assert.deepEqual((await runs(saved.id)).map((run) => run.status), ['completed']);
});

test('a schedule not due now does nothing', async () => {
  const other = new Date(clock.getTime() + 3 * 3_600_000).toISOString().slice(11, 16);
  const saved = await create({ ...manual([notify]), trigger: { kind: 'schedule', time: other, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], timeZone: 'UTC' } });

  const job = new AutomationJob(context);
  await job.runOnce();
  await job.executor.drain();

  assert.equal((await runs(saved.id)).length, 0);
});

test('an alert firing runs the automation on the PC it fired for; a stale one does not', async () => {
  const rule = await context.repos.alerts.createRule(userId, {
    pcId: null,
    name: 'Offline',
    condition: 'pc-offline',
    metric: null,
    seriesKey: null,
    threshold: null,
    forMinutes: 10,
    severity: 'warning',
    cooldownMinutes: 60,
    enabled: true,
  });

  const saved = await create({
    name: 'On alert',
    trigger: { kind: 'alert', ruleId: rule.id, on: 'fired' },
    actions: [notify],
    targets: { mode: 'alert-pc' },
  });

  const record = (occurredAt: Date) =>
    withTransaction(db, (client) =>
      context.repos.automations.recordAlertEvent(client, { userId, ruleId: rule.id, pcId, kind: 'alert-fired', occurredAt }),
    );

  assert.equal(await record(clock), true);
  // A resolution is not what this automation asks about.
  await withTransaction(db, (client) =>
    context.repos.automations.recordAlertEvent(client, { userId, ruleId: rule.id, pcId, kind: 'alert-resolved', occurredAt: clock }),
  );

  const job = new AutomationJob(context);
  await job.runOnce();
  await job.executor.drain();

  let history = await runs(saved.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.pcId, pcId);
  assert.equal(history[0]?.triggerKind, 'alert');

  await record(new Date(clock.getTime() - 20 * 60_000));
  await job.runOnce();
  await job.executor.drain();

  history = await runs(saved.id);
  assert.ok(history.some((run) => run.status === 'skipped' && run.reason?.startsWith('stale-trigger')));
});

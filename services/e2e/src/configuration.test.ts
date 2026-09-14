import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@wolf/api/app';
import type { AppContext } from '@wolf/api/context';
import { InMemoryRateLimiter } from '@wolf/api/rate-limit';
import { configurationChecksum, createRepositories, loadConfig, migrate } from '@wolf/server-core';
import { createTestDatabase, type TestDatabase } from '@wolf/server-core/testing';
import { createHmacSigner, hashPassword } from '@wolf/auth';
import { canonicalJson, remoteDesktopProfile } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';

/**
 * Configuration backup and restore through the real HTTP app.
 *
 * What has to hold: a backup contains the owner's configuration and nothing that grants access; a
 * restore puts that configuration back — ids, history and all — without failing halfway on a name;
 * a damaged or doctored file restores nothing; and restoring an automation is never a way to have it
 * act without somebody deciding it should.
 */

const OWNER_EMAIL = 'backup-owner@example.com';
const OWNER_PASSWORD = 'a-long-owner-passphrase';

let db: TestDatabase;
let app: FastifyInstance;
let context: AppContext;
let userId: string;
let token: string;
let clock: Date;
let studio: string;
let office: string;

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
  token = await login('Backup browser');
});

beforeEach(async () => {
  clock = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  await db.query('DELETE FROM automations');
  await db.query('DELETE FROM alert_rules');
  await db.query('DELETE FROM remote_desktop_profiles');
  await db.query('DELETE FROM pcs');

  studio = newId();
  office = newId();
  for (const [id, name] of [
    [studio, 'STUDIO'],
    [office, 'OFFICE'],
  ] as const) {
    await context.repos.pcs.create({ id, userId, name, hostname: null, publicKey: 'a'.repeat(64), agentVersion: null });
  }
  await db.query(`UPDATE pcs SET registration_state = 'active', tags = ARRAY['home'], favorite = TRUE WHERE id = $1`, [studio]);
  await db.query(`UPDATE pcs SET registration_state = 'active' WHERE id = $1`, [office]);

  await context.repos.remoteDesktop.createProfile({
    id: newId(),
    userId,
    name: 'LAN',
    settings: remoteDesktopProfile.parse({ name: 'LAN', targetFps: 120 }),
    isDefault: true,
  });
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

async function seedRuleAndAutomations() {
  const rule = await context.repos.alerts.createRule(userId, {
    pcId: office,
    name: 'Office offline',
    condition: 'pc-offline',
    metric: null,
    seriesKey: null,
    threshold: null,
    forMinutes: 10,
    severity: 'warning',
    cooldownMinutes: 60,
    enabled: true,
  });

  const created = await call('POST', '/automations', {
    automation: {
      name: 'Restart the spooler',
      trigger: { kind: 'manual' },
      actions: [
        { kind: 'notify', message: 'Restarting the spooler' },
        { kind: 'command', command: { type: 'service.control', payload: { name: 'Spooler', action: 'start', expectedDisplayName: 'Print Spooler' } } },
      ],
      targets: { mode: 'pcs', pcIds: [studio] },
    },
    confirmedRiskLevel: 'medium',
  });
  assert.equal(created.statusCode, 201, created.payload);

  return { ruleId: rule.id, automationId: JSON.parse(created.payload).automation.id as string };
}

async function backup() {
  const response = await call('GET', '/configuration/backup');
  assert.equal(response.statusCode, 200, response.payload);
  return { response, file: JSON.parse(response.payload) };
}

const ALL = ['pcs', 'remoteDesktopProfiles', 'alertRules', 'automations'];

/* ------------------------------------------------------------------------- */
/* Backup                                                                     */
/* ------------------------------------------------------------------------- */

test('backup and restore require a signed-in caller', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/configuration/backup' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/configuration/restore' })).statusCode, 401);
});

test('a backup holds the configuration, verifies, and holds nothing that grants access', async () => {
  const { ruleId, automationId } = await seedRuleAndAutomations();
  const { response, file } = await backup();

  assert.match(String(response.headers['content-disposition']), /^attachment; filename="wolf-configuration-/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(file.format, 'wolf.configuration');
  assert.equal(file.checksum, configurationChecksum(file.content));

  assert.deepEqual(file.content.pcs.map((pc: { name: string }) => pc.name).sort(), ['OFFICE', 'STUDIO']);
  assert.equal(file.content.alertRules[0].id, ruleId);
  assert.equal(file.content.automations[0].id, automationId);
  assert.equal(file.content.remoteDesktopProfiles[0].isDefault, true);

  // None of these may appear anywhere in the file.
  const text = response.payload;
  for (const forbidden of ['aaaaaaaaaaaaaaaa', 'password', 'publicKey', 'public_key', 'token', 'authorized', OWNER_EMAIL, 'scrypt']) {
    assert.ok(!text.includes(forbidden), `backup contains ${forbidden}`);
  }

  // Taking it was recorded, with counts.
  const { rows } = await db.query<{ target: { automations: number } }>(`SELECT target FROM audit_logs WHERE action = 'configuration.backup'`);
  assert.equal(rows.at(-1)?.target.automations, 1);
});

/* ------------------------------------------------------------------------- */
/* Restore                                                                    */
/* ------------------------------------------------------------------------- */

test('a restore puts the configuration back, keeping ids and history, with automations turned off', async () => {
  const { ruleId, automationId } = await seedRuleAndAutomations();
  const { file } = await backup();
  const original = file.content;

  // A run in the automation's history, which must survive the restore.
  await db.query(
    `INSERT INTO automation_runs (id, automation_id, user_id, pc_id, trigger_kind, status, started_at, finished_at)
     VALUES ($1, $2, $3, $4, 'manual', 'completed', now(), now())`,
    [newId(), automationId, userId, studio],
  );

  // Then the account drifts: a rename, a deleted rule, an edited automation, a new profile.
  await db.query(`UPDATE pcs SET name = 'RENAMED', tags = '{}' WHERE id = $1`, [studio]);
  await context.repos.alerts.deleteRule(ruleId, userId);
  await db.query(`UPDATE automations SET name = 'Edited' WHERE id = $1`, [automationId]);
  await context.repos.remoteDesktop.createProfile({ id: newId(), userId, name: 'Extra', settings: remoteDesktopProfile.parse({ name: 'Extra' }), isDefault: false });

  const preview = await call('POST', '/configuration/restore/preview', { backup: file, sections: ALL });
  assert.equal(preview.statusCode, 200, preview.payload);
  const plan = JSON.parse(preview.payload).plan;
  assert.deepEqual(plan.sections.alertRules, { created: 1, updated: 0, deleted: 0, skipped: 0 });
  assert.deepEqual(plan.sections.remoteDesktopProfiles, { created: 0, updated: 1, deleted: 1, skipped: 0 });
  assert.equal(plan.riskLevel, 'medium');

  const restored = await call('POST', '/configuration/restore', { backup: file, sections: ALL, confirmedRiskLevel: 'medium' });
  assert.equal(restored.statusCode, 200, restored.payload);

  const after = await context.repos.configuration.snapshot(userId);
  const expected = structuredClone(original);
  expected.automations[0].automation.enabled = false;
  assert.equal(canonicalJson(after), canonicalJson(expected));

  const { rows } = await db.query('SELECT 1 FROM automation_runs WHERE automation_id = $1', [automationId]);
  assert.equal(rows.length, 1, 'run history stayed attached to the restored automation');

  const audit = await db.query<{ after_value: unknown }>(`SELECT after_value FROM audit_logs WHERE action = 'configuration.restore' AND outcome = 'success'`);
  assert.ok(!JSON.stringify(audit.rows).includes('Restart the spooler'), 'no configuration content in the audit trail');
});

test('a restore must be confirmed, and turning automations on needs their risk', async () => {
  await seedRuleAndAutomations();
  const { file } = await backup();

  const unconfirmed = await call('POST', '/configuration/restore', { backup: file, sections: ALL });
  assert.equal(unconfirmed.statusCode, 428);
  assert.equal(JSON.parse(unconfirmed.payload).error.context.riskLevel, 'medium');

  // A restart automation on in the backup: turning it on is a high-risk decision.
  const withRestart = structuredClone(file);
  withRestart.content.automations.push({
    id: newId(),
    automation: {
      name: 'Nightly restart',
      enabled: true,
      trigger: { kind: 'schedule', time: '03:00', days: ['sun'], timeZone: 'UTC' },
      conditions: [],
      actions: [{ kind: 'command', command: { type: 'power.action', payload: { action: 'restart', delaySeconds: 60, force: false } } }],
      targets: { mode: 'pcs', pcIds: [studio] },
      cooldownMinutes: 60,
      maxRunsPerDay: 1,
    },
  });
  withRestart.checksum = configurationChecksum(withRestart.content);

  const off = await call('POST', '/configuration/restore', { backup: withRestart, sections: ['automations'], confirmedRiskLevel: 'medium' });
  assert.equal(off.statusCode, 200, 'restored turned off, it needs only the medium confirmation');

  clock = new Date(clock.getTime() + 6 * 60_000);
  const stale = await call('POST', '/configuration/restore', {
    backup: withRestart,
    sections: ['automations'],
    enableAutomations: true,
    confirmedRiskLevel: 'high',
  });
  assert.equal(stale.statusCode, 428);
  assert.equal(JSON.parse(stale.payload).error.code, 'command.reauth_required');

  const fresh = await login('Fresh password');
  const on = await call('POST', '/configuration/restore', { backup: withRestart, sections: ['automations'], enableAutomations: true, confirmedRiskLevel: 'high' }, fresh);
  assert.equal(on.statusCode, 200, on.payload);
  assert.equal(JSON.parse(on.payload).plan.automationsEnabled, 2);

  const { rows } = await db.query<{ authorized_risk: string; enabled: boolean }>(
    `SELECT authorized_risk, enabled FROM automations WHERE name = 'Nightly restart'`,
  );
  assert.deepEqual(rows[0], { authorized_risk: 'high', enabled: true });
});

test('a damaged, doctored or foreign file restores nothing', async () => {
  await seedRuleAndAutomations();
  const { file } = await backup();
  const before = canonicalJson(await context.repos.configuration.snapshot(userId));

  const damaged = structuredClone(file);
  damaged.content.pcs[0].name = 'TAMPERED';

  const doctored = structuredClone(file);
  doctored.content.automations[0].automation.actions.push({
    kind: 'command',
    command: { type: 'power.action', payload: { action: 'shutdown', delaySeconds: 0, force: true } },
  });
  doctored.checksum = configurationChecksum(doctored.content);

  const future = { ...structuredClone(file), version: 99 };

  for (const [label, candidate] of [
    ['damaged', damaged],
    ['doctored', doctored],
    ['future', future],
    ['not a backup', { hello: 'world' }],
  ] as const) {
    const response = await call('POST', '/configuration/restore', { backup: candidate, sections: ALL, confirmedRiskLevel: 'critical' });
    assert.equal(response.statusCode, 422, `${label}: ${response.payload}`);
    assert.equal(JSON.parse(response.payload).error.code, 'configuration.invalid_backup');
  }

  assert.equal(canonicalJson(await context.repos.configuration.snapshot(userId)), before);

  const { rows } = await db.query(`SELECT 1 FROM audit_logs WHERE action = 'configuration.restore' AND outcome = 'denied' AND error_code = 'invalid-backup'`);
  assert.ok(rows.length >= 4);
});

test('swapped PC names restore without tripping the uniqueness constraint', async () => {
  const { file } = await backup();
  const swapped = structuredClone(file);
  for (const pc of swapped.content.pcs) pc.name = pc.name === 'STUDIO' ? 'OFFICE' : 'STUDIO';
  swapped.checksum = configurationChecksum(swapped.content);

  const response = await call('POST', '/configuration/restore', { backup: swapped, sections: ['pcs'], confirmedRiskLevel: 'medium' });
  assert.equal(response.statusCode, 200, response.payload);

  const pcs = await context.repos.pcs.listForUser(userId);
  assert.equal(pcs.find((pc) => pc.id === studio)?.name, 'OFFICE');
  assert.equal(pcs.find((pc) => pc.id === office)?.name, 'STUDIO');
});

test('what refers to a PC that is no longer enrolled is reported, not widened', async () => {
  const { ruleId } = await seedRuleAndAutomations();
  const { file } = await backup();

  await db.query(`UPDATE pcs SET registration_state = 'revoked' WHERE id = $1`, [office]);
  await context.repos.alerts.deleteRule(ruleId, userId);

  const response = await call('POST', '/configuration/restore', { backup: file, sections: ALL, confirmedRiskLevel: 'medium' });
  assert.equal(response.statusCode, 200, response.payload);

  const codes = JSON.parse(response.payload).plan.warnings.map((warning: { code: string }) => warning.code).sort();
  assert.deepEqual(codes, ['pc-not-enrolled', 'rule-pc-missing']);

  // The rule was about OFFICE alone: it is not back as a rule about every PC.
  assert.equal((await context.repos.alerts.listRules(userId)).length, 0);
});

test('restoring one section leaves the others alone', async () => {
  const { automationId } = await seedRuleAndAutomations();
  const { file } = await backup();

  await db.query(`UPDATE pcs SET name = 'RENAMED' WHERE id = $1`, [studio]);
  await db.query(`UPDATE automations SET name = 'Edited' WHERE id = $1`, [automationId]);

  const response = await call('POST', '/configuration/restore', { backup: file, sections: ['pcs'], confirmedRiskLevel: 'medium' });
  assert.equal(response.statusCode, 200, response.payload);

  assert.equal((await context.repos.pcs.findById(studio, userId))?.name, 'STUDIO');
  assert.equal((await context.repos.automations.findById(automationId, userId))?.name, 'Edited');
});

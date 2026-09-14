import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIGURATION_FORMAT,
  CONFIGURATION_VERSION,
  configurationContent,
  type ConfigurationContent,
} from '@wolf/protocol';
import { authorizeRestore, configurationChecksum, planRestore, verifyBackup, type CurrentConfiguration } from './plan.js';

/**
 * Checking a backup and planning a restore.
 *
 * The outcomes worth guarding: a damaged or doctored file restoring anything at all; a PC, rule or
 * automation silently turning into something broader than it was; a restore failing halfway on a
 * name collision; and restored automations acting without anyone deciding they should.
 */

const pc = (n: number) => `01J9ZQK7T00000000000000P${String(n).padStart(2, '0')}`;
const rule = (n: number) => `01J9ZQK7T00000000000000R${String(n).padStart(2, '0')}`;
const automation = (n: number) => `01J9ZQK7T00000000000000A${String(n).padStart(2, '0')}`;

function content(overrides: Partial<Record<keyof ConfigurationContent, unknown[]>> = {}): unknown {
  return {
    pcs: [
      { id: pc(1), name: 'STUDIO', tags: ['home'], favorite: true },
      { id: pc(2), name: 'OFFICE', tags: [], favorite: false },
    ],
    remoteDesktopProfiles: [],
    alertRules: [
      {
        id: rule(1),
        rule: { name: 'Offline', pcId: pc(2), condition: 'pc-offline', forMinutes: 10 },
      },
    ],
    automations: [
      {
        id: automation(1),
        automation: {
          name: 'Nightly restart',
          trigger: { kind: 'schedule', time: '03:00', days: ['sun'], timeZone: 'UTC' },
          actions: [{ kind: 'command', command: { type: 'power.action', payload: { action: 'restart' } } }],
          targets: { mode: 'pcs', pcIds: [pc(1), pc(2)] },
        },
      },
      {
        id: automation(2),
        automation: {
          name: 'When office drops',
          trigger: { kind: 'alert', ruleId: rule(1) },
          actions: [{ kind: 'notify', message: 'Office went offline' }],
          targets: { mode: 'alert-pc' },
        },
      },
    ],
    ...overrides,
  };
}

function file(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    format: CONFIGURATION_FORMAT,
    version: CONFIGURATION_VERSION,
    createdAt: '2026-09-14T12:00:00.000Z',
    checksum: configurationChecksum(body),
    content: body,
    ...overrides,
  };
}

const current: CurrentConfiguration = {
  pcs: [
    { id: pc(1), name: 'STUDIO', active: true },
    { id: pc(2), name: 'OFFICE', active: true },
  ],
  profileIds: [],
  alertRuleIds: [rule(1)],
  automations: [],
};

const all = ['pcs', 'remoteDesktopProfiles', 'alertRules', 'automations'] as const;

/* ------------------------------------------------------------------------- */
/* Verifying                                                                  */
/* ------------------------------------------------------------------------- */

test('a backup WOLF made verifies', () => {
  const verdict = verifyBackup(file(content()));
  assert.equal(verdict.ok, true);
});

test('the checksum does not depend on key order', () => {
  assert.equal(configurationChecksum({ a: 1, b: [{ c: 2, d: 3 }] }), configurationChecksum({ b: [{ d: 3, c: 2 }], a: 1 }));
});

test('a changed file is refused, even by one character', () => {
  const body = content() as { pcs: { name: string }[] };
  const original = file(body);
  const edited = structuredClone(original) as typeof original & { content: { pcs: { name: string }[] } };
  edited.content.pcs[0]!.name = 'STUDI0';

  const verdict = verifyBackup(edited);
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.problem : '', /changed or damaged/);
});

test('a backup from a newer WOLF is refused as that, not as a schema error', () => {
  const verdict = verifyBackup(file(content(), { version: CONFIGURATION_VERSION + 1 }));
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.problem : '', /different version/);
});

test('something that is not a backup at all is refused', () => {
  for (const notABackup of [null, 'hello', { format: 'other', version: 1 }, { pcs: [] }]) {
    assert.equal(verifyBackup(notABackup).ok, false);
  }
});

test('a doctored backup with a correct checksum is still validated item by item', () => {
  // Recomputing the checksum is easy. Getting a critical action past the schema is not.
  const doctored = content({
    automations: [
      {
        id: automation(9),
        automation: {
          name: 'Evil',
          trigger: { kind: 'manual' },
          actions: [{ kind: 'command', command: { type: 'power.action', payload: { action: 'shutdown', force: true } } }],
          targets: { mode: 'pcs', pcIds: [pc(1)] },
        },
      },
    ],
  });

  const verdict = verifyBackup(file(doctored));
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.cause : '', /critical/);
});

/* ------------------------------------------------------------------------- */
/* Planning                                                                   */
/* ------------------------------------------------------------------------- */

function parsed(body: unknown = content()): ConfigurationContent {
  return configurationContent.parse(body);
}

test('restored automations come back off unless turning them on is chosen', () => {
  const off = planRestore(parsed(), current, { sections: all, enableAutomations: false });

  assert.equal(off.automations.every((entry) => !entry.automation.enabled), true);
  assert.equal(off.plan.automationsEnabled, 0);
  // Replacing configuration is still a decision to confirm.
  assert.equal(off.plan.riskLevel, 'medium');

  const on = planRestore(parsed(), current, { sections: all, enableAutomations: true });
  assert.equal(on.plan.automationsEnabled, 2);
  // A nightly restart among them: the restore is confirmed at high, with a password.
  assert.equal(on.plan.riskLevel, 'high');
});

test('a PC that is no longer enrolled is reported, and nothing that depends on it is widened', () => {
  const gone: CurrentConfiguration = { ...current, pcs: [{ id: pc(1), name: 'STUDIO', active: true }, { id: pc(2), name: 'OFFICE', active: false }] };
  const work = planRestore(parsed(), gone, { sections: all, enableAutomations: false });

  assert.deepEqual(work.pcUpdates.map((update) => update.id), [pc(1)]);
  assert.equal(work.plan.sections.pcs?.skipped, 1);

  // The rule was about OFFICE only: not restored, rather than becoming a rule about every PC.
  assert.equal(work.rules.length, 0);
  assert.equal(work.plan.sections.alertRules?.skipped, 1);

  // The restart keeps STUDIO; the alert automation loses its rule and is not restored.
  const restart = work.automations.find((entry) => entry.id === automation(1));
  assert.deepEqual(restart?.automation.targets, { mode: 'pcs', pcIds: [pc(1)] });
  assert.equal(work.automations.some((entry) => entry.id === automation(2)), false);

  assert.deepEqual(
    work.plan.warnings.map((warning) => warning.code).sort(),
    ['automation-pcs-missing', 'automation-rule-missing', 'pc-not-enrolled', 'rule-pc-missing'],
  );
});

test('names that swap between two PCs are fine; a name another PC holds is not taken', () => {
  const swapped = content({
    pcs: [
      { id: pc(1), name: 'OFFICE', tags: [], favorite: false },
      { id: pc(2), name: 'STUDIO', tags: [], favorite: false },
    ],
  });
  const work = planRestore(parsed(swapped), current, { sections: ['pcs'], enableAutomations: false });
  assert.deepEqual(work.pcUpdates.map((update) => update.name), ['OFFICE', 'STUDIO']);
  assert.equal(work.plan.warnings.length, 0);

  // A third PC, not in the backup, already holds the name the backup wants.
  const crowded: CurrentConfiguration = { ...current, pcs: [...current.pcs, { id: pc(3), name: 'LAPTOP', active: true }] };
  const clash = content({ pcs: [{ id: pc(1), name: 'LAPTOP', tags: ['kept'], favorite: false }] });
  const clashed = planRestore(parsed(clash), crowded, { sections: ['pcs'], enableAutomations: false });

  assert.deepEqual(clashed.pcUpdates, [{ id: pc(1), name: 'STUDIO', tags: ['kept'], favorite: false }]);
  assert.equal(clashed.plan.warnings[0]?.code, 'pc-name-taken');
});

test('a revoked PC still holds its name', () => {
  const revokedHolder: CurrentConfiguration = { ...current, pcs: [...current.pcs, { id: pc(4), name: 'OLD', active: false }] };
  const work = planRestore(parsed(content({ pcs: [{ id: pc(1), name: 'OLD', tags: [], favorite: false }] })), revokedHolder, {
    sections: ['pcs'],
    enableAutomations: false,
  });

  assert.equal(work.pcUpdates[0]?.name, 'STUDIO');
});

test('sections replace: counts say what is created, updated and deleted', () => {
  const existing: CurrentConfiguration = {
    ...current,
    alertRuleIds: [rule(1), rule(2)],
    automations: [{ id: automation(1), enabled: true, ruleId: null }, { id: automation(3), enabled: true, ruleId: null }],
  };

  const work = planRestore(parsed(), existing, { sections: ['alertRules', 'automations'], enableAutomations: false });

  assert.deepEqual(work.plan.sections.alertRules, { created: 0, updated: 1, deleted: 1, skipped: 0 });
  assert.deepEqual(work.plan.sections.automations, { created: 1, updated: 1, deleted: 1, skipped: 0 });
  assert.equal(work.plan.sections.pcs, undefined, 'a section not chosen is not touched');
});

test('restoring only rules turns off automations waiting for a rule it removes', () => {
  const existing: CurrentConfiguration = {
    ...current,
    alertRuleIds: [rule(1), rule(2)],
    automations: [
      { id: automation(5), enabled: true, ruleId: rule(2) },
      { id: automation(6), enabled: true, ruleId: rule(1) },
      { id: automation(7), enabled: false, ruleId: rule(2) },
    ],
  };

  const work = planRestore(parsed(), existing, { sections: ['alertRules'], enableAutomations: false });

  assert.deepEqual(work.disableAutomationIds, [automation(5)]);
});

/* ------------------------------------------------------------------------- */
/* Authorizing                                                                */
/* ------------------------------------------------------------------------- */

test('a restore needs the confirmation for its level, and a fresh password at high', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const seconds = Math.floor(now.getTime() / 1000);

  assert.deepEqual(authorizeRestore({ riskLevel: 'medium', confirmedRiskLevel: undefined, authTimeSeconds: seconds, now }), { ok: false, problem: 'confirmation' });
  assert.deepEqual(authorizeRestore({ riskLevel: 'medium', confirmedRiskLevel: 'medium', authTimeSeconds: 0, now }), { ok: true });
  assert.deepEqual(authorizeRestore({ riskLevel: 'high', confirmedRiskLevel: 'medium', authTimeSeconds: seconds, now }), { ok: false, problem: 'confirmation' });
  assert.deepEqual(authorizeRestore({ riskLevel: 'high', confirmedRiskLevel: 'high', authTimeSeconds: seconds - 3600, now }), { ok: false, problem: 'reauthentication' });
  assert.deepEqual(authorizeRestore({ riskLevel: 'high', confirmedRiskLevel: 'high', authTimeSeconds: seconds - 30, now }), { ok: true });
});

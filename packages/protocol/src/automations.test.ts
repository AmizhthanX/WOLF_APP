import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATABLE_COMMANDS,
  automationInput,
  automationRisk,
  isValidTimeZone,
  type AutomationAction,
} from './automations.js';
import { COMMAND_REGISTRY } from './commands/index.js';

/**
 * The shape of an automation, and what it may carry.
 *
 * The API enforces authority when an automation is saved and again when it runs; these are the
 * refusals that happen before either, in the schema every client and server shares.
 */

const pcId = '01J9ZQK7T0000000000000000A';

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Nightly',
    trigger: { kind: 'manual' },
    actions: [{ kind: 'notify', message: 'Ran' }],
    targets: { mode: 'pcs', pcIds: [pcId] },
    ...overrides,
  };
}

test('every automatable command exists, changes something, and is not critical at baseline', () => {
  for (const type of AUTOMATABLE_COMMANDS) {
    const definition = COMMAND_REGISTRY[type];
    assert.ok(definition, type);
    assert.equal(definition.mutating, true, `${type} should be an action`);
    assert.notEqual(definition.risk, 'critical', type);
  }
});

test('commands that name a live identifier, or that the agent does not implement, are not automatable', () => {
  for (const type of ['process.terminate', 'process.set-priority', 'process.start', 'device.set-enabled', 'power.unlock']) {
    assert.ok(!(AUTOMATABLE_COMMANDS as readonly string[]).includes(type), type);

    const parsed = automationInput.safeParse(
      base({ actions: [{ kind: 'command', command: { type, payload: {} } }] }),
    );
    assert.equal(parsed.success, false, type);
  }
});

test('defaults fill in a sensible, bounded automation', () => {
  const parsed = automationInput.parse(base());

  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.conditions, []);
  assert.equal(parsed.cooldownMinutes, 60);
  assert.equal(parsed.maxRunsPerDay, 4);
  assert.equal(parsed.actions[0]?.kind === 'notify' && parsed.actions[0].severity, 'info');
});

test('a critical action is refused by the schema, whatever else is in the automation', () => {
  const forced = { kind: 'command', command: { type: 'power.action', payload: { action: 'shutdown', force: true } } };
  const unstoppable = { kind: 'command', command: { type: 'service.control', payload: { name: 'RpcSs', action: 'stop', expectedDisplayName: 'Remote Procedure Call (RPC)' } } };

  assert.equal(automationInput.safeParse(base({ actions: [{ kind: 'notify', message: 'x' }, forced] })).success, false);
  assert.equal(automationInput.safeParse(base({ actions: [unstoppable] })).success, false);
});

test('an automation risk is its riskiest action', () => {
  const actions: AutomationAction[] = [
    { kind: 'notify', severity: 'info', message: 'x' },
    { kind: 'command', command: { type: 'service.control', payload: { name: 'Spooler', action: 'start', expectedDisplayName: 'Print Spooler' } } },
    { kind: 'command', command: { type: 'power.action', payload: { action: 'restart', delaySeconds: 0, force: false } } },
  ];

  assert.equal(automationRisk(actions.slice(0, 1)), 'low');
  assert.equal(automationRisk(actions.slice(0, 2)), 'medium');
  assert.equal(automationRisk(actions), 'high');
});

test('targets must make sense for the trigger and list each PC once', () => {
  assert.equal(automationInput.safeParse(base({ targets: { mode: 'alert-pc' } })).success, false);
  assert.equal(
    automationInput.safeParse(base({ trigger: { kind: 'alert' }, targets: { mode: 'alert-pc' } })).success,
    true,
  );
  assert.equal(automationInput.safeParse(base({ targets: { mode: 'pcs', pcIds: [pcId, pcId] } })).success, false);
  assert.equal(automationInput.safeParse(base({ targets: { mode: 'pcs', pcIds: [] } })).success, false);
});

test('schedules need a real time, real days and a real time zone', () => {
  const schedule = (trigger: Record<string, unknown>) =>
    automationInput.safeParse(base({ trigger: { kind: 'schedule', time: '03:00', days: ['mon'], timeZone: 'Asia/Kolkata', ...trigger } })).success;

  assert.equal(schedule({}), true);
  assert.equal(schedule({ time: '24:00' }), false);
  assert.equal(schedule({ time: '3:00' }), false);
  assert.equal(schedule({ days: [] }), false);
  assert.equal(schedule({ timeZone: 'Not/AZone' }), false);

  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
});

test('there is a limit to how much one automation does and how often', () => {
  const notify = { kind: 'notify', message: 'x' };
  assert.equal(automationInput.safeParse(base({ actions: Array(6).fill(notify) })).success, false);
  assert.equal(automationInput.safeParse(base({ cooldownMinutes: 0 })).success, false);
  assert.equal(automationInput.safeParse(base({ maxRunsPerDay: 97 })).success, false);
});

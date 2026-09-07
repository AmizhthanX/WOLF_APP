import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_COMMAND_TYPES,
  COMMAND_REGISTRY,
  agentCommandBody,
  classifyRisk,
  isKnownCommandType,
  requiredCapability,
} from './index.js';
import { RESULT_SCHEMAS } from '../results.js';

test('every command type has a registry entry and a result schema', () => {
  for (const type of ALL_COMMAND_TYPES) {
    assert.ok(COMMAND_REGISTRY[type], `no registry entry for ${type}`);
    assert.ok(RESULT_SCHEMAS[type], `no result schema for ${type}`);
  }
});

test('the parsed command union covers exactly the registered types', () => {
  // A command that parses but is unregistered would dispatch with no risk classification.
  const parsed = agentCommandBody.safeParse({ type: 'process.list', payload: {} });
  assert.ok(parsed.success);
  assert.ok(isKnownCommandType('process.list'));
  assert.ok(!isKnownCommandType('process.inject'));
});

test('read-only commands are low risk and mutating commands are not', () => {
  assert.equal(COMMAND_REGISTRY['process.list'].risk, 'low');
  assert.equal(COMMAND_REGISTRY['process.list'].mutating, false);
  assert.equal(COMMAND_REGISTRY['process.terminate'].mutating, true);
  assert.notEqual(COMMAND_REGISTRY['power.action'].risk, 'low');
});

test('remote unlock is critical and requires the privileged capability', () => {
  assert.equal(COMMAND_REGISTRY['power.unlock'].risk, 'critical');
  assert.equal(requiredCapability('power.unlock'), 'privileged');
});

test('terminating a critical Windows process escalates to critical risk', () => {
  const command = agentCommandBody.parse({
    type: 'process.terminate',
    payload: { pid: 704, expectedName: 'lsass.exe' },
  });
  assert.equal(classifyRisk(command), 'critical');
});

test('terminating WOLF itself escalates, because it ends remote access', () => {
  const command = agentCommandBody.parse({
    type: 'process.terminate',
    payload: { pid: 5000, expectedName: 'Wolf.Agent.exe' },
  });
  assert.equal(classifyRisk(command), 'high');
});

test('force and tree termination escalate above the baseline', () => {
  const baseline = agentCommandBody.parse({
    type: 'process.terminate',
    payload: { pid: 5000, expectedName: 'notepad.exe' },
  });
  assert.equal(classifyRisk(baseline), 'medium');

  const forced = agentCommandBody.parse({
    type: 'process.terminate',
    payload: { pid: 5000, expectedName: 'notepad.exe', force: true },
  });
  assert.equal(classifyRisk(forced), 'high');
});

test('realtime priority escalates, ordinary priority changes do not', () => {
  const realtime = agentCommandBody.parse({
    type: 'process.set-priority',
    payload: { pid: 5000, expectedName: 'encoder.exe', priority: 'realtime' },
  });
  assert.equal(classifyRisk(realtime), 'high');

  const normal = agentCommandBody.parse({
    type: 'process.set-priority',
    payload: { pid: 5000, expectedName: 'encoder.exe', priority: 'above-normal' },
  });
  assert.equal(classifyRisk(normal), 'medium');
});

test('a forced power action is critical', () => {
  const shutdown = agentCommandBody.parse({
    type: 'power.action',
    payload: { action: 'shutdown', force: true },
  });
  assert.equal(classifyRisk(shutdown), 'critical');

  const plain = agentCommandBody.parse({
    type: 'power.action',
    payload: { action: 'shutdown' },
  });
  assert.equal(classifyRisk(plain), 'high');
});

test('process termination requires the caller to state the expected process name', () => {
  // Without this, a recycled PID lets a stale confirmation kill an unrelated process.
  const result = agentCommandBody.safeParse({
    type: 'process.terminate',
    payload: { pid: 5000 },
  });
  assert.equal(result.success, false);
});

test('process start takes an application id and an argument vector, never a shell string', () => {
  const rejected = agentCommandBody.safeParse({
    type: 'process.start',
    payload: { commandLine: 'cmd.exe /c del /q C:\\*' },
  });
  assert.equal(rejected.success, false);

  const accepted = agentCommandBody.safeParse({
    type: 'process.start',
    payload: { applicationId: '01J9ZQK7T0000000000000000A', arguments: ['--safe-mode'] },
  });
  assert.equal(accepted.success, true);
});

test('PID 0 is never an acceptable command target', () => {
  const result = agentCommandBody.safeParse({
    type: 'process.terminate',
    payload: { pid: 0, expectedName: 'System Idle Process' },
  });
  assert.equal(result.success, false);
});

test('a scheduled power action must name an explicit instant', () => {
  const withoutTime = agentCommandBody.safeParse({
    type: 'power.schedule',
    payload: { action: 'shutdown' },
  });
  assert.equal(withoutTime.success, false, 'a schedule with no runAt could fire at any time');

  const withTime = agentCommandBody.safeParse({
    type: 'power.schedule',
    payload: { action: 'shutdown', runAt: '2026-09-06T22:00:00.000Z' },
  });
  assert.equal(withTime.success, true);
});

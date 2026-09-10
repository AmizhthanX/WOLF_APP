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
import { policyFor } from '@wolf/shared-types';

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

test('reading disk health is low risk and needs no privileged grant', () => {
  const command = agentCommandBody.safeParse({
    type: 'disk.smart-health',
    payload: {},
  });
  assert.equal(command.success, true, 'the device id defaults to every drive');

  // Elevation and danger are different questions. This one needs administrator to read and
  // changes nothing, so gating it behind a single-use grant would tax a health check for no
  // safety at all — grants exist to gate destruction.
  const definition = COMMAND_REGISTRY['disk.smart-health'];
  assert.equal(definition.risk, 'low');
  assert.equal(definition.mutating, false);
  assert.equal(policyFor(definition.risk).requiresPrivilegedGrant, false);
});

test('disabling a device is critical, enabling one is not', () => {
  // Asymmetric on purpose. Enabling gives function back and can be undone by disabling
  // again; disabling on a machine nobody is sitting at can remove the means of undoing it.
  const disable = agentCommandBody.parse({
    type: 'device.set-enabled',
    payload: { instanceId: 'PCI\VEN_1', enabled: false, expectedName: 'Some device' },
  });
  const enable = agentCommandBody.parse({
    type: 'device.set-enabled',
    payload: { instanceId: 'PCI\VEN_1', enabled: true, expectedName: 'Some device' },
  });

  assert.equal(classifyRisk(disable), 'critical');
  assert.equal(policyFor('critical').requiresPrivilegedGrant, true);

  assert.equal(classifyRisk(enable), 'medium');
  assert.equal(policyFor(classifyRisk(enable)).requiresPrivilegedGrant, false);
});

test('a device change must name the device it expects', () => {
  // The same idea as terminating a process by pid and expected name: an instance id is
  // stable, but a dashboard can be minutes out of date.
  const withoutName = agentCommandBody.safeParse({
    type: 'device.set-enabled',
    payload: { instanceId: 'PCI\VEN_1', enabled: false },
  });

  assert.equal(withoutName.success, false);
});

/* ------------------------------------------------------------------------- */
/* Services                                                                   */
/* ------------------------------------------------------------------------- */

test('starting a service is safer than stopping one, and the risk says so', () => {
  const control = (name: string, action: 'start' | 'stop' | 'restart') =>
    classifyRisk({
      type: 'service.control',
      payload: { name, action, expectedDisplayName: 'Print Spooler' },
    });

  // The asymmetry is the whole point: starting restores function, and a service that should
  // not have been started can be stopped again. The reverse is not true from the other end of
  // a network.
  assert.equal(control('Spooler', 'start'), 'medium');
  assert.equal(control('Spooler', 'stop'), 'high');
  assert.equal(control('Spooler', 'restart'), 'high');
});

test('a service the way back in depends on is critical however it is asked for', () => {
  const stop = (name: string) =>
    classifyRisk({
      type: 'service.control',
      payload: { name, action: 'stop', expectedDisplayName: 'x' },
    });

  // The cloud's copy of the agent's refusal list. It exists so an operator is told what they
  // are about to attempt rather than discovering it from a refusal; the agent's copy is the
  // one that actually stops it, and it is the one that survives a tampered-with cloud.
  assert.equal(stop('Dhcp'), 'critical');
  assert.equal(stop('RpcSs'), 'critical');
  assert.equal(stop('BFE'), 'critical');
  assert.equal(stop('WolfAgent'), 'critical');

  // Case does not save you.
  assert.equal(stop('dhcp'), 'critical');
  assert.equal(stop('WOLFAGENT'), 'critical');
});

test('disabling a service is critical even when stopping it is not', () => {
  const setStartType = (name: string, startType: 'automatic' | 'manual' | 'disabled') =>
    classifyRisk({
      type: 'service.set-start-type',
      payload: { name, startType, expectedDisplayName: 'Print Spooler' },
    });

  // It survives a reboot, which makes it the more dangerous of the two: a service stopped by
  // mistake comes back when the machine does, and a disabled one does not.
  assert.equal(setStartType('Spooler', 'disabled'), 'critical');
  assert.equal(setStartType('Spooler', 'manual'), 'high');
  assert.equal(setStartType('Spooler', 'automatic'), 'high');
});

test('a service command needs the display name it was last seen under', () => {
  // Checked against the live service before anything happens, the same way terminating a
  // process checks the name against the pid. A list read a minute ago can describe a machine
  // that has changed since.
  assert.equal(
    agentCommandBody.safeParse({
      type: 'service.control',
      payload: { name: 'Spooler', action: 'stop' },
    }).success,
    false,
  );

  assert.ok(
    agentCommandBody.safeParse({
      type: 'service.control',
      payload: { name: 'Spooler', action: 'stop', expectedDisplayName: 'Print Spooler' },
    }).success,
  );
});

test('a service name is a name, not a path or a command line', () => {
  const parse = (name: string) =>
    agentCommandBody.safeParse({
      type: 'service.control',
      payload: { name, action: 'start', expectedDisplayName: 'x' },
    }).success;

  assert.ok(parse('Spooler'));
  assert.equal(parse('C:\\Windows\\System32\\spoolsv.exe'), false);
  assert.equal(parse('Spooler && whoami'), false);
  assert.equal(parse(''), false);
});

test('WOLF has no command that installs or removes a service', () => {
  // Stated as a test rather than only as a comment. Creating a service is a persistence
  // mechanism; a remote-management tool that can install one is a remote-persistence tool,
  // which is a different product with a different threat model.
  for (const type of ALL_COMMAND_TYPES) {
    assert.ok(
      !/^service\.(create|install|delete|remove|uninstall)/.test(type),
      `${type} would let WOLF install or remove a service`,
    );
  }
});

test('reading the service list is low risk but still its own capability', () => {
  // Changing nothing is not the same as being nothing: the service list tells you what a
  // machine runs, which is the first thing anybody looking for a way in wants to know.
  assert.equal(COMMAND_REGISTRY['service.list'].risk, 'low');
  assert.equal(COMMAND_REGISTRY['service.list'].mutating, false);
  assert.equal(requiredCapability('service.list'), 'services');
  assert.equal(requiredCapability('service.control'), 'services');
  assert.equal(requiredCapability('service.set-start-type'), 'services');
});

/* ------------------------------------------------------------------------- */
/* Scheduled tasks and startup items                                          */
/* ------------------------------------------------------------------------- */

test('WOLF has no command that creates or removes a task or a startup entry', () => {
  // The whole security argument for this area, stated as a test. A list of protected folders
  // can be incomplete; "there is no command that registers a task" cannot be. A scheduled task
  // and a Run key are the two mechanisms every piece of Windows malware reaches for.
  for (const type of ALL_COMMAND_TYPES) {
    assert.ok(
      !/^(task|startup)\.(create|register|add|delete|remove|uninstall|write)/.test(type),
      `${type} would let WOLF install or remove persistence`,
    );
  }

  assert.ok(!isKnownCommandType('task.register'));
  assert.ok(!isKnownCommandType('startup.add'));
});

test('a startup change can only turn something on or off', () => {
  // There is deliberately no `command` field. A payload that could set what an entry runs
  // would be one that could install persistence under an existing name, which is the thing
  // this whole area is built not to allow.
  const parsed = agentCommandBody.safeParse({
    type: 'startup.set-enabled',
    payload: { name: 'Spotify', scope: 'user', source: 'run', enabled: false, command: 'evil.exe' },
  });

  assert.ok(parsed.success);
  if (parsed.success && parsed.data.type === 'startup.set-enabled') {
    assert.equal('command' in parsed.data.payload, false, 'a command reached the agent');
  }
});

test('disabling a task Windows needs is critical; disabling an updater is not', () => {
  const disable = (path: string) =>
    classifyRisk({ type: 'task.control', payload: { path, action: 'disable', expectedName: 'x' } });

  // Servicing, recovery and security. The damage is slow: a machine that stops updating does
  // not fail, it degrades, and nobody attributes it to the right cause months later.
  assert.equal(disable('\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start'), 'critical');
  assert.equal(disable('\\Microsoft\\Windows\\Windows Defender\\Scan'), 'critical');
  assert.equal(disable('\\WOLF\\Watchdog'), 'critical');

  // The single most common thing an operator wants to switch off on somebody's machine. A
  // rule that caught it would make the feature useless for its main purpose.
  assert.equal(disable('\\Adobe Acrobat Update Task'), 'high');
});

test('running a task is riskier than enabling one', () => {
  const control = (action: 'enable' | 'disable' | 'run') =>
    classifyRisk({
      type: 'task.control',
      payload: { path: '\\Adobe Acrobat Update Task', action, expectedName: 'x' },
    });

  // Enabling restores something the machine was already configured to do. Running asks it to
  // execute something now — and what it executes was decided by whoever registered the task,
  // not by the operator pressing the button.
  assert.equal(control('enable'), 'medium');
  assert.equal(control('run'), 'high');
  assert.equal(control('disable'), 'high');
});

test('a task path is rooted and cannot climb out of itself', () => {
  const parse = (path: string) =>
    agentCommandBody.safeParse({
      type: 'task.control',
      payload: { path, action: 'enable', expectedName: 'x' },
    }).success;

  assert.ok(parse('\\Microsoft\\Windows\\Defrag\\ScheduledDefrag'));
  assert.ok(parse('\\Adobe Acrobat Update Task'));

  // The path that gets checked and the path that gets opened must be the same string — the
  // same rule the file manager's paths follow, for the same reason.
  assert.equal(parse('\\Microsoft\\..\\WOLF\\Watchdog'), false);
  assert.equal(parse('Microsoft\\Windows'), false, 'a task path is rooted');
  assert.equal(parse(''), false);
});

test('reading what a machine runs on its own is low risk and audited anyway', () => {
  // "What runs on this machine when nobody is watching" is a useful question and also exactly
  // what somebody planning to abuse it wants to know, so it is audited despite changing
  // nothing.
  assert.equal(COMMAND_REGISTRY['task.list'].risk, 'low');
  assert.equal(COMMAND_REGISTRY['task.list'].mutating, false);
  assert.equal(COMMAND_REGISTRY['task.list'].auditCategory, 'scheduled-task');
  assert.equal(COMMAND_REGISTRY['startup.list'].auditCategory, 'startup');

  // Startup items are machine configuration; scheduled tasks sit with services.
  assert.equal(requiredCapability('task.list'), 'services');
  assert.equal(requiredCapability('startup.list'), 'configuration');
});

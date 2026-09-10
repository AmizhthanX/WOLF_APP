import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_COMMAND_TYPES,
  COMMAND_REGISTRY,
  agentCommandBody,
  classifyRisk,
  isKnownCommandType,
  isProbeableTarget,
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

/* ------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* ------------------------------------------------------------------------- */

test('a network test is classified as an action, not a read', () => {
  // It is not a read. It makes somebody else's machine send packets to a destination the
  // operator chose, so it is mutating for audit purposes and sits above the reads around it.
  assert.equal(COMMAND_REGISTRY['network.test'].mutating, true);
  assert.notEqual(COMMAND_REGISTRY['network.test'].risk, 'low');

  assert.equal(COMMAND_REGISTRY['network.info'].mutating, false);
  assert.equal(COMMAND_REGISTRY['hardware.inventory'].mutating, false);
});

test('a probe target is one host and never a range', () => {
  const parse = (target: string) =>
    agentCommandBody.safeParse({
      type: 'network.test',
      payload: { test: 'ping', target },
    }).success;

  assert.ok(parse('192.168.1.1'));
  assert.ok(parse('fileserver.corp.example'));
  assert.ok(parse('2606:4700:4700::1111'));

  // Each of these turns one command into a sweep, which is the thing this is built not to be.
  assert.equal(parse('192.168.1.0/24'), false);
  assert.equal(parse('10.0.0.1,10.0.0.2'), false);
  assert.equal(parse('10.0.0.1 10.0.0.2'), false);
  assert.equal(parse(''), false);
});

test('WOLF refuses the addresses that reach a whole segment, and nothing else', () => {
  // It does not try to tell a legitimate destination from an illegitimate one, because it
  // cannot: "can this PC reach the file server" and "can this PC reach the internet" are the
  // two most common diagnostics there are.
  assert.ok(isProbeableTarget('192.168.1.10'));
  assert.ok(isProbeableTarget('8.8.8.8'));
  assert.ok(isProbeableTarget('127.0.0.1'));

  assert.equal(isProbeableTarget('255.255.255.255'), false);
  assert.equal(isProbeableTarget('192.168.1.255'), false);
  assert.equal(isProbeableTarget('224.0.0.1'), false);
  assert.equal(isProbeableTarget('ff02::1'), false);
});

test('a tcp test takes one port, and there is no field for a range', () => {
  const parsed = agentCommandBody.safeParse({
    type: 'network.test',
    payload: { test: 'tcp', target: '192.168.1.1', port: 445, portTo: 500 },
  });

  assert.ok(parsed.success);
  if (parsed.success && parsed.data.type === 'network.test') {
    // A port range is a port scan with a different name. An extra field is dropped rather
    // than carried to the agent as something it might one day read.
    assert.equal('portTo' in parsed.data.payload, false);
  }

  assert.equal(
    agentCommandBody.safeParse({
      type: 'network.test',
      payload: { test: 'tcp', target: '192.168.1.1', port: 70_000 },
    }).success,
    false,
  );
});

test('an event log query is bounded in every direction', () => {
  const parse = (payload: Record<string, unknown>) =>
    agentCommandBody.safeParse({ type: 'eventlog.query', payload }).success;

  assert.ok(parse({ log: 'System' }));

  // The list of logs is fixed rather than passed through: an arbitrary name would be one more
  // string from the network deciding what a SYSTEM process opens.
  assert.equal(parse({ log: 'ForwardedEvents' }), false);

  // A week is the most WOLF will scan, and 200 events the most it will carry.
  assert.equal(parse({ log: 'System', withinHours: 10_000 }), false);
  assert.equal(parse({ log: 'System', limit: 10_000 }), false);

  const defaults = agentCommandBody.parse({ type: 'eventlog.query', payload: { log: 'System' } });
  if (defaults.type === 'eventlog.query') {
    // Warnings and worse by default: `information` on a busy machine is thousands of rows of
    // nothing, and somebody looking for a problem is not looking for those.
    assert.equal(defaults.payload.minimumLevel, 'warning');
  }
});

test('reading the Security log is escalated past the other logs', () => {
  const level = (log: 'System' | 'Security') =>
    classifyRisk({ type: 'eventlog.query', payload: { log, minimumLevel: 'warning', withinHours: 24, limit: 100 } });

  // Still a read, and an investigation needs it — but reading it is reading who signed in,
  // when, and from where, so the confirmation should say what is being opened.
  assert.equal(level('System'), 'low');
  assert.equal(level('Security'), 'medium');
});

test('serial numbers are off unless the inventory asks for them', () => {
  const parsed = agentCommandBody.parse({ type: 'hardware.inventory', payload: {} });

  // They are a stable identifier for a physical object, so taking them is a deliberate act
  // rather than a side effect of asking what a PC is made of.
  if (parsed.type === 'hardware.inventory') {
    assert.equal(parsed.payload.includeSerialNumbers, false);
  }
});

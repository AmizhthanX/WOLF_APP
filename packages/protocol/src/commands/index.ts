import { z } from 'zod';
import type { RiskLevel, SessionCapability } from '@wolf/shared-types';
import { maxRisk } from '@wolf/shared-types';
import { CRITICAL_SYSTEM_PROCESSES, WOLF_OWN_PROCESSES, processCommand } from './process.js';
import { deviceCommand } from './device.js';
import { diskCommand } from './disk.js';
import { powerCommand } from './power.js';
import { remoteDesktopCommand } from './remote-desktop.js';
import { autorunCommand, isProtectedTask } from './autorun.js';
import { diagnosticsCommand } from './diagnostics.js';
import { isUnstoppableService, serviceCommand } from './service.js';
import { systemCommand } from './system.js';

export * from './process.js';
export * from './device.js';
export * from './disk.js';
export * from './power.js';
export * from './remote-desktop.js';
export * from './autorun.js';
export * from './diagnostics.js';
export * from './service.js';
export * from './system.js';

/**
 * The complete set of commands the cloud can dispatch to an agent.
 *
 * New capability areas (files, terminal, services, automation, configuration) are added
 * here as their vertical slice lands. A command type that is not in this union cannot be
 * dispatched, and an agent that does not advertise support for a type in its capability
 * handshake is told so explicitly rather than having the command silently queued.
 */
export const agentCommandBody = z.union([
  processCommand,
  deviceCommand,
  diskCommand,
  powerCommand,
  remoteDesktopCommand,
  serviceCommand,
  autorunCommand,
  diagnosticsCommand,
  systemCommand,
]);
export type AgentCommandBody = z.infer<typeof agentCommandBody>;
export type AgentCommandType = AgentCommandBody['type'];

export interface CommandDefinition {
  /** Baseline risk before payload-specific escalation. */
  readonly risk: RiskLevel;
  /** Session capability the caller must hold. */
  readonly capability: SessionCapability;
  /** True when the command changes system state (drives audit + idempotency handling). */
  readonly mutating: boolean;
  /** Human-readable action name used in audit records and confirmation prompts. */
  readonly description: string;
  /** Audit category the resulting record is filed under. */
  readonly auditCategory:
    | 'process'
    | 'power'
    | 'pc'
    | 'session'
    | 'unlock'
    | 'service'
    | 'scheduled-task'
    | 'startup';
}

export const COMMAND_REGISTRY: Readonly<Record<AgentCommandType, CommandDefinition>> =
  Object.freeze({
    /**
     * Reading a drive's health needs administrative rights, but changes nothing, so it is
     * low risk and needs no privileged grant. Elevation and danger are different questions:
     * a grant exists to gate destruction, not to tax every call that happens to need
     * administrator to read.
     */
    'device.list': {
      risk: 'low',
      capability: 'configuration',
      mutating: false,
      description: 'List hardware devices',
      auditCategory: 'pc',
    },
    /**
     * Baseline only. Enabling a device restores function and stays here; disabling one is
     * escalated to critical by `classifyRisk`, because it is the direction that cannot be
     * undone from the other end of a network.
     */
    'device.set-enabled': {
      risk: 'medium',
      capability: 'configuration',
      mutating: true,
      description: 'Enable or disable a hardware device',
      auditCategory: 'pc',
    },
    'disk.smart-health': {
      risk: 'low',
      capability: 'configuration',
      mutating: false,
      description: 'Read disk health',
      auditCategory: 'pc',
    },
    'system.info': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read system information',
      auditCategory: 'pc',
    },
    'system.capabilities': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read PC capabilities',
      auditCategory: 'pc',
    },
    'system.telemetry-snapshot': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read a telemetry snapshot',
      auditCategory: 'pc',
    },
    'system.session-state': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read Windows session state',
      auditCategory: 'pc',
    },
    'process.list': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'List processes',
      auditCategory: 'process',
    },
    'process.tree': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read the process tree',
      auditCategory: 'process',
    },
    'process.details': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read process details',
      auditCategory: 'process',
    },
    'process.terminate': {
      risk: 'medium',
      capability: 'processes',
      mutating: true,
      description: 'Terminate a process',
      auditCategory: 'process',
    },
    'process.set-priority': {
      risk: 'medium',
      capability: 'processes',
      mutating: true,
      description: 'Change process priority',
      auditCategory: 'process',
    },
    'process.start': {
      risk: 'medium',
      capability: 'processes',
      mutating: true,
      description: 'Start an application',
      auditCategory: 'process',
    },
    'power.action': {
      risk: 'high',
      capability: 'power',
      mutating: true,
      description: 'Run a power action',
      auditCategory: 'power',
    },
    'power.schedule': {
      risk: 'high',
      capability: 'power',
      mutating: true,
      description: 'Schedule a power action',
      auditCategory: 'power',
    },
    'power.cancel': {
      risk: 'medium',
      capability: 'power',
      mutating: true,
      description: 'Cancel a pending power action',
      auditCategory: 'power',
    },
    'power.pending': {
      risk: 'low',
      capability: 'power',
      mutating: false,
      description: 'List pending power actions',
      auditCategory: 'power',
    },
    'power.wake': {
      risk: 'medium',
      capability: 'power',
      mutating: true,
      description: 'Send a wake request',
      auditCategory: 'power',
    },
    'remote-desktop.list-displays': {
      risk: 'low',
      capability: 'screen',
      mutating: false,
      description: 'List displays',
      auditCategory: 'session',
    },
    'remote-desktop.status': {
      risk: 'low',
      capability: 'screen',
      mutating: false,
      description: 'Read remote desktop status',
      auditCategory: 'session',
    },
    'remote-desktop.stop': {
      risk: 'low',
      capability: 'screen',
      mutating: true,
      description: 'Stop a remote desktop stream',
      auditCategory: 'session',
    },
    /**
     * Reading the service list changes nothing, but it is not nothing: it tells you what a
     * machine runs, which is the first thing anybody looking for a way in wants to know. Low
     * risk, its own capability, and audited like everything else.
     */
    'service.list': {
      risk: 'low',
      capability: 'services',
      mutating: false,
      description: 'List Windows services',
      auditCategory: 'service',
    },
    /**
     * Baseline only. Starting a service restores function and stays here; stopping or
     * restarting one is escalated by `classifyRisk`, because those are the directions that
     * can take a machine off the network from the other end of a network.
     */
    'service.control': {
      risk: 'medium',
      capability: 'services',
      mutating: true,
      description: 'Start, stop or restart a service',
      auditCategory: 'service',
    },
    /**
     * Higher than controlling one, because it survives a reboot. A service stopped by mistake
     * comes back when the machine does; a disabled one does not.
     */
    'service.set-start-type': {
      risk: 'high',
      capability: 'services',
      mutating: true,
      description: 'Change when a service starts',
      auditCategory: 'service',
    },
    /**
     * Reading what a machine runs on its own changes nothing and is not nothing. Scheduled
     * tasks and startup entries are where persistence lives, so the list is the first thing
     * an investigation reads — and the first thing somebody planning to abuse the machine
     * wants. Low risk, audited like everything else.
     */
    'task.list': {
      risk: 'low',
      capability: 'services',
      mutating: false,
      description: 'List scheduled tasks',
      auditCategory: 'scheduled-task',
    },
    /**
     * Baseline only. Enabling is recoverable; `classifyRisk` escalates disabling a protected
     * task to critical, and running one to high — running a configured task is not creating
     * one, but it is still asking the machine to execute something.
     */
    'task.control': {
      risk: 'medium',
      capability: 'services',
      mutating: true,
      description: 'Enable, disable or run a scheduled task',
      auditCategory: 'scheduled-task',
    },
    'startup.list': {
      risk: 'low',
      capability: 'configuration',
      mutating: false,
      description: 'List what runs at sign-in',
      auditCategory: 'startup',
    },
    /**
     * Turning a startup entry off is reversible by design — the entry survives and only
     * Windows' approval flag changes — which is why this is medium rather than high.
     */
    'startup.set-enabled': {
      risk: 'medium',
      capability: 'configuration',
      mutating: true,
      description: 'Turn a startup entry on or off',
      auditCategory: 'startup',
    },
    /**
     * What the machine's network looks like from inside it: addresses, gateways, DNS servers,
     * routes, and optionally what it has open. Reads nothing off the disk and sends nothing
     * anywhere.
     */
    'network.info': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read network configuration',
      auditCategory: 'pc',
    },
    /**
     * Not a read, whatever it looks like. This makes somebody else's machine send packets to
     * a destination the operator chose, so it is audited as an action and classified above
     * the reads around it — and the audit record names the target, which is what makes the
     * difference between a diagnostic tool and a scanner accountable rather than assumed.
     */
    'network.test': {
      risk: 'medium',
      capability: 'processes',
      mutating: true,
      description: 'Test whether this PC can reach a host',
      auditCategory: 'pc',
    },
    /**
     * The one diagnostic read whose *content* crosses the cloud. An event message can carry an
     * account name, a command line, or — from software that should know better — a credential.
     * Bounded rather than blocked, and the exposure is written down in the security model.
     */
    'eventlog.query': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read Windows event log entries',
      auditCategory: 'pc',
    },
    'hardware.inventory': {
      risk: 'low',
      capability: 'processes',
      mutating: false,
      description: 'Read what this PC is made of',
      auditCategory: 'pc',
    },
    'power.unlock': {
      risk: 'critical',
      capability: 'privileged',
      mutating: true,
      description: 'Unlock the Windows session remotely',
      auditCategory: 'unlock',
    },
  });

/**
 * Final risk level for a specific command instance.
 *
 * The registry gives the baseline; this escalates for payloads that are materially more
 * dangerous than the typical use of the same command — terminating a critical system
 * process, killing WOLF's own agent, forcing a shutdown, or setting realtime priority.
 */
export function classifyRisk(command: AgentCommandBody): RiskLevel {
  const base = COMMAND_REGISTRY[command.type].risk;

  switch (command.type) {
    case 'process.terminate': {
      const name = command.payload.expectedName.toLowerCase();
      if (CRITICAL_SYSTEM_PROCESSES.has(name)) return 'critical';
      if (WOLF_OWN_PROCESSES.has(name)) return 'high';
      if (command.payload.force || command.payload.includeChildren) return maxRisk(base, 'high');
      return base;
    }
    case 'device.set-enabled': {
      // Asymmetric on purpose. Enabling a device gives function back and is recoverable by
      // disabling it again. Disabling one on a machine nobody is sitting at can remove the
      // means of undoing it, so it takes a confirmation, a re-authentication and a
      // single-use privileged grant.
      return command.payload.enabled ? base : 'critical';
    }
    case 'service.control': {
      // Starting is the safe direction: it restores function, and a service that should not
      // have been started can be stopped again — which is not true the other way round.
      if (command.payload.action === 'start') return base;

      // The cloud's copy of the refusal list. It exists to tell an operator what they are
      // about to attempt rather than letting them find out from the agent's refusal; the
      // agent's copy is the one that actually stops it.
      if (isUnstoppableService(command.payload.name)) return 'critical';

      return maxRisk(base, 'high');
    }
    case 'service.set-start-type': {
      // Disabling is the one that does not come back, so it takes a confirmation, a
      // re-authentication and a single-use privileged grant.
      if (command.payload.startType === 'disabled') return 'critical';
      if (isUnstoppableService(command.payload.name)) return 'critical';
      return base;
    }
    case 'task.control': {
      // Enabling restores something the machine was already configured to do, and can be
      // undone by disabling it again. The other two cannot be dismissed as lightly.
      if (command.payload.action === 'enable') return base;

      // Running a configured task is not creating one, but it is still asking the machine to
      // execute something — and what it executes was decided by whoever registered the task,
      // not by the operator pressing the button.
      if (command.payload.action === 'run') return maxRisk(base, 'high');

      // Disabling servicing, recovery or security tasks is the kind of slow damage nobody
      // attributes to the right cause months later.
      return isProtectedTask(command.payload.path) ? 'critical' : maxRisk(base, 'high');
    }
    case 'eventlog.query':
      // Reading the Security log is reading who signed in, when, and from where. Still low
      // risk — it changes nothing and an investigation needs it — but escalated past the
      // other logs so the confirmation says what is being opened.
      return command.payload.log === 'Security' ? maxRisk(base, 'medium') : base;
    case 'process.set-priority':
      // Realtime priority can starve the input and capture threads, which is how an
      // operator loses the very session they are using to fix the problem.
      return command.payload.priority === 'realtime' ? maxRisk(base, 'high') : base;
    case 'power.action':
    case 'power.schedule':
      return command.payload.force ? maxRisk(base, 'critical') : base;
    default:
      return base;
  }
}

/** Session capability required to dispatch a command. */
export function requiredCapability(type: AgentCommandType): SessionCapability {
  return COMMAND_REGISTRY[type].capability;
}

/** True when the command changes state and therefore needs idempotency + audit handling. */
export function isMutating(type: AgentCommandType): boolean {
  return COMMAND_REGISTRY[type].mutating;
}

export const ALL_COMMAND_TYPES = Object.keys(COMMAND_REGISTRY) as AgentCommandType[];

export function isKnownCommandType(value: string): value is AgentCommandType {
  return Object.hasOwn(COMMAND_REGISTRY, value);
}

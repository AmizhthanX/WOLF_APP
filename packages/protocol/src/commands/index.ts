import { z } from 'zod';
import type { RiskLevel, SessionCapability } from '@wolf/shared-types';
import { maxRisk } from '@wolf/shared-types';
import { CRITICAL_SYSTEM_PROCESSES, WOLF_OWN_PROCESSES, processCommand } from './process.js';
import { diskCommand } from './disk.js';
import { powerCommand } from './power.js';
import { remoteDesktopCommand } from './remote-desktop.js';
import { systemCommand } from './system.js';

export * from './process.js';
export * from './disk.js';
export * from './power.js';
export * from './remote-desktop.js';
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
  diskCommand,
  powerCommand,
  remoteDesktopCommand,
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
    | 'unlock';
}

export const COMMAND_REGISTRY: Readonly<Record<AgentCommandType, CommandDefinition>> =
  Object.freeze({
    /**
     * Reading a drive's health needs administrative rights, but changes nothing, so it is
     * low risk and needs no privileged grant. Elevation and danger are different questions:
     * a grant exists to gate destruction, not to tax every call that happens to need
     * administrator to read.
     */
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

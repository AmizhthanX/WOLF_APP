import type { AgentCommandBody, AgentCommandType } from '@wolf/protocol';

/**
 * Audit projections for commands.
 *
 * These deliberately return a small, fixed set of fields rather than the payload or result
 * itself. An audit row records what was targeted and what changed — never file contents,
 * terminal output, clipboard data, or credential material that a future command type might
 * carry in its payload.
 */

/** Safe, non-secret description of what a command targeted. */
export function commandAuditTarget(
  command: AgentCommandBody,
): Record<string, string | number | boolean | null> {
  switch (command.type) {
    case 'process.terminate':
    case 'process.set-priority':
      return { kind: 'process', pid: command.payload.pid, name: command.payload.expectedName };
    case 'process.details':
      return { kind: 'process', pid: command.payload.pid };
    case 'process.start':
      return { kind: 'application', applicationId: command.payload.applicationId };
    case 'power.action':
      return { kind: 'power', action: command.payload.action, force: command.payload.force };
    case 'power.schedule':
      return { kind: 'power', action: command.payload.action, runAt: command.payload.runAt };
    case 'power.cancel':
      return { kind: 'power', pendingActionId: command.payload.pendingActionId };
    case 'power.wake':
      return { kind: 'power', targetPcId: command.payload.targetPcId };
    case 'power.unlock':
      // The credential id, never the credential.
      return { kind: 'unlock', credentialId: command.payload.credentialId };
    default:
      return { kind: command.type };
  }
}

/** Outcome summary for the audit record. Never the full result payload. */
export function commandAuditAfterValue(
  type: AgentCommandType,
  result: unknown,
): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  switch (type) {
    case 'process.terminate':
      return { method: record['method'], childrenTerminated: record['childrenTerminated'] };
    case 'process.set-priority':
      return { previousPriority: record['previousPriority'], priority: record['priority'] };
    case 'process.start':
      return { pid: record['pid'] };
    case 'power.action':
      return { completed: record['completed'], runAt: record['runAt'] };
    case 'power.schedule':
      return { pendingActionId: record['pendingActionId'], runAt: record['runAt'] };
    case 'power.unlock':
      return { unlocked: record['unlocked'], sessionState: record['sessionState'] };
    default:
      return null;
  }
}

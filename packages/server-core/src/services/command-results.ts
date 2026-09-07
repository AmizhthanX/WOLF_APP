import { COMMAND_REGISTRY, resultSchemaFor, type CommandResult } from '@wolf/protocol';
import type { ServerContext } from '../context.js';
import { commandAuditAfterValue, commandAuditTarget } from './command-audit.js';

/**
 * Apply a command result reported by an agent.
 *
 * The result is validated against the schema for its command type. An agent that returns
 * something that does not match the contract produces a recorded failure rather than a
 * silently stored blob — a UI must never render a "success" it cannot interpret.
 */
export async function applyCommandResult(
  context: ServerContext,
  pcId: string,
  result: CommandResult,
): Promise<void> {
  const { repos } = context;
  const command = await repos.commands.findById(result.commandId);

  if (!command || command.pcId !== pcId) {
    // A result for a command this PC was never given is either a bug or an attempt to
    // write someone else's history. Log it and drop it.
    context.logger.warn(
      { commandId: result.commandId, pcId },
      'Discarded a result for a command this PC does not own',
    );
    return;
  }

  let storedResult: unknown = null;
  let errorCode = result.failure?.code ?? null;
  let errorMessage = result.failure?.message ?? null;
  let status: CommandResult['status'] = result.status;

  if (result.status === 'completed') {
    const parsed = resultSchemaFor(command.type).safeParse(result.result);
    if (parsed.success) {
      storedResult = parsed.data;
    } else {
      status = 'failed';
      errorCode = 'agent-error';
      errorMessage = 'The agent returned a result that does not match the command contract.';
      context.logger.error(
        { commandId: command.id, type: command.type, issueCount: parsed.error.issues.length },
        'Agent result failed schema validation',
      );
    }
  }

  if (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'rejected'
  ) {
    // Not terminal yet: record progress and wait for the real outcome.
    if (status === 'running') {
      await repos.commands.markRunning(
        command.id,
        result.startedAt ? new Date(result.startedAt) : context.now(),
      );
    }
    return;
  }

  await repos.commands.complete({
    id: command.id,
    status,
    startedAt: result.startedAt ? new Date(result.startedAt) : null,
    completedAt: result.completedAt ? new Date(result.completedAt) : context.now(),
    errorCode,
    errorMessage,
    errorIsLimitation: result.failure?.limitation ?? false,
    result: storedResult,
  });

  await repos.audit.record({
    category: COMMAND_REGISTRY[command.type].auditCategory,
    action: command.type,
    outcome: status === 'completed' ? 'success' : 'failure',
    riskLevel: command.riskLevel,
    userId: command.userId,
    deviceId: command.deviceId,
    pcId: command.pcId,
    sessionId: command.sessionId,
    requestId: command.requestId,
    target: commandAuditTarget(command.payload),
    afterValue: status === 'completed' ? commandAuditAfterValue(command.type, storedResult) : null,
    errorCode,
  });
}

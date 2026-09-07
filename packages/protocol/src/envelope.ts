import { z } from 'zod';
import { idempotencyKey, isoDateTime, wolfId } from '@wolf/validation';
import { RISK_LEVELS, CONNECTION_ROUTES, SESSION_CAPABILITIES } from '@wolf/shared-types';
import { agentCommandBody } from './commands/index.js';

export const PROTOCOL_VERSION = 1;

/**
 * Proof, recorded at dispatch time, that the API performed the authorization the command's
 * risk level demands. It carries no secrets: no confirmation token, no password, no
 * privileged credential — only the fact that each check was satisfied, and when.
 *
 * The agent does not re-derive authorization from this; it trusts its mutually
 * authenticated cloud link. This context exists so that every audit record can answer
 * "on what basis was this allowed?" without replaying the request.
 */
export const authorizationContext = z.object({
  userId: wolfId,
  deviceId: wolfId,
  sessionId: wolfId,
  route: z.enum(CONNECTION_ROUTES),
  /** Capabilities the session held at dispatch time. */
  grantedCapabilities: z.array(z.enum(SESSION_CAPABILITIES)).max(SESSION_CAPABILITIES.length),
  /** Risk level the API classified this command instance at. */
  riskLevel: z.enum(RISK_LEVELS),
  /** When the operator explicitly confirmed the action; null when none was required. */
  confirmedAt: isoDateTime.nullable(),
  /** When the operator last re-entered their password; null when none was required. */
  reauthenticatedAt: isoDateTime.nullable(),
  /** Identifier of the privileged grant used, for critical commands. Null otherwise. */
  privilegedGrantId: wolfId.nullable(),
});
export type AuthorizationContext = z.infer<typeof authorizationContext>;

export const commandEnvelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: wolfId,
  pcId: wolfId,
  /** Correlates the command with the HTTP request and every log line it produced. */
  requestId: wolfId,
  issuedAt: isoDateTime,
  /**
   * After this instant the agent must refuse the command rather than run it late. This is
   * what stops a queued action from firing at an arbitrary time when connectivity returns.
   */
  expiresAt: isoDateTime,
  /** Client-supplied key; the agent must run a repeated key at most once. */
  idempotencyKey,
  authorization: authorizationContext,
  command: agentCommandBody,
});
export type CommandEnvelope = z.infer<typeof commandEnvelope>;

/** Lifecycle of a command from creation to terminal state. */
export const COMMAND_STATUSES = [
  'pending',
  'queued',
  'sent',
  'running',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'rejected',
] as const;
export const commandStatus = z.enum(COMMAND_STATUSES);
export type CommandStatus = z.infer<typeof commandStatus>;

export const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'expired',
  'rejected',
];

export function isTerminalStatus(status: CommandStatus): boolean {
  return TERMINAL_COMMAND_STATUSES.includes(status);
}

/**
 * Why a command did not succeed. Codes are stable and machine-readable; the agent never
 * returns a bare failure, because the UI has to tell the operator what to do next.
 */
export const COMMAND_ERROR_CODES = [
  'unsupported-command',
  'unsupported-on-this-windows-version',
  'capability-unavailable',
  'not-found',
  'target-changed',
  'access-denied',
  'requires-elevation',
  'privileged-helper-unavailable',
  'blocked-by-policy',
  'blocked-by-kill-switch',
  'timeout',
  'expired',
  'cancelled',
  'agent-error',
  'invalid-payload',
] as const;
export const commandErrorCode = z.enum(COMMAND_ERROR_CODES);
export type CommandErrorCode = z.infer<typeof commandErrorCode>;

/**
 * Failure detail carried back to the operator. `limitation` marks the case where Windows
 * itself prevents the operation: WOLF surfaces that explicitly instead of reporting a
 * success that did not happen.
 */
export const commandFailure = z.object({
  code: commandErrorCode,
  message: z.string().max(500),
  /** True when this is a Windows platform limitation rather than a WOLF failure. */
  limitation: z.boolean().default(false),
  recommendedAction: z.string().max(300).nullable(),
});
export type CommandFailure = z.infer<typeof commandFailure>;

export const commandResult = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: wolfId,
  status: commandStatus,
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  /** Present only when the command did not complete successfully. */
  failure: commandFailure.nullable(),
  /** Command-specific payload, validated against the matching schema in `results.ts`. */
  result: z.unknown().nullable(),
  agentVersion: z.string().max(64),
});
export type CommandResult = z.infer<typeof commandResult>;

/** Progress update for long-running commands, sent before the terminal result. */
export const commandProgress = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: wolfId,
  percent: z.number().min(0).max(100).nullable(),
  message: z.string().max(200).nullable(),
  at: isoDateTime,
});
export type CommandProgress = z.infer<typeof commandProgress>;

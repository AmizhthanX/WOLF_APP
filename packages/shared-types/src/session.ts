import type { DeviceId, PcId, SessionId, UserId } from './ids.js';
import type { ConnectionRoute, ConnectionState } from './connection.js';

/**
 * Capabilities are granted per session and authorized independently. A session that can
 * see the screen does not thereby get input, clipboard, files, or a terminal.
 */
export const SESSION_CAPABILITIES = [
  'screen',
  'audio',
  'input',
  'clipboard',
  'file-transfer',
  'terminal',
  'terminal-admin',
  'processes',
  'services',
  'power',
  'configuration',
  'privileged',
] as const;
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number];

/** Read-only capabilities never require arbitration. */
export const READ_ONLY_CAPABILITIES: readonly SessionCapability[] = ['screen', 'audio'];

/**
 * Exclusive resources. At most one session may hold each at a time; they are arbitrated
 * independently so a file transfer does not block someone else's terminal.
 */
export const EXCLUSIVE_RESOURCES = [
  'input',
  'terminal',
  'file-operations',
  'power',
  'configuration',
] as const;
export type ExclusiveResource = (typeof EXCLUSIVE_RESOURCES)[number];

export const SESSION_MODES = ['view-only', 'control'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_STATUSES = ['pending', 'active', 'idle', 'ended', 'expired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly pcId: PcId;
  readonly mode: SessionMode;
  readonly status: SessionStatus;
  readonly state: ConnectionState;
  readonly route: ConnectionRoute | null;
  readonly capabilities: readonly SessionCapability[];
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  /** Exclusive resources currently owned by this session. */
  readonly heldResources: readonly ExclusiveResource[];
}

export interface ResourceLease {
  readonly resource: ExclusiveResource;
  readonly sessionId: SessionId;
  readonly acquiredAt: string;
  /** Automatic release deadline after inactivity; refreshed on use. */
  readonly expiresAt: string;
}

export const CONTROL_REQUEST_STATES = [
  'requested',
  'granted',
  'denied',
  'released',
  'expired',
  'preempted',
] as const;
export type ControlRequestState = (typeof CONTROL_REQUEST_STATES)[number];

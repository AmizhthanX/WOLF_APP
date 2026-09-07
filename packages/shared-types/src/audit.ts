import type { AuditId, DeviceId, PcId, RequestId, SessionId, UserId } from './ids.js';
import type { ConnectionRoute } from './connection.js';
import type { RiskLevel } from './risk.js';

export const AUDIT_CATEGORIES = [
  'authentication',
  'device',
  'pc',
  'session',
  'process',
  'service',
  'application',
  'startup',
  'scheduled-task',
  'file',
  'terminal',
  'power',
  'unlock',
  'privilege',
  'configuration',
  'automation',
  'security',
  'kill-switch',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'pending'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Forensic audit record. Must never contain secrets, passwords, clipboard contents,
 * file contents, or terminal output — only metadata and safe before/after values.
 */
export interface AuditEvent {
  readonly id: AuditId;
  readonly occurredAt: string;
  readonly category: AuditCategory;
  /** Dotted action name, e.g. "process.terminate". */
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly riskLevel: RiskLevel;
  readonly userId: UserId | null;
  readonly deviceId: DeviceId | null;
  readonly pcId: PcId | null;
  readonly sessionId: SessionId | null;
  readonly requestId: RequestId | null;
  /** Network origin classification, never a precise geolocation. */
  readonly sourceIp: string | null;
  readonly route: ConnectionRoute | null;
  /** What was acted on, e.g. { kind: "process", pid: 4821, name: "chrome.exe" }. */
  readonly target: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly beforeValue: Readonly<Record<string, unknown>> | null;
  readonly afterValue: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly referenceId: string | null;
}

export const SECURITY_EVENT_TYPES = [
  'login-failure',
  'brute-force-block',
  'token-replay',
  'device-revoked',
  'pc-revoked',
  'kill-switch-engaged',
  'kill-switch-released',
  'privilege-denied',
  'unauthorized-command',
  'rate-limit-exceeded',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * Risk classification drives the confirmation a command requires before the API will
 * dispatch it. Classification lives next to the command definitions in @wolf/protocol;
 * this module defines the levels and what each demands.
 */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskPolicy {
  /** Client must send an explicit confirmation token acknowledging the action. */
  readonly requiresConfirmation: boolean;
  /** Caller must re-authenticate with their account password within the freshness window. */
  readonly requiresPasswordReauth: boolean;
  /** Requires a privileged authorization grant on the session (elevation). */
  readonly requiresPrivilegedGrant: boolean;
  /** How recently the re-authentication must have happened, in seconds. */
  readonly reauthMaxAgeSeconds: number;
}

export const RISK_POLICIES: Readonly<Record<RiskLevel, RiskPolicy>> = Object.freeze({
  low: {
    requiresConfirmation: false,
    requiresPasswordReauth: false,
    requiresPrivilegedGrant: false,
    reauthMaxAgeSeconds: 0,
  },
  medium: {
    requiresConfirmation: true,
    requiresPasswordReauth: false,
    requiresPrivilegedGrant: false,
    reauthMaxAgeSeconds: 0,
  },
  high: {
    requiresConfirmation: true,
    requiresPasswordReauth: true,
    requiresPrivilegedGrant: false,
    reauthMaxAgeSeconds: 300,
  },
  critical: {
    requiresConfirmation: true,
    requiresPasswordReauth: true,
    requiresPrivilegedGrant: true,
    reauthMaxAgeSeconds: 120,
  },
});

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskAtLeast(level: RiskLevel, minimum: RiskLevel): boolean {
  return ORDER[level] >= ORDER[minimum];
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function policyFor(level: RiskLevel): RiskPolicy {
  return RISK_POLICIES[level];
}

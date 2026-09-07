/**
 * Brute-force resistance for the owner account.
 *
 * Failures are counted per account and per source, and each additional failure lengthens
 * the wait exponentially. The account is never permanently locked: a permanent lock on a
 * single-owner product is a denial-of-service anyone can trigger. Instead the delay grows
 * until guessing is useless, and every block is recorded as a security event.
 */

export interface LockoutPolicy {
  /** Failures allowed before any delay is imposed. */
  readonly freeAttempts: number;
  /** Delay after the first penalised failure, in seconds. */
  readonly baseDelaySeconds: number;
  /** Upper bound on the computed delay, in seconds. */
  readonly maxDelaySeconds: number;
  /** Failures older than this are forgotten. */
  readonly windowSeconds: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = Object.freeze({
  freeAttempts: 3,
  baseDelaySeconds: 5,
  maxDelaySeconds: 900,
  windowSeconds: 3600,
});

export interface LockoutState {
  /** Failures inside the current window. */
  readonly failureCount: number;
  /** When the most recent failure happened. */
  readonly lastFailureAt: Date | null;
}

export type LockoutDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

function requiredDelaySeconds(failureCount: number, policy: LockoutPolicy): number {
  const penalised = failureCount - policy.freeAttempts;
  if (penalised <= 0) return 0;
  const delay = policy.baseDelaySeconds * 2 ** (penalised - 1);
  return Math.min(delay, policy.maxDelaySeconds);
}

/** Whether an authentication attempt may proceed right now. */
export function evaluateLockout(
  state: LockoutState,
  now: Date = new Date(),
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutDecision {
  if (!state.lastFailureAt || state.failureCount <= policy.freeAttempts) {
    return { allowed: true };
  }

  const sinceLastFailure = (now.getTime() - state.lastFailureAt.getTime()) / 1000;
  if (sinceLastFailure >= policy.windowSeconds) return { allowed: true };

  const required = requiredDelaySeconds(state.failureCount, policy);
  if (sinceLastFailure >= required) return { allowed: true };

  return { allowed: false, retryAfterSeconds: Math.ceil(required - sinceLastFailure) };
}

/** Fold a new failure into the stored state, expiring counts outside the window. */
export function recordFailure(
  state: LockoutState,
  now: Date = new Date(),
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutState {
  const withinWindow =
    state.lastFailureAt !== null &&
    (now.getTime() - state.lastFailureAt.getTime()) / 1000 < policy.windowSeconds;
  return {
    failureCount: withinWindow ? state.failureCount + 1 : 1,
    lastFailureAt: now,
  };
}

export const CLEARED_LOCKOUT: LockoutState = Object.freeze({
  failureCount: 0,
  lastFailureAt: null,
});

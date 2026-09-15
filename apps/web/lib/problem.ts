/**
 * A failure as WOLF reports it: what went wrong, why, where things stand, what to do, and a reference.
 *
 * Its own module so the session and device-key code, which is built and tested without the Next app,
 * can describe failures in the same shape the API and the UI use.
 */
export interface WolfProblem {
  code: string;
  problem: string;
  cause: string;
  currentState: string;
  recommendedAction: string;
  referenceId: string;
  httpStatus: number;
  /** Machine-readable, non-secret facts the client needs to react (risk level, retry-after). */
  context?: Record<string, string | number | boolean>;
}

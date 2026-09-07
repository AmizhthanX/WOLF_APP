/**
 * WOLF never surfaces a bare "Something went wrong". Every failure carries a problem
 * statement, a cause, the current state, a recommended action, and a reference id that
 * ties the user-visible message to structured logs.
 */
import { randomBytes } from 'node:crypto';

/** Subsystem shorthand used in reference ids, e.g. WOLF-RTC-8F2C. */
export const ERROR_AREAS = [
  'AUTH',
  'API',
  'AGENT',
  'RTC',
  'NET',
  'CMD',
  'FILE',
  'TERM',
  'PWR',
  'PRIV',
  'SYNC',
  'DB',
] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];

export interface WolfProblem {
  /** Stable machine-readable code, e.g. "rtc.negotiation_failed". */
  readonly code: string;
  /** What failed, in the user's terms. */
  readonly problem: string;
  /** Why it failed. */
  readonly cause: string;
  /** What the system's state is right now (e.g. "PC reachable over LAN"). */
  readonly currentState: string;
  /** What the user should do next. */
  readonly recommendedAction: string;
  /** WOLF-<AREA>-<HEX>; also emitted in structured logs for correlation. */
  readonly referenceId: string;
  /** HTTP status when surfaced over the REST API. */
  readonly httpStatus: number;
  /**
   * Machine-readable, non-secret facts a client needs to react correctly — the risk level
   * a command was classified at, how fresh a re-authentication must be, how long to wait
   * before retrying. Never carries payload values or anything sensitive.
   */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export function newReferenceId(area: ErrorArea): string {
  return `WOLF-${area}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

export interface WolfErrorInit {
  code: string;
  problem: string;
  cause: string;
  currentState: string;
  recommendedAction: string;
  area: ErrorArea;
  httpStatus?: number;
  /** Internal detail for logs only. Never serialized to clients. */
  detail?: unknown;
  /** Non-secret facts the client needs to react. Serialized to clients. */
  context?: Record<string, string | number | boolean>;
}

/** Error type carried across every WOLF service boundary. */
export class WolfError extends Error {
  readonly code: string;
  readonly problem: string;
  override readonly cause: string;
  readonly currentState: string;
  readonly recommendedAction: string;
  readonly referenceId: string;
  readonly httpStatus: number;
  /** Never sent to clients; for structured logging only. */
  readonly detail: unknown;
  /** Sent to clients; must stay free of secrets. */
  readonly context: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(init: WolfErrorInit) {
    super(`${init.problem} (${init.code})`);
    this.name = 'WolfError';
    this.code = init.code;
    this.problem = init.problem;
    this.cause = init.cause;
    this.currentState = init.currentState;
    this.recommendedAction = init.recommendedAction;
    this.referenceId = newReferenceId(init.area);
    this.httpStatus = init.httpStatus ?? 500;
    this.detail = init.detail;
    this.context = init.context;
  }

  /** Client-safe representation. Deliberately excludes `detail`. */
  toProblem(): WolfProblem {
    return {
      code: this.code,
      problem: this.problem,
      cause: this.cause,
      currentState: this.currentState,
      recommendedAction: this.recommendedAction,
      referenceId: this.referenceId,
      httpStatus: this.httpStatus,
      ...(this.context ? { context: this.context } : {}),
    };
  }
}

export function isWolfError(value: unknown): value is WolfError {
  return value instanceof WolfError;
}

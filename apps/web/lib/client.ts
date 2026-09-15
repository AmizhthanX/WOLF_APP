'use client';

import {
  askToKeepStorage,
  browserLock,
  createDeviceKeys,
  indexedDbDeviceKeyStore,
} from '@/lib/device-key';
import type { WolfProblem } from '@/lib/problem';
import {
  refreshSession,
  signInWithDeviceKey,
  signOutSession,
  type BrokerPath,
  type SessionDeps,
  type SessionGrant,
} from '@/lib/session-refresh';

export type { WolfProblem };

/**
 * Browser API client.
 *
 * The access token is held in module memory only — never in localStorage or a readable
 * cookie — and is refreshed through the server-side broker, which owns the refresh token.
 * The practical effect is that closing the tab drops the access token, and an XSS bug can
 * only reach a credential that expires in minutes.
 *
 * Every refresh is signed with this browser's device key (`lib/device-key.ts`), which the
 * page can sign with but not read, and runs in turn with every other tab's
 * (`lib/session-refresh.ts`).
 */

/** Error carrying the structured problem the API returned. */
export class WolfApiError extends Error {
  readonly problem: WolfProblem;

  constructor(problem: WolfProblem) {
    super(problem.problem);
    this.name = 'WolfApiError';
    this.problem = problem;
  }
}

function fallbackProblem(status: number, cause: string): WolfProblem {
  return {
    code: 'network.unreachable',
    problem: 'WOLF could not reach the API.',
    cause,
    currentState: 'The request was not performed.',
    recommendedAction: 'Check your connection, then retry.',
    referenceId: `WOLF-NET-${status || 0}`,
    httpStatus: status || 0,
  };
}

const CSRF_HEADERS = { 'x-wolf-csrf': '1', 'content-type': 'application/json' } as const;

/** A broker call holds the cross-tab session lock, so it must not be able to hold it forever. */
const BROKER_TIMEOUT_MS = 15_000;

export const API_URL = (process.env.NEXT_PUBLIC_WOLF_API_URL ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);

/**
 * The realtime service, which carries signaling.
 *
 * A separate origin from the API because it is a separate deployable, and the browser has
 * to be told which one to open a socket to. Media does not go here: signaling arranges a
 * direct WebRTC connection to the PC, and the frames never touch the cloud.
 */
export const REALTIME_URL = (
  process.env.NEXT_PUBLIC_WOLF_REALTIME_URL ?? 'ws://localhost:8081'
).replace(/\/+$/, '');

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

interface TokenState {
  accessToken: string;
  expiresAt: number;
  user: SessionUser | null;
  deviceId: string | null;
}

/** Why the last refresh did not produce a token, and whether the sign-in survived it. */
export interface SessionFailure {
  readonly problem: WolfProblem | null;
  readonly signedOut: boolean;
}

let token: TokenState | null = null;
let refreshInFlight: Promise<TokenState | null> | null = null;
let lastFailure: SessionFailure | null = null;
let deps: SessionDeps | null = null;

/** Refresh a little early so a request never leaves with a token about to expire. */
const REFRESH_MARGIN_MS = 30_000;

/** Built on first use: this module is also evaluated during server rendering, where none of it exists. */
function session(): SessionDeps {
  deps ??= {
    transport: {
      async post(path: BrokerPath, body?: unknown) {
        const response = await fetch(path, {
          method: 'POST',
          headers: CSRF_HEADERS,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
          cache: 'no-store',
        });
        return {
          status: response.status,
          payload: response.status === 204 ? null : await response.json().catch(() => null),
        };
      },
    },
    keys: createDeviceKeys(indexedDbDeviceKeyStore(), browserLock('wolf-device-key')),
    lock: browserLock('wolf-session'),
  };
  return deps;
}

function adoptGrant(grant: SessionGrant): TokenState {
  token = {
    accessToken: grant.accessToken,
    expiresAt: new Date(grant.accessTokenExpiresAt).getTime(),
    user: grant.user,
    deviceId: grant.device?.id ?? null,
  };
  lastFailure = null;
  return token;
}

export function currentUser(): SessionUser | null {
  return token?.user ?? null;
}

export function forgetSession(): void {
  token = null;
}

/** The last refresh failure, if the last refresh failed. */
export function sessionFailure(): SessionFailure | null {
  return lastFailure;
}

/** The reason the sign-in ended, once: the sign-in page shows it and it is not shown again. */
export function takeSignedOutProblem(): WolfProblem | null {
  if (!lastFailure?.signedOut || !lastFailure.problem) return null;
  const { problem } = lastFailure;
  lastFailure = { problem: null, signedOut: true };
  return problem;
}

/**
 * Adopt an access token minted outside the refresh flow.
 *
 * Re-authentication returns a token whose `auth_time` is fresh; without adopting it here,
 * later calls would keep presenting the older token and high-risk actions would still be
 * refused despite the operator having just entered their password.
 */
export function adoptAccessToken(accessToken: string, expiresAt: string): void {
  token = {
    accessToken,
    expiresAt: new Date(expiresAt).getTime(),
    user: token?.user ?? null,
    deviceId: token?.deviceId ?? null,
  };
}

async function refreshToken(): Promise<TokenState | null> {
  const outcome = await refreshSession(session());
  if (outcome.kind === 'refreshed') return adoptGrant(outcome.grant);

  token = null;
  lastFailure = { problem: outcome.problem, signedOut: outcome.kind === 'signed-out' };
  return null;
}

/** One refresh for every caller in this tab; other tabs wait their turn on the shared lock. */
function sharedRefresh(): Promise<TokenState | null> {
  refreshInFlight ??= refreshToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Get a usable access token, refreshing if needed. Concurrent callers share one refresh. */
export async function ensureToken(): Promise<TokenState | null> {
  if (token && token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token;
  return sharedRefresh();
}

export async function signIn(input: {
  email: string;
  password: string;
  deviceName: string;
}): Promise<SessionUser> {
  const outcome = await signInWithDeviceKey(session(), input);
  if (outcome.kind === 'refused') throw new WolfApiError(outcome.problem);

  // Ask the browser not to evict the key under storage pressure. A refusal changes nothing: a key
  // that is later evicted is found missing at the next refresh, and the sign-in ends plainly.
  void askToKeepStorage();
  return adoptGrant(outcome.grant).user!;
}

export async function signOut(): Promise<void> {
  token = null;
  lastFailure = null;
  await signOutSession(session());
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Overrides the session token, e.g. a PC-scoped token from a session grant. */
  bearer?: string;
  signal?: AbortSignal;
}

/**
 * Call the WOLF API.
 *
 * A 401 triggers exactly one refresh-and-retry. Retrying more than once would turn an
 * expired session into a request loop against the sign-in endpoint.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const bearer = options.bearer ?? (await ensureToken())?.accessToken;
  if (!bearer) {
    throw new WolfApiError(
      lastFailure?.problem ?? {
        code: 'auth.unauthorized',
        problem: 'You are not signed in.',
        cause: 'No valid WOLF session is available in this browser.',
        currentState: 'The request was not performed.',
        recommendedAction: 'Sign in to continue.',
        referenceId: 'WOLF-AUTH-NOTOKEN',
        httpStatus: 401,
      },
    );
  }

  const send = async (authorization: string): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${authorization}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });

  let response: Response;
  try {
    response = await send(bearer);
  } catch (error) {
    throw new WolfApiError(fallbackProblem(0, error instanceof Error ? error.message : 'Network error.'));
  }

  if (response.status === 401 && !options.bearer) {
    const refreshed = await sharedRefresh();
    if (refreshed) {
      response = await send(refreshed.accessToken);
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: WolfProblem })
    | null;

  if (!response.ok) {
    throw new WolfApiError(
      payload?.error ?? fallbackProblem(response.status, `The API returned ${response.status}.`),
    );
  }

  return payload as T;
}

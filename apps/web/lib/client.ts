'use client';

/**
 * Browser API client.
 *
 * The access token is held in module memory only — never in localStorage or a readable
 * cookie — and is refreshed through the server-side broker, which owns the refresh token.
 * The practical effect is that closing the tab drops the access token, and an XSS bug can
 * only reach a credential that expires in minutes.
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

let token: TokenState | null = null;
let refreshInFlight: Promise<TokenState | null> | null = null;

/** Refresh a little early so a request never leaves with a token about to expire. */
const REFRESH_MARGIN_MS = 30_000;

export function currentUser(): SessionUser | null {
  return token?.user ?? null;
}

export function forgetSession(): void {
  token = null;
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
  const response = await fetch('/api/auth/refresh', { method: 'POST', headers: CSRF_HEADERS });
  if (!response.ok) {
    token = null;
    return null;
  }

  const payload = (await response.json()) as {
    accessToken: string;
    accessTokenExpiresAt: string;
    user: SessionUser;
    device: { id: string } | null;
  };

  token = {
    accessToken: payload.accessToken,
    expiresAt: new Date(payload.accessTokenExpiresAt).getTime(),
    user: payload.user,
    deviceId: payload.device?.id ?? null,
  };
  return token;
}

/** Get a usable access token, refreshing if needed. Concurrent callers share one refresh. */
export async function ensureToken(): Promise<TokenState | null> {
  if (token && token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token;

  refreshInFlight ??= refreshToken().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function signIn(input: {
  email: string;
  password: string;
  deviceName: string;
}): Promise<SessionUser> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: WolfProblem; accessToken?: string; accessTokenExpiresAt?: string; user?: SessionUser; device?: { id: string } }
    | null;

  if (!response.ok || !payload?.accessToken) {
    throw new WolfApiError(
      payload?.error ?? fallbackProblem(response.status, 'The API rejected the sign-in.'),
    );
  }

  token = {
    accessToken: payload.accessToken,
    expiresAt: new Date(payload.accessTokenExpiresAt!).getTime(),
    user: payload.user!,
    deviceId: payload.device?.id ?? null,
  };
  return payload.user!;
}

export async function signOut(): Promise<void> {
  token = null;
  await fetch('/api/auth/logout', { method: 'POST', headers: CSRF_HEADERS }).catch(() => undefined);
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
    throw new WolfApiError({
      code: 'auth.unauthorized',
      problem: 'You are not signed in.',
      cause: 'No valid WOLF session is available in this browser.',
      currentState: 'The request was not performed.',
      recommendedAction: 'Sign in to continue.',
      referenceId: 'WOLF-AUTH-NOTOKEN',
      httpStatus: 401,
    });
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
    const refreshed = await refreshToken();
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

import type { RefreshBinding } from '@wolf/protocol/device-proof';
import type { DeviceKeys, Lock } from './device-key.js';
import type { WolfProblem } from './problem.js';

/**
 * Signing in, refreshing and signing out from the page, with this browser's device key.
 *
 * Every step that touches the refresh cookie runs under one lock shared by all tabs of the origin. The
 * API rotates the refresh token on every use and treats a token presented twice as stolen, so two tabs
 * must never refresh from the same cookie at once; under the lock each refreshes in turn, each from the
 * token the last one left.
 *
 * Nothing here imports the browser's storage or network directly — both are handed in — so the same
 * code runs under test against the real broker and the real API.
 */

export type BrokerPath = '/api/auth/login' | '/api/auth/refresh/binding' | '/api/auth/refresh' | '/api/auth/logout';

export interface BrokerTransport {
  /** POST to one of the dashboard's own auth routes, with its CSRF header. Throws only when nothing came back. */
  post(path: BrokerPath, body?: unknown): Promise<{ readonly status: number; readonly payload: unknown }>;
}

export interface SessionGrant {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly device: { readonly id: string } | null;
}

export interface SessionDeps {
  readonly transport: BrokerTransport;
  readonly keys: DeviceKeys;
  /** Held for the whole of a sign-in, refresh or sign-out. Not the lock `keys` uses internally. */
  readonly lock: Lock;
}

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly grant: SessionGrant }
  /** The sign-in is over: there was none, the API refused it, or this browser no longer holds its key. */
  | { readonly kind: 'signed-out'; readonly problem: WolfProblem | null }
  /** No new token, but the sign-in is intact: a wrong clock, an unreachable API, storage that would not open. */
  | { readonly kind: 'failed'; readonly problem: WolfProblem };

export type SignInOutcome =
  | { readonly kind: 'signed-in'; readonly grant: SessionGrant }
  | { readonly kind: 'refused'; readonly problem: WolfProblem };

export const DEVICE_KEY_LOST: WolfProblem = {
  code: 'auth.device_key_lost',
  problem: 'This browser no longer holds the device key its sign-in was bound to.',
  cause:
    "The key is not in this browser's storage: site data was cleared, the browser removed storage it had not used recently, or the sign-in was made before the dashboard registered device keys.",
  currentState: 'That sign-in has been ended, so nobody can renew it without the key.',
  recommendedAction: 'Sign in again. This browser will be registered as a new device with a new key.',
  referenceId: 'WOLF-AUTH-KEYLOST',
  httpStatus: 401,
};

const SUPERSEDED_TWICE: WolfProblem = {
  code: 'auth.refresh_superseded',
  problem: 'The session kept being refreshed by another tab.',
  cause: 'Twice in a row the refresh token was rotated between asking for it and using it.',
  currentState: 'Your sign-in is unchanged. Nothing was revoked.',
  recommendedAction: 'Retry. If it repeats, close other WOLF tabs and reload this one.',
  referenceId: 'WOLF-AUTH-SUPERSEDED',
  httpStatus: 409,
};

function unexpected(status: number, what: string, currentState: string): WolfProblem {
  return {
    code: 'network.unexpected',
    problem: `${what} did not complete.`,
    cause: status ? `The dashboard answered ${status} with no explanation.` : 'The dashboard could not be reached.',
    currentState,
    recommendedAction: 'Check your connection, then retry.',
    referenceId: `WOLF-NET-${status || 0}`,
    httpStatus: status,
  };
}

function problemIn(payload: unknown): WolfProblem | null {
  const error = (payload as { error?: Partial<WolfProblem> } | null)?.error;
  return error && typeof error.referenceId === 'string' && typeof error.problem === 'string' ? (error as WolfProblem) : null;
}

/** A thrown device-key or network failure as a problem, with the current state for where it happened. */
function problemFrom(error: unknown, what: string, currentState: string): WolfProblem {
  const carried = (error as { problem?: WolfProblem } | null)?.problem;
  if (carried && typeof carried.referenceId === 'string') return { ...carried, currentState };
  return {
    ...unexpected(0, what, currentState),
    cause: error instanceof Error ? error.message : 'The request did not complete.',
  };
}

function isGrant(payload: unknown): payload is SessionGrant {
  const grant = payload as Partial<SessionGrant> | null;
  return Boolean(grant && typeof grant.accessToken === 'string' && typeof grant.accessTokenExpiresAt === 'string' && grant.user);
}

function isBinding(payload: unknown): payload is RefreshBinding {
  const binding = payload as Partial<RefreshBinding> | null;
  return Boolean(
    binding &&
      typeof binding.deviceId === 'string' &&
      typeof binding.binding === 'string' &&
      (binding.publicKey === null || typeof binding.publicKey === 'string'),
  );
}

const INTACT = 'Your sign-in is unchanged.';

async function refreshOnce(deps: SessionDeps): Promise<RefreshOutcome | 'superseded'> {
  const { transport, keys } = deps;
  try {
    const asked = await transport.post('/api/auth/refresh/binding');
    if (asked.status === 401) {
      const problem = problemIn(asked.payload);
      // No cookie at all is the ordinary signed-out state, not something to report.
      return { kind: 'signed-out', problem: problem?.referenceId === 'WOLF-AUTH-NOSESSION' ? null : problem };
    }
    if (asked.status !== 200 || !isBinding(asked.payload)) {
      return { kind: 'failed', problem: problemIn(asked.payload) ?? unexpected(asked.status, 'Restoring your session', INTACT) };
    }
    const binding = asked.payload;

    // Is the key this sign-in registered still here? If not, no refresh can be proven. Sending one
    // unsigned would make the API revoke the sign-in as stolen and log a security event for what is
    // really lost storage — so end it plainly instead, and say why.
    const key = await keys.load();
    if (!key || binding.publicKey === null || key.publicKeySpki !== binding.publicKey) {
      await transport.post('/api/auth/logout', { reason: 'device-key-lost' }).catch(() => undefined);
      return { kind: 'signed-out', problem: DEVICE_KEY_LOST };
    }

    const proof = await keys.sign(key, binding.deviceId, binding.binding);
    const refreshed = await transport.post('/api/auth/refresh', { binding: binding.binding, proof });

    if (refreshed.status === 200 && isGrant(refreshed.payload)) {
      if (key.deviceId !== binding.deviceId) await keys.bind(key.publicKeySpki, binding.deviceId).catch(() => undefined);
      return { kind: 'refreshed', grant: refreshed.payload };
    }

    const problem = problemIn(refreshed.payload);
    if (refreshed.status === 409 && problem?.code === 'auth.refresh_superseded') return 'superseded';
    if (refreshed.status === 401) return { kind: 'signed-out', problem };
    return { kind: 'failed', problem: problem ?? unexpected(refreshed.status, 'Restoring your session', INTACT) };
  } catch (error) {
    return { kind: 'failed', problem: problemFrom(error, 'Restoring your session', INTACT) };
  }
}

/** Refresh once for this tab, in turn with every other tab. A token rotated underneath it is retried once. */
export function refreshSession(deps: SessionDeps): Promise<RefreshOutcome> {
  return deps.lock(async () => {
    const first = await refreshOnce(deps);
    if (first !== 'superseded') return first;
    const second = await refreshOnce(deps);
    return second === 'superseded' ? { kind: 'failed', problem: SUPERSEDED_TWICE } : second;
  });
}

/**
 * Sign in with this browser's key, making and storing one first if it has none.
 *
 * A browser that cannot make or keep a key is refused before the password leaves the page: a sign-in
 * whose refreshes nothing could prove is not one the dashboard creates.
 */
export function signInWithDeviceKey(
  deps: SessionDeps,
  credentials: { readonly email: string; readonly password: string; readonly deviceName: string },
): Promise<SignInOutcome> {
  return deps.lock(async () => {
    const notSignedIn = 'You are not signed in. Nothing was sent to WOLF.';
    let key;
    try {
      key = await deps.keys.ensure();
    } catch (error) {
      return { kind: 'refused', problem: problemFrom(error, 'Sign-in', notSignedIn) };
    }

    let response;
    try {
      response = await deps.transport.post('/api/auth/login', {
        ...credentials,
        publicKey: key.publicKeySpki,
        // The same key signing in again keeps its device; the API makes a new one if the key differs.
        ...(key.deviceId ? { deviceId: key.deviceId } : {}),
      });
    } catch (error) {
      return { kind: 'refused', problem: problemFrom(error, 'Sign-in', 'You are not signed in.') };
    }

    if (response.status !== 200 || !isGrant(response.payload)) {
      return {
        kind: 'refused',
        problem: problemIn(response.payload) ?? unexpected(response.status, 'Sign-in', 'You are not signed in.'),
      };
    }

    const deviceId = response.payload.device?.id;
    if (deviceId) await deps.keys.bind(key.publicKeySpki, deviceId).catch(() => undefined);
    return { kind: 'signed-in', grant: response.payload };
  });
}

/** Sign out, in turn with any refresh in progress so it cannot write the cookie back afterwards. */
export function signOutSession(deps: SessionDeps): Promise<void> {
  return deps.lock(async () => {
    await deps.transport.post('/api/auth/logout', { reason: 'signed-out' }).catch(() => undefined);
  });
}

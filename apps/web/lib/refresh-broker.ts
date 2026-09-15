import {
  brokeredRefreshRequest,
  hasP256SpkiShape,
  refreshTokenBinding,
  signOutReason,
  type RefreshBinding,
  type RefreshProof,
} from '@wolf/protocol';
import type { WolfProblem } from './problem.js';

/**
 * The dashboard's session broker, without Next.
 *
 * The refresh token lives in an httpOnly cookie the page cannot read, so sign-in, refresh and sign-out
 * go through the dashboard's own server. The route handlers in `app/api/auth` check the CSRF header and
 * read and write the cookies; every decision in between is here, where it runs under test against the
 * real API.
 *
 * A browser proves its refreshes with a device key the page can sign with but not read. It cannot sign
 * over a token it never sees, so the broker hands it the token's binding — a labelled SHA-256 the API
 * recomputes — and forwards the signature with the token. The page holds a hash; never the token.
 */

export interface BrokerSession {
  readonly refreshToken: string;
  readonly deviceId: string;
  /** The public key registered at this sign-in; null for a sign-in made before the dashboard registered keys. */
  readonly devicePublicKey: string | null;
}

export type SessionChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'store';
      readonly refreshToken: string;
      readonly refreshExpiresAt: string;
      readonly deviceId: string;
      readonly devicePublicKey: string | null;
    };

export interface BrokerResult {
  readonly status: number;
  /** What the page receives. Never a refresh token. */
  readonly body: unknown;
  readonly session: SessionChange;
}

export interface BrokerOptions {
  readonly apiBaseUrl: string;
  readonly fetch?: typeof fetch;
}

const KEEP: SessionChange = { kind: 'keep' };
const CLEAR: SessionChange = { kind: 'clear' };

function refuse(status: number, problem: Omit<WolfProblem, 'httpStatus'>, session: SessionChange = KEEP): BrokerResult {
  return { status, body: { error: { ...problem, httpStatus: status } }, session };
}

const NOT_SIGNED_IN: Omit<WolfProblem, 'httpStatus'> = {
  code: 'auth.unauthorized',
  problem: 'You are not signed in.',
  cause: 'No WOLF session cookie was present.',
  currentState: 'The request was not performed.',
  recommendedAction: 'Sign in to continue.',
  referenceId: 'WOLF-AUTH-NOSESSION',
};

function unreachable(error: unknown, currentState: string): BrokerResult {
  return refuse(502, {
    code: 'network.unreachable',
    problem: 'The dashboard could not reach the WOLF API.',
    cause: error instanceof Error ? error.message : 'The request to the API failed.',
    currentState,
    recommendedAction: 'Check that the API is running and reachable, then retry.',
    referenceId: 'WOLF-AUTH-UPSTREAM',
  });
}

async function post(options: BrokerOptions, path: string, body: unknown): Promise<Response> {
  return (options.fetch ?? fetch)(`${options.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
}

/** What the page may see of a grant: everything except the refresh token. */
function pageGrant(payload: Record<string, unknown>) {
  return {
    accessToken: payload['accessToken'],
    accessTokenExpiresAt: payload['accessTokenExpiresAt'],
    user: payload['user'],
    device: payload['device'],
  };
}

function storeGrant(payload: Record<string, unknown>, fallbackDeviceId: string, devicePublicKey: string | null): SessionChange {
  const device = payload['device'] as { id?: string } | undefined;
  return {
    kind: 'store',
    refreshToken: String(payload['refreshToken']),
    refreshExpiresAt: String(payload['refreshTokenExpiresAt']),
    deviceId: String(device?.id ?? fallbackDeviceId),
    devicePublicKey,
  };
}

/** Compare two strings without stopping at the first difference. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * Sign in.
 *
 * Refused here, before the API is asked, without a device key: the dashboard never creates a device
 * whose refreshes nothing proves. The API parses the key properly; this is the shape check that keeps
 * a keyless sign-in from being made through the dashboard at all.
 */
export async function brokerLogin(body: unknown, platform: string | null, options: BrokerOptions): Promise<BrokerResult> {
  const { email, password, deviceName, deviceId, publicKey } = (body ?? {}) as Record<string, unknown>;

  if (typeof publicKey !== 'string' || !hasP256SpkiShape(publicKey)) {
    return refuse(400, {
      code: 'auth.device_key_required',
      problem: 'The sign-in was refused before it reached WOLF.',
      cause: 'The dashboard signs in only with a device key made by this browser, and the request carried none.',
      currentState: 'You are not signed in. No device was created.',
      recommendedAction: 'Reload the dashboard and sign in again.',
      referenceId: 'WOLF-AUTH-WEBKEY',
    });
  }

  let upstream: Response;
  try {
    upstream = await post(options, '/api/v1/auth/login', {
      email,
      password,
      device: {
        ...(typeof deviceId === 'string' && deviceId.length === 26 ? { id: deviceId } : {}),
        kind: 'web',
        name: typeof deviceName === 'string' && deviceName.trim() ? deviceName : 'Web browser',
        platform,
        publicKey,
      },
    });
  } catch (error) {
    return unreachable(error, 'You are not signed in.');
  }

  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  if (!upstream.ok || !payload) {
    return { status: upstream.status, body: payload ?? { error: { problem: 'Sign-in failed.' } }, session: KEEP };
  }

  return { status: 200, body: pageGrant(payload), session: storeGrant(payload, '', publicKey) };
}

/**
 * What the page signs for its next refresh: the device, the binding of the token in the cookie, and the
 * key this sign-in registered.
 */
export async function brokerRefreshBinding(session: BrokerSession | null): Promise<BrokerResult> {
  if (!session) return refuse(401, NOT_SIGNED_IN);
  const binding: RefreshBinding = {
    deviceId: session.deviceId,
    binding: await refreshTokenBinding(session.refreshToken),
    publicKey: session.devicePublicKey,
  };
  return { status: 200, body: binding, session: KEEP };
}

/**
 * Exchange the cookie's refresh token for a new access token, with the page's proof.
 *
 * The API rotates the token on every use, so the new one goes straight back into the cookie.
 *
 * A request with no body is forwarded unsigned, and the API decides: a sign-in that registered no key
 * refreshes, and one that did is revoked as a copied token — which is what a stolen cookie replayed at
 * this route is. The broker never supplies a proof of its own.
 *
 * A signature for a binding that is no longer the cookie's means another tab rotated the token after
 * this page asked. That is a race, not a theft, so it is answered with a retry and nothing is sent.
 *
 * Only the API refusing the sign-in (401) clears the cookie. A wrong device clock, a rate limit or an
 * API that is down leaves it alone: nothing was revoked, and the next attempt can still succeed.
 */
export async function brokerRefresh(session: BrokerSession | null, body: unknown, options: BrokerOptions): Promise<BrokerResult> {
  if (!session) return refuse(401, NOT_SIGNED_IN);

  let proof: RefreshProof | null = null;
  const unsigned = body === null || body === undefined || (typeof body === 'object' && Object.keys(body).length === 0);
  if (!unsigned) {
    const parsed = brokeredRefreshRequest.safeParse(body);
    if (!parsed.success) {
      return refuse(400, {
        code: 'validation.failed',
        problem: 'The refresh request could not be accepted.',
        cause: 'It did not carry a token binding and a device signature in the expected form.',
        currentState: 'Your sign-in is unchanged. Nothing was sent to WOLF.',
        recommendedAction: 'Reload the dashboard and try again.',
        referenceId: 'WOLF-AUTH-PROOFBODY',
      });
    }
    if (!sameString(parsed.data.binding, await refreshTokenBinding(session.refreshToken))) {
      return refuse(409, {
        code: 'auth.refresh_superseded',
        problem: 'The session was refreshed by another tab first.',
        cause: 'The device signature was made for a refresh token that has since been rotated.',
        currentState: 'Your sign-in is unchanged. Nothing was sent to WOLF and nothing was revoked.',
        recommendedAction: 'Retry; the dashboard does this once on its own.',
        referenceId: 'WOLF-AUTH-SUPERSEDED',
      });
    }
    proof = parsed.data.proof;
  }

  let upstream: Response;
  try {
    upstream = await post(options, '/api/v1/auth/refresh', {
      refreshToken: session.refreshToken,
      deviceId: session.deviceId,
      ...(proof ? { proof } : {}),
    });
  } catch (error) {
    return unreachable(error, 'Your sign-in is unchanged.');
  }

  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  if (upstream.ok && payload) {
    return {
      status: 200,
      body: pageGrant(payload),
      session: storeGrant(payload, session.deviceId, session.devicePublicKey),
    };
  }
  if (upstream.ok) {
    // The API took the token and the answer was lost; the cookie now holds a spent token that would read as a replay.
    return refuse(502, {
      code: 'network.unreadable',
      problem: 'The refreshed session could not be read.',
      cause: 'The API accepted the refresh but its response was not readable.',
      currentState: 'The old refresh token was used up, so this sign-in has ended.',
      recommendedAction: 'Sign in again.',
      referenceId: 'WOLF-AUTH-UNREADABLE',
    }, CLEAR);
  }
  return {
    status: upstream.status,
    body: payload ?? { error: { problem: 'The session could not be refreshed.' } },
    session: upstream.status === 401 ? CLEAR : KEEP,
  };
}

/**
 * Sign out. The cookie is cleared whatever the API says: a browser that cannot reach the API must still
 * be able to end its own session locally, and the refresh token expires on its own if this call failed.
 */
export async function brokerLogout(session: BrokerSession | null, body: unknown, options: BrokerOptions): Promise<BrokerResult> {
  if (session) {
    const reason = signOutReason.safeParse((body as Record<string, unknown> | null)?.['reason']);
    await post(options, '/api/v1/auth/logout', {
      refreshToken: session.refreshToken,
      ...(reason.success ? { reason: reason.data } : {}),
    }).catch(() => undefined);
  }
  return { status: 204, body: null, session: CLEAR };
}

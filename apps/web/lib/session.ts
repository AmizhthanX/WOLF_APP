import 'server-only';
import { cookies } from 'next/headers';
import type { BrokerResult, BrokerSession } from '@/lib/refresh-broker';

/**
 * Server-side session brokering.
 *
 * The refresh token never reaches browser JavaScript. It lives in an httpOnly, SameSite
 * cookie that only these route handlers can read, so an XSS bug in the dashboard can at
 * worst steal a short-lived access token rather than durable access to every PC.
 *
 * The device id is stored the same way: the refresh endpoint requires it, and keeping the
 * pair together means a stolen access token alone cannot mint new ones.
 */

export const REFRESH_COOKIE = 'wolf_refresh';
export const DEVICE_COOKIE = 'wolf_device';
/**
 * The public key this sign-in registered. Public, but kept beside the token so the broker can tell the
 * page which key a refresh must be signed with — and the page can tell that it no longer holds it.
 */
export const DEVICE_KEY_COOKIE = 'wolf_device_key';

/**
 * Custom header every state-changing route requires.
 *
 * A cross-origin form post cannot set a custom header without a CORS preflight the API
 * will not grant, so requiring it blocks CSRF without a token round trip. SameSite=Strict
 * on the cookie is the second layer.
 */
export const CSRF_HEADER = 'x-wolf-csrf';
export const CSRF_VALUE = '1';

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function storeSession(input: {
  refreshToken: string;
  refreshExpiresAt: string;
  deviceId: string;
  devicePublicKey: string | null;
}): Promise<void> {
  const store = await cookies();
  const maxAge = Math.max(
    60,
    Math.floor((new Date(input.refreshExpiresAt).getTime() - Date.now()) / 1000),
  );

  store.set(REFRESH_COOKIE, input.refreshToken, cookieOptions(maxAge));
  store.set(DEVICE_COOKIE, input.deviceId, cookieOptions(maxAge));
  if (input.devicePublicKey) store.set(DEVICE_KEY_COOKIE, input.devicePublicKey, cookieOptions(maxAge));
  else store.delete(DEVICE_KEY_COOKIE);
}

export async function readSession(): Promise<BrokerSession | null> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  const deviceId = store.get(DEVICE_COOKIE)?.value;
  if (!refreshToken || !deviceId) return null;
  return { refreshToken, deviceId, devicePublicKey: store.get(DEVICE_KEY_COOKIE)?.value ?? null };
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(REFRESH_COOKIE);
  store.delete(DEVICE_COOKIE);
  store.delete(DEVICE_KEY_COOKIE);
}

/** Apply what the broker decided to the cookies, and answer the page. */
export async function brokerResponse(result: BrokerResult): Promise<Response> {
  if (result.session.kind === 'store') await storeSession(result.session);
  if (result.session.kind === 'clear') await clearSession();
  const headers = { 'cache-control': 'no-store' };
  return result.status === 204
    ? new Response(null, { status: 204, headers })
    : Response.json(result.body, { status: result.status, headers });
}

/** Reject a state-changing request that did not come from the dashboard itself. */
export function csrfGuard(request: Request): Response | null {
  if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
    return Response.json(
      {
        error: {
          code: 'csrf.rejected',
          problem: 'The request was rejected.',
          cause: 'It did not include the header WOLF requires on state-changing requests.',
          currentState: 'Nothing was changed.',
          recommendedAction: 'Reload the dashboard and try again.',
          referenceId: 'WOLF-API-CSRF',
          httpStatus: 403,
        },
      },
      { status: 403 },
    );
  }
  return null;
}

export const API_BASE_URL = (
  process.env.WOLF_API_URL ??
  process.env.NEXT_PUBLIC_WOLF_API_URL ??
  'http://localhost:8080'
).replace(/\/+$/, '');

import { API_BASE_URL, clearSession, csrfGuard, readSession, storeSession } from '@/lib/session';

/**
 * Exchange the stored refresh token for a new access token.
 *
 * The API rotates the refresh token on every use, so the new one is written straight back
 * into the cookie. If the API reports the token was already used — which means it was
 * copied — the session is cleared here too, rather than leaving a dead cookie behind that
 * would fail on every subsequent load.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  const session = await readSession();
  if (!session) {
    return Response.json(
      {
        error: {
          code: 'auth.unauthorized',
          problem: 'You are not signed in.',
          cause: 'No WOLF session cookie was present.',
          currentState: 'The request was not performed.',
          recommendedAction: 'Sign in to continue.',
          referenceId: 'WOLF-AUTH-NOSESSION',
          httpStatus: 401,
        },
      },
      { status: 401 },
    );
  }

  const upstream = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: session.deviceId }),
    cache: 'no-store',
  });

  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;

  if (!upstream.ok || !payload) {
    await clearSession();
    return Response.json(payload ?? { error: { problem: 'The session could not be refreshed.' } }, {
      status: upstream.status,
    });
  }

  const device = payload['device'] as { id?: string } | undefined;
  await storeSession({
    refreshToken: String(payload['refreshToken']),
    refreshExpiresAt: String(payload['refreshTokenExpiresAt']),
    deviceId: String(device?.id ?? session.deviceId),
  });

  return Response.json({
    accessToken: payload['accessToken'],
    accessTokenExpiresAt: payload['accessTokenExpiresAt'],
    user: payload['user'],
    device: payload['device'],
  });
}

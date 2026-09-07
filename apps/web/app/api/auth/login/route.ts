import { API_BASE_URL, csrfGuard, storeSession } from '@/lib/session';

/**
 * Sign in.
 *
 * The browser posts credentials here rather than to the API directly, so the refresh token
 * in the API's response can be captured into an httpOnly cookie and never handed to
 * JavaScript. Only the short-lived access token is returned to the page.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: 'validation.failed',
          problem: 'The sign-in request could not be read.',
          cause: 'The request body was not valid JSON.',
          currentState: 'You are not signed in.',
          recommendedAction: 'Reload the page and try again.',
          referenceId: 'WOLF-AUTH-BODY',
          httpStatus: 400,
        },
      },
      { status: 400 },
    );
  }

  const { email, password, deviceName, deviceId } = (body ?? {}) as Record<string, unknown>;

  const upstream = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: {
        ...(typeof deviceId === 'string' && deviceId.length === 26 ? { id: deviceId } : {}),
        kind: 'web',
        name: typeof deviceName === 'string' && deviceName.trim() ? deviceName : 'Web browser',
        platform: request.headers.get('sec-ch-ua-platform') ?? null,
      },
    }),
    cache: 'no-store',
  });

  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;

  if (!upstream.ok || !payload) {
    return Response.json(payload ?? { error: { problem: 'Sign-in failed.' } }, {
      status: upstream.status,
    });
  }

  const device = payload['device'] as { id?: string } | undefined;
  await storeSession({
    refreshToken: String(payload['refreshToken']),
    refreshExpiresAt: String(payload['refreshTokenExpiresAt']),
    deviceId: String(device?.id ?? ''),
  });

  // Deliberately omits refreshToken: the page never sees it.
  return Response.json({
    accessToken: payload['accessToken'],
    accessTokenExpiresAt: payload['accessTokenExpiresAt'],
    user: payload['user'],
    device: payload['device'],
  });
}

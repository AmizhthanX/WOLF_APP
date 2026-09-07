import { API_BASE_URL, clearSession, csrfGuard, readSession } from '@/lib/session';

/**
 * Sign out.
 *
 * The cookie is cleared whatever the API says: a browser that cannot reach the API must
 * still be able to end its own session locally, and the API-side revocation is retried by
 * nothing — the refresh token expires on its own if this call failed.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  const session = await readSession();
  if (session) {
    await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  await clearSession();
  return new Response(null, { status: 204 });
}

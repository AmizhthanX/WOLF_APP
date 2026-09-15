import { brokerLogout } from '@/lib/refresh-broker';
import { API_BASE_URL, brokerResponse, csrfGuard, readSession } from '@/lib/session';

/**
 * Sign out.
 *
 * The cookie is cleared whatever the API says: a browser that cannot reach the API must
 * still be able to end its own session locally, and the API-side revocation is retried by
 * nothing — the refresh token expires on its own if this call failed. The page may say why
 * it is signing out (`device-key-lost`), which the API keeps as audit metadata.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  const body: unknown = await request.json().catch(() => null);
  return brokerResponse(await brokerLogout(await readSession(), body, { apiBaseUrl: API_BASE_URL }));
}

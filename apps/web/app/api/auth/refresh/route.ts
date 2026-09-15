import { brokerRefresh } from '@/lib/refresh-broker';
import { API_BASE_URL, brokerResponse, csrfGuard, readSession } from '@/lib/session';

/**
 * Exchange the stored refresh token for a new access token.
 *
 * The page posts the token binding it was given by `/api/auth/refresh/binding` and its device
 * key's signature over it; the broker checks the binding is still the cookie's and forwards the
 * signature with the token. The API rotates the token on every use, so the new one is written
 * straight back into the cookie. Only a refusal by the API clears the cookie (see `brokerRefresh`).
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  // An empty or unreadable body is forwarded unsigned, and the API applies its rule to it.
  const body: unknown = await request.json().catch(() => null);
  return brokerResponse(await brokerRefresh(await readSession(), body, { apiBaseUrl: API_BASE_URL }));
}

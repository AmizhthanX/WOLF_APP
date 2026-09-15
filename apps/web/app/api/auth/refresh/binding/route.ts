import { brokerRefreshBinding } from '@/lib/refresh-broker';
import { brokerResponse, csrfGuard, readSession } from '@/lib/session';

/**
 * What the page signs for its next refresh.
 *
 * The page cannot read the refresh token, so it signs the token's binding — a labelled SHA-256 the
 * API recomputes — along with its device id. Also returned: the public key the sign-in registered,
 * so a page whose key is gone finds out before it sends a refresh it cannot prove.
 *
 * POST with the CSRF header like every other broker route: the answer is bound to the session
 * cookie, and nothing but the dashboard itself should be able to ask for it.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = csrfGuard(request);
  if (rejected) return rejected;

  return brokerResponse(await brokerRefreshBinding(await readSession()));
}

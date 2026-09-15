import { brokerLogin } from '@/lib/refresh-broker';
import { API_BASE_URL, brokerResponse, csrfGuard } from '@/lib/session';

/**
 * Sign in.
 *
 * The browser posts credentials and its device key's public half here rather than to the API
 * directly, so the refresh token in the API's response can be captured into an httpOnly cookie
 * and never handed to JavaScript. Only the short-lived access token is returned to the page. A
 * sign-in without a device key is refused before it reaches the API (see `brokerLogin`).
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

  return brokerResponse(
    await brokerLogin(body, request.headers.get('sec-ch-ua-platform'), { apiBaseUrl: API_BASE_URL }),
  );
}

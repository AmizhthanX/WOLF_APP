import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from './lib/csp';

/**
 * A fresh nonce and the Content Security Policy that names it, on every page request.
 *
 * Next.js reads the policy from the request headers while rendering and puts the nonce on the scripts it writes,
 * so its own inline bootstrap runs and nothing injected does. See `lib/csp.ts` for why this replaced a static
 * policy that stopped the dashboard from starting at all.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const policy = buildCsp({
    nonce,
    development: process.env.NODE_ENV === 'development',
    apiUrl: process.env.NEXT_PUBLIC_WOLF_API_URL,
    realtimeUrl: process.env.NEXT_PUBLIC_WOLF_REALTIME_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. The broker routes under /api answer JSON, and static assets need no policy of their own.
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

/**
 * The dashboard's Content Security Policy, built once per request.
 *
 * Next.js starts every page with small inline scripts — the React Server Components payload and the
 * hydration bootstrap. A policy of `script-src 'self'` blocks them, and the page never comes to life: it stays
 * on whatever the server rendered, which for this dashboard is "Restoring your session…". That is what
 * happened, found the first time the owner opened the dashboard in a real browser.
 *
 * The fix is not `'unsafe-inline'`, which would let any injected script run too. It is a **nonce**: a fresh
 * random value per request, put in the policy and on the scripts Next.js writes itself, so only those run.
 * `'strict-dynamic'` lets the scripts they load run as well, and nothing else.
 *
 * `'unsafe-eval'` only in development, where React uses `eval` to rebuild server error stacks in the browser.
 * Styles keep `'unsafe-inline'`: components use `style` attributes, which a nonce cannot cover, and a style
 * cannot run code.
 */
export interface CspInput {
  readonly nonce: string;
  readonly development: boolean;
  /** Where the browser calls the API. The same default `lib/client.ts` uses. */
  readonly apiUrl?: string;
  /** Where the browser opens the signaling socket. The same default `lib/client.ts` uses. */
  readonly realtimeUrl?: string;
}

export const DEFAULT_API_URL = 'http://localhost:8080';
export const DEFAULT_REALTIME_URL = 'ws://localhost:8081';

/** An origin a policy can name: scheme, host and port, nothing after. Empty for anything that is not a URL. */
function origin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export function buildCsp(input: CspInput): string {
  const connect = [
    "'self'",
    origin(input.apiUrl || DEFAULT_API_URL),
    origin(input.realtimeUrl || DEFAULT_REALTIME_URL),
  ].filter(Boolean);

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${input.development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // The API, and the signaling socket. WebRTC media is not governed by connect-src; the socket is.
    `connect-src ${[...new Set(connect)].join(' ')}`,
    // The remote desktop picture is a <video> fed by a MediaStream, which is a blob-like source.
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

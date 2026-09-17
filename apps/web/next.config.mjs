import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The container image (infrastructure/docker/web.Dockerfile) runs Next's standalone server. Traced from the
  // repository root, because the dashboard imports the workspace packages beside it. `next dev` and `next start`
  // are unchanged.
  ...(process.env.WOLF_WEB_STANDALONE === '1'
    ? {
        output: 'standalone',
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      }
    : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The Content Security Policy is not here: it carries a fresh nonce per request, so it is set in
          // proxy.ts (see lib/csp.ts). A static one here would block Next's own inline scripts.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

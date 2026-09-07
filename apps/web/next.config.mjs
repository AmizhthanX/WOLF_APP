/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The dashboard renders no third-party content and loads no remote scripts, so
          // the policy can stay tight. 'unsafe-inline' for styles is required by Next's
          // injected critical CSS; scripts are not given the same latitude.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              // The realtime origin carries signaling over a WebSocket. WebRTC media is
              // not subject to connect-src, but the signaling socket is, and omitting it
              // produces a stream that fails with a console error and no product-level
              // explanation.
              [
                "connect-src 'self'",
                process.env.NEXT_PUBLIC_WOLF_API_URL ?? '',
                process.env.NEXT_PUBLIC_WOLF_REALTIME_URL ?? 'ws://localhost:8081',
              ]
                .filter(Boolean)
                .join(' '),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
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

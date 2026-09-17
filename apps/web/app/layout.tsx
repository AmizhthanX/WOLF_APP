import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'WOLF',
  description: 'Remote PC control and management',
  applicationName: 'WOLF',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'WOLF', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  // The dashboard is a private control surface; it has no business in a search index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0b0d10',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Rendered per request, never at build time: the nonce in the security policy is new for every request, and a
  // page built in advance would carry scripts without it, which the browser would refuse to run.
  await connection();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

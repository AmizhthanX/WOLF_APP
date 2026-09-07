'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { currentUser, ensureToken, signOut } from '@/lib/client';

/**
 * Shell for every authenticated page.
 *
 * It resolves a session before rendering children, so a page never briefly shows an empty
 * dashboard to someone who is not signed in. A failed refresh sends the browser to the
 * sign-in page rather than leaving a shell with nothing in it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<'checking' | 'ready'>('checking');
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void ensureToken().then((token) => {
      if (cancelled) return;
      if (!token) {
        router.replace('/login');
        return;
      }
      setEmail(currentUser()?.email ?? null);
      setState('ready');
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state === 'checking') {
    return (
      <main className="app-shell">
        <div className="content">
          <p className="muted">Restoring your session…</p>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <Link href="/" className="wordmark" style={{ color: 'var(--text)' }}>
          WOLF
        </Link>
        <div className="top-bar-spacer" />
        {email ? <span className="muted">{email}</span> : null}
        <button
          type="button"
          className="button-small"
          onClick={async () => {
            await signOut();
            router.replace('/login');
          }}
        >
          Sign out
        </button>
      </header>

      <main className="content">{children}</main>
    </div>
  );
}

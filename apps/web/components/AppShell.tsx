'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { currentUser, ensureToken, sessionFailure, signOut, type WolfProblem } from '@/lib/client';
import { listNotifications } from '@/lib/wolf';
import { Problem } from '@/components/ui';

/** How often the unread count is checked. Alerts are evaluated once a minute; this need not be faster. */
const INBOX_REFRESH_MS = 30_000;

/**
 * Shell for every authenticated page.
 *
 * It resolves a session before rendering children, so a page never briefly shows an empty
 * dashboard to someone who is not signed in. A refresh that ended the sign-in sends the
 * browser to the sign-in page, which says why. A refresh that failed with the sign-in intact —
 * a wrong device clock, an unreachable API — is shown here with a retry, rather than
 * pretending the owner was signed out.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [failure, setFailure] = useState<WolfProblem | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState<string | null>(null);
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void ensureToken().then((token) => {
      if (cancelled) return;
      if (!token) {
        const last = sessionFailure();
        if (last && !last.signedOut && last.problem) {
          setFailure(last.problem);
          setState('failed');
          return;
        }
        router.replace('/login');
        return;
      }
      setEmail(currentUser()?.email ?? null);
      setState('ready');
    });

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  useEffect(() => {
    if (state !== 'ready') return;

    const check = async () => {
      try {
        setUnread((await listNotifications({ unreadOnly: true, limit: 1 })).unreadCount);
      } catch {
        // A count that cannot be read is shown as nothing rather than as zero.
        setUnread(null);
      }
    };

    void check();
    const timer = setInterval(() => void check(), INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [state]);

  if (state === 'checking') {
    return (
      <main className="app-shell">
        <div className="content">
          <p className="muted">Restoring your session…</p>
        </div>
      </main>
    );
  }

  if (state === 'failed' && failure) {
    return (
      <main className="app-shell">
        <div className="content stack">
          <Problem
            problem={failure}
            onRetry={() => {
              setState('checking');
              setAttempt((count) => count + 1);
            }}
          />
          <div className="row">
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
          </div>
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
        <Link href="/automations" className="button-small">
          Automations
        </Link>
        <Link href="/settings/configuration" className="button-small">
          Backup
        </Link>
        <Link href="/settings/webhooks" className="button-small">
          Webhooks
        </Link>
        <Link href="/alerts" className="button-small" aria-label={unread ? `Alerts, ${unread} unread` : 'Alerts'}>
          Alerts{unread ? <span className="status status-danger" style={{ marginLeft: 6 }}>{unread}</span> : null}
        </Link>
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

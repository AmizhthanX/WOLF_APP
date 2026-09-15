'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, takeSignedOutProblem, WolfApiError, type WolfProblem } from '@/lib/client';
import { Problem } from '@/components/ui';

/**
 * Sign in.
 *
 * WOLF has one owner account and no registration path, so this page offers no "create
 * account" or "forgot password" flow — both would be endpoints that do not exist. Recovery
 * is a deliberate, local action performed on the server.
 *
 * Signing in makes this browser's device key if it has none (`lib/device-key.ts`). When the
 * previous sign-in ended because that key was lost or the API refused a refresh, the reason is
 * shown here rather than a bare form.
 */
export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WolfProblem | null>(null);

  useEffect(() => {
    const ended = takeSignedOutProblem();
    if (ended) setError(ended);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);

    try {
      await signIn({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        deviceName: deviceName(),
      });
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof WolfApiError
          ? caught.problem
          : {
              code: 'unknown',
              problem: 'Sign-in failed.',
              cause: caught instanceof Error ? caught.message : 'Unknown error.',
              currentState: 'You are not signed in.',
              recommendedAction: 'Try again.',
              referenceId: 'WOLF-AUTH-0000',
              httpStatus: 500,
            },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <div className="login-card">
        <div>
          <div className="wordmark">WOLF</div>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Sign in to your PCs.
          </p>
        </div>

        <form onSubmit={onSubmit} className="stack">
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              disabled={busy}
            />
          </div>

          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </div>

          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {error ? <Problem problem={error} /> : null}
      </div>
    </main>
  );
}

/** A recognisable name for this browser in the device list. */
function deviceName(): string {
  if (typeof navigator === 'undefined') return 'Web browser';

  const agent = navigator.userAgent;
  const browser = agent.includes('Firefox')
    ? 'Firefox'
    : agent.includes('Edg/')
      ? 'Edge'
      : agent.includes('Chrome')
        ? 'Chrome'
        : agent.includes('Safari')
          ? 'Safari'
          : 'Browser';

  const platform = agent.includes('Windows')
    ? 'Windows'
    : agent.includes('Android')
      ? 'Android'
      : agent.includes('Mac')
        ? 'macOS'
        : agent.includes('Linux')
          ? 'Linux'
          : 'Unknown';

  return `${browser} on ${platform}`;
}

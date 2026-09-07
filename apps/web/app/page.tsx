'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import { createEnrollmentToken, listPcs, type Pc } from '@/lib/wolf';
import { AppShell } from '@/components/AppShell';
import { Empty, Panel, Problem, RouteBadge, SessionStateBadge, StatusBadge } from '@/components/ui';
import { relativeTime } from '@/lib/format';

/** The dashboard refreshes on a timer; presence changes matter more than a chart animation. */
const REFRESH_MS = 10_000;

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const [pcs, setPcs] = useState<Pc[] | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await listPcs();
      setPcs(result.pcs);
      setError(null);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = (pcs ?? []).filter((pc) =>
    search.trim() === ''
      ? true
      : `${pc.name} ${pc.hostname ?? ''} ${pc.tags.join(' ')}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
  );

  const online = filtered.filter((pc) => pc.status === 'online').length;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>PCs</h1>
          <p className="muted" style={{ margin: '2px 0 0' }}>
            {pcs === null
              ? 'Loading…'
              : `${online} of ${filtered.length} online`}
          </p>
        </div>

        <div className="row">
          <input
            type="search"
            placeholder="Search PCs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 220 }}
            aria-label="Search PCs"
          />
          <AddPcButton />
        </div>
      </div>

      {error ? <Problem problem={error} onRetry={() => void load()} /> : null}

      {pcs !== null && filtered.length === 0 ? (
        <Panel title="No PCs yet">
          <Empty>
            {pcs.length === 0
              ? 'Install the WOLF agent on a Windows PC and enrol it with a token to see it here.'
              : 'No PC matches that search.'}
          </Empty>
        </Panel>
      ) : null}

      <div className="grid-cards">
        {filtered.map((pc) => (
          <PcCard key={pc.id} pc={pc} />
        ))}
      </div>
    </div>
  );
}

function PcCard({ pc }: { pc: Pc }) {
  return (
    <Link href={`/pcs/${pc.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{pc.name}</div>
          <div className="muted mono">{pc.hostname ?? 'hostname unknown'}</div>
        </div>
        <StatusBadge status={pc.status} />
      </div>

      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <RouteBadge route={pc.connectionRoute} />
        <SessionStateBadge state={pc.windowsSessionState} />
        {!pc.remoteAccessEnabled ? (
          <span className="status status-danger">remote access off</span>
        ) : null}
      </div>

      <div className="secondary" style={{ fontSize: 12 }}>
        {pc.hardware?.cpuModel ?? 'CPU unknown'}
      </div>

      <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
        <span className="muted">Last seen {relativeTime(pc.lastSeenAt)}</span>
        <span className="muted">
          {pc.activeSessionCount} session{pc.activeSessionCount === 1 ? '' : 's'}
          {pc.pendingCommandCount > 0 ? ` · ${pc.pendingCommandCount} pending` : ''}
        </span>
      </div>
    </Link>
  );
}

/**
 * Enrollment.
 *
 * The token is shown exactly once — the API stores only its hash — so the UI says so
 * plainly rather than letting an operator assume they can come back for it.
 */
function AddPcButton() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await createEnrollmentToken('Dashboard');
      setToken(result.enrollmentToken);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="button-primary" onClick={() => void create()} disabled={busy}>
        {busy ? 'Creating…' : 'Add a PC'}
      </button>

      {token || error ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Enrollment token">
          <div className="dialog">
            <header className="dialog-header">
              <h2>Enrol a new PC</h2>
            </header>
            <div className="dialog-body">
              {error ? (
                <Problem problem={error} />
              ) : (
                <>
                  <p className="secondary" style={{ margin: 0 }}>
                    Run the WOLF installer on the PC and enter this token. It can be used once and
                    expires in an hour.
                  </p>
                  <code
                    style={{
                      display: 'block',
                      padding: 'var(--space-3)',
                      background: 'var(--surface-0)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius)',
                      fontSize: 16,
                      letterSpacing: '0.08em',
                      textAlign: 'center',
                    }}
                  >
                    {token}
                  </code>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    WOLF stores only a hash of this token, so it cannot be shown again. Generate a
                    new one if you lose it.
                  </p>
                </>
              )}
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                onClick={() => {
                  setToken(null);
                  setError(null);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

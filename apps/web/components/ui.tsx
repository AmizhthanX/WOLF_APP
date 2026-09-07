'use client';

import type { ReactNode } from 'react';
import type { WolfProblem } from '@/lib/client';
import { severityFor, UNAVAILABLE } from '@/lib/format';

/**
 * Structured failure display.
 *
 * WOLF never shows a bare "something went wrong". Every failure states what happened, why,
 * what the current state is, what to do next, and the reference id that ties the message
 * to the service logs.
 */
export function Problem({ problem, onRetry }: { problem: WolfProblem; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <div className="problem-title">{problem.problem}</div>

      <div className="problem-row">
        <span className="problem-label">Cause</span>
        <span>{problem.cause}</span>
      </div>
      <div className="problem-row">
        <span className="problem-label">Current state</span>
        <span>{problem.currentState}</span>
      </div>
      <div className="problem-row">
        <span className="problem-label">Suggested action</span>
        <span>{problem.recommendedAction}</span>
      </div>
      <div className="problem-row">
        <span className="problem-label">Reference</span>
        <span className="problem-reference">{problem.referenceId}</span>
      </div>

      {onRetry ? (
        <div className="row" style={{ marginTop: 'var(--space-2)' }}>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function StatusBadge({
  status,
  label,
}: {
  status: 'online' | 'offline' | 'unreachable' | 'sleeping';
  label?: string;
}) {
  const className =
    status === 'online'
      ? 'status status-online'
      : status === 'unreachable'
        ? 'status status-danger'
        : status === 'sleeping'
          ? 'status status-info'
          : 'status status-offline';

  return (
    <span className={className}>
      <span className="status-dot" />
      {label ?? status}
    </span>
  );
}

/** The route a session is actually taking. LAN is preferred; relay is the fallback. */
export function RouteBadge({ route }: { route: 'lan' | 'p2p' | 'relay' | null }) {
  if (!route) return <span className="unavailable">no route</span>;
  return <span className="route-badge">{route}</span>;
}

export function SessionStateBadge({ state }: { state: string }) {
  const tone =
    state === 'desktop'
      ? 'status status-online'
      : state === 'locked' || state === 'login'
        ? 'status status-warn'
        : state === 'restarting'
          ? 'status status-info'
          : 'status status-offline';

  return <span className={tone}>{state}</span>;
}

export function Metric({
  label,
  value,
  sub,
  usagePercent,
}: {
  label: string;
  value: string;
  sub?: string;
  usagePercent?: number | null;
}) {
  const severity = severityFor(usagePercent);
  const unavailable = value === UNAVAILABLE;

  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={unavailable ? 'unavailable metric-value' : 'metric-value'}>{value}</div>
      {usagePercent !== null && usagePercent !== undefined ? (
        <div className="bar" style={{ marginTop: 'var(--space-2)' }}>
          <div
            className={
              severity === 'danger'
                ? 'bar-fill bar-fill-danger'
                : severity === 'warn'
                  ? 'bar-fill bar-fill-warn'
                  : 'bar-fill'
            }
            style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
          />
        </div>
      ) : null}
      {sub ? <div className="metric-sub">{sub}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  flush,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{title}</h2>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      <div className={flush ? 'panel-body panel-body-flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const RISK_COPY: Record<string, { tone: string; text: string }> = {
  low: { tone: 'status status-offline', text: 'Low risk' },
  medium: { tone: 'status status-info', text: 'Medium risk — confirmation required' },
  high: { tone: 'status status-warn', text: 'High risk — password required' },
  critical: { tone: 'status status-danger', text: 'Critical — privileged authorization required' },
};

/**
 * Risk-based confirmation.
 *
 * The dialog states the risk level the *server* assigned, and that same level is sent back
 * with the command. If the server classifies the action higher than what was shown here —
 * terminating a critical system process, say — the mismatch causes a refusal, so an
 * operator can never confirm something milder than what would actually happen.
 */
export function ConfirmDialog({
  title,
  description,
  riskLevel,
  requiresPassword,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresPassword: boolean;
  busy: boolean;
  error: WolfProblem | null;
  onCancel: () => void;
  onConfirm: (password?: string) => void;
}) {
  const risk = RISK_COPY[riskLevel] ?? RISK_COPY['medium']!;

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="dialog">
        <header className="dialog-header">
          <h2>{title}</h2>
        </header>

        <form
          className="dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            const password = requiresPassword
              ? (new FormData(event.currentTarget).get('password') as string)
              : undefined;
            onConfirm(password);
          }}
        >
          <div>{description}</div>

          <div className="risk-line">
            <span className={risk.tone}>{risk.text}</span>
          </div>

          {requiresPassword ? (
            <div>
              <label htmlFor="confirm-password">Account password</label>
              <input
                id="confirm-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
              />
            </div>
          ) : null}

          {error ? <Problem problem={error} /> : null}

          <div className="dialog-footer" style={{ margin: '0 calc(-1 * var(--space-4)) calc(-1 * var(--space-4))' }}>
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className={riskLevel === 'high' || riskLevel === 'critical' ? 'button-danger' : 'button-primary'}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

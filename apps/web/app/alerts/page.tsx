'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  listNotifications,
  listPcs,
  markAllNotificationsRead,
  markNotificationRead,
  updateAlertRule,
  type AlertCondition,
  type AlertRule,
  type AlertRuleInput,
  type AlertSeverity,
  type Pc,
  type WolfNotification,
} from '@/lib/wolf';
import { AppShell } from '@/components/AppShell';
import { Empty, Problem } from '@/components/ui';
import { relativeTime } from '@/lib/format';

const REFRESH_MS = 30_000;

/**
 * The metrics a rule can watch, in the words the history charts use.
 *
 * The server judges exactly these, computed the same way the rollup computes them, so a rule
 * never fires on a number the owner cannot find on a chart.
 */
const METRICS: readonly { value: string; label: string; unit: string; perDevice: string | null }[] = [
  { value: 'cpu.usage', label: 'CPU usage', unit: '%', perDevice: null },
  { value: 'cpu.temperature', label: 'CPU temperature', unit: '°C', perDevice: null },
  { value: 'memory.usedPercent', label: 'Memory used', unit: '%', perDevice: null },
  { value: 'gpu.usage', label: 'GPU usage', unit: '%', perDevice: 'Adapter id' },
  { value: 'gpu.temperature', label: 'GPU temperature', unit: '°C', perDevice: 'Adapter id' },
  { value: 'disk.usedPercent', label: 'Disk used', unit: '%', perDevice: 'Volume, e.g. C:' },
  { value: 'disk.activeTime', label: 'Disk active time', unit: '%', perDevice: 'Volume, e.g. C:' },
  { value: 'network.receiveRate', label: 'Network receive', unit: 'B/s', perDevice: 'Adapter id' },
  { value: 'network.sendRate', label: 'Network send', unit: 'B/s', perDevice: 'Adapter id' },
  { value: 'battery.charge', label: 'Battery charge', unit: '%', perDevice: null },
];

const SEVERITY_TONE: Record<AlertSeverity, string> = {
  info: 'status status-info',
  warning: 'status status-warn',
  critical: 'status status-danger',
};

export default function AlertsPage() {
  return (
    <AppShell>
      <Alerts />
    </AppShell>
  );
}

function Alerts() {
  const [notifications, setNotifications] = useState<WolfNotification[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [ruleLimit, setRuleLimit] = useState(0);
  const [pcs, setPcs] = useState<Pc[]>([]);
  const [error, setError] = useState<WolfProblem | null>(null);

  const load = useCallback(async () => {
    try {
      const [inbox, ruleList, pcList] = await Promise.all([listNotifications(), listAlertRules(), listPcs()]);
      setNotifications(inbox.notifications);
      setUnreadCount(inbox.unreadCount);
      setRules(ruleList.rules);
      setRuleLimit(ruleList.limit);
      setPcs(pcList.pcs);
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

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  };

  const pcName = (pcId: string | null) =>
    pcId === null ? 'Every PC' : (pcs.find((pc) => pc.id === pcId)?.name ?? 'A removed PC');

  return (
    <div className="stack">
      <div>
        <h1>Alerts</h1>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          Rules are checked once a minute. Notifications appear here only — WOLF does not send
          e-mail, push notifications or webhooks yet.
        </p>
      </div>

      {error ? <Problem problem={error} onRetry={() => void load()} /> : null}

      <section className="panel">
        <div className="panel-header">
          <strong>Inbox{unreadCount > 0 ? ` · ${unreadCount} unread` : ''}</strong>
          <button
            type="button"
            className="button-small"
            disabled={unreadCount === 0}
            onClick={() => void act(markAllNotificationsRead)}
          >
            Mark all read
          </button>
        </div>
        <div className="panel-body stack">
          {notifications === null ? <p className="muted">Loading…</p> : null}
          {notifications !== null && notifications.length === 0 ? (
            <Empty>Nothing yet. When a rule fires or recovers, it shows up here.</Empty>
          ) : null}
          {(notifications ?? []).map((entry) => (
            <article
              key={entry.id}
              className="row"
              style={{ alignItems: 'flex-start', opacity: entry.readAt ? 0.65 : 1 }}
            >
              <span className={entry.kind === 'resolved' ? 'status status-online' : SEVERITY_TONE[entry.severity]}>
                {entry.kind === 'resolved' ? 'Resolved' : entry.kind === 'automation' ? `Automation · ${entry.severity}` : entry.kind === 'webhook' ? `Webhook · ${entry.severity}` : entry.severity}
              </span>
              <div style={{ flex: 1 }}>
                <div>
                  <strong>{entry.title}</strong>
                </div>
                <div className="muted">{entry.detail}</div>
                <div className="muted">{relativeTime(entry.occurredAt)}</div>
              </div>
              {entry.readAt ? null : (
                <button
                  type="button"
                  className="button-small"
                  onClick={() => void act(() => markNotificationRead(entry.id))}
                >
                  Mark read
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <strong>Rules</strong>
          <span className="muted">
            {rules === null ? '' : `${rules.length} of ${ruleLimit}`}
          </span>
        </div>
        <div className="panel-body stack">
          {rules !== null && rules.length === 0 ? (
            <Empty>No rules. Add one below to be told when something needs attention.</Empty>
          ) : null}
          {(rules ?? []).map((rule) => (
            <div key={rule.id} className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div>
                  <strong>{rule.name}</strong>{' '}
                  <span className={SEVERITY_TONE[rule.severity]}>{rule.severity}</span>
                  {rule.enabled ? null : <span className="status status-offline" style={{ marginLeft: 6 }}>Disabled</span>}
                </div>
                <div className="muted">{summarise(rule, pcName(rule.pcId))}</div>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="button-small"
                  onClick={() => void act(() => updateAlertRule(rule.id, { enabled: !rule.enabled }))}
                >
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  className="button-small button-danger"
                  onClick={() => {
                    if (window.confirm(`Delete the rule "${rule.name}"? Notifications it already produced are kept.`)) {
                      void act(() => deleteAlertRule(rule.id));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <NewRule pcs={pcs} onCreate={(rule) => act(() => createAlertRule(rule))} />
    </div>
  );
}

function summarise(rule: AlertRule, target: string): string {
  if (rule.condition === 'pc-offline') {
    return `${target} offline for ${rule.forMinutes} min · cooldown ${rule.cooldownMinutes} min`;
  }
  const metric = METRICS.find((entry) => entry.value === rule.metric);
  const label = metric?.label ?? rule.metric ?? 'metric';
  const series = rule.seriesKey ? ` (${rule.seriesKey})` : '';
  const direction = rule.condition === 'metric-above' ? 'above' : 'below';
  return `${label}${series} on ${target} ${direction} ${rule.threshold}${metric?.unit ?? ''} for ${rule.forMinutes} min · cooldown ${rule.cooldownMinutes} min`;
}

function NewRule({ pcs, onCreate }: { pcs: Pc[]; onCreate: (rule: AlertRuleInput) => Promise<void> }) {
  const [name, setName] = useState('');
  const [pcId, setPcId] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('metric-above');
  const [metric, setMetric] = useState('cpu.usage');
  const [seriesKey, setSeriesKey] = useState('');
  const [threshold, setThreshold] = useState('90');
  const [forMinutes, setForMinutes] = useState('10');
  const [severity, setSeverity] = useState<AlertSeverity>('warning');
  const [cooldownMinutes, setCooldownMinutes] = useState('60');
  const [busy, setBusy] = useState(false);

  const isMetric = condition !== 'pc-offline';
  const selected = METRICS.find((entry) => entry.value === metric);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        pcId: pcId === '' ? null : pcId,
        condition,
        metric: isMetric ? metric : null,
        seriesKey: isMetric && seriesKey.trim() !== '' ? seriesKey.trim() : null,
        threshold: isMetric ? Number(threshold) : null,
        forMinutes: Number(forMinutes),
        severity,
        cooldownMinutes: Number(cooldownMinutes),
        enabled: true,
      });
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={(event) => void submit(event)}>
      <div className="panel-header">
        <strong>New rule</strong>
      </div>
      <div className="panel-body stack">
        <label className="stack" style={{ gap: 4 }}>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </label>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: 4 }}>
            PC
            <select value={pcId} onChange={(event) => setPcId(event.target.value)}>
              <option value="">Every PC</option>
              {pcs.map((pc) => (
                <option key={pc.id} value={pc.id}>
                  {pc.name}
                </option>
              ))}
            </select>
          </label>

          <label className="stack" style={{ gap: 4 }}>
            When
            <select value={condition} onChange={(event) => setCondition(event.target.value as AlertCondition)}>
              <option value="metric-above">A metric stays above</option>
              <option value="metric-below">A metric stays below</option>
              <option value="pc-offline">The PC is offline</option>
            </select>
          </label>

          {isMetric ? (
            <>
              <label className="stack" style={{ gap: 4 }}>
                Metric
                <select value={metric} onChange={(event) => setMetric(event.target.value)}>
                  {METRICS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack" style={{ gap: 4 }}>
                Threshold ({selected?.unit})
                <input
                  type="number"
                  step="any"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  required
                  style={{ width: 110 }}
                />
              </label>
              {selected?.perDevice ? (
                <label className="stack" style={{ gap: 4 }}>
                  Only this device (optional)
                  <input
                    value={seriesKey}
                    placeholder={selected.perDevice}
                    onChange={(event) => setSeriesKey(event.target.value)}
                    maxLength={128}
                    style={{ width: 160 }}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: 4 }}>
            For (minutes)
            <input
              type="number"
              min={1}
              max={1440}
              value={forMinutes}
              onChange={(event) => setForMinutes(event.target.value)}
              required
              style={{ width: 110 }}
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            Severity
            <select value={severity} onChange={(event) => setSeverity(event.target.value as AlertSeverity)}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            Quiet for (minutes) after notifying
            <input
              type="number"
              min={5}
              max={10080}
              value={cooldownMinutes}
              onChange={(event) => setCooldownMinutes(event.target.value)}
              required
              style={{ width: 110 }}
            />
          </label>
        </div>

        <p className="muted" style={{ margin: 0 }}>
          A rule fires only when every reading across the whole window crossed the line. If the PC
          stops reporting, the rule neither fires nor resolves until there is data again.
        </p>

        <div>
          <button type="submit" className="button button-primary" disabled={busy || name.trim() === ''}>
            Add rule
          </button>
        </div>
      </div>
    </form>
  );
}

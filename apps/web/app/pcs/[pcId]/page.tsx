'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import {
  engageKillSwitch,
  getPc,
  listAudit,
  type AuditEvent,
  type CommandView,
  type Pc,
  type TelemetrySample,
} from '@/lib/wolf';
import { usePcSession } from '@/lib/use-pc-session';
import { AppShell } from '@/components/AppShell';
import { RemoteDesktopPanel } from '@/components/RemoteDesktopPanel';
import { ServicesPanel } from '@/components/ServicesPanel';
import { AutorunPanel } from '@/components/AutorunPanel';
import {
  ConfirmDialog,
  Empty,
  Metric,
  Panel,
  Problem,
  RouteBadge,
  SessionStateBadge,
  StatusBadge,
} from '@/components/ui';
import {
  bytes,
  bytesPerSecond,
  duration,
  percent,
  relativeTime,
  timestamp,
  UNAVAILABLE,
} from '@/lib/format';

type Tab = 'overview' | 'remote' | 'processes' | 'services' | 'autoruns' | 'power' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'remote', label: 'Remote desktop' },
  { id: 'processes', label: 'Processes' },
  { id: 'services', label: 'Services' },
  { id: 'autoruns', label: 'Starts on its own' },
  { id: 'power', label: 'Power' },
  { id: 'audit', label: 'Audit log' },
];

export default function PcWorkspacePage() {
  const params = useParams<{ pcId: string }>();
  return (
    <AppShell>
      <Workspace pcId={params.pcId} />
    </AppShell>
  );
}

function Workspace({ pcId }: { pcId: string }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [pc, setPc] = useState<Pc | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySample | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);

  const session = usePcSession(pcId);

  const load = useCallback(async () => {
    try {
      const result = await getPc(pcId);
      setPc(result.pc);
      setTelemetry(result.latestTelemetry);
      setError(null);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }, [pcId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !pc) {
    return <Problem problem={error} onRetry={() => void load()} />;
  }

  if (!pc) {
    return <p className="muted">Loading…</p>;
  }

  return (
    <div className="stack">
      <div>
        <Link href="/" className="muted" style={{ fontSize: 12 }}>
          ← All PCs
        </Link>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <div className="row">
            <h1>{pc.name}</h1>
            <StatusBadge status={pc.status} />
            <RouteBadge route={pc.connectionRoute} />
            <SessionStateBadge state={pc.windowsSessionState} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            agent {pc.agentVersion ?? UNAVAILABLE} · last seen {relativeTime(pc.lastSeenAt)}
          </div>
        </div>
      </div>

      {!pc.remoteAccessEnabled ? (
        <div className="problem">
          <div className="problem-title">Remote access is disabled for this PC.</div>
          <div className="problem-row">
            <span className="problem-label">Cause</span>
            <span>The WOLF kill switch is engaged.</span>
          </div>
          <div className="problem-row">
            <span className="problem-label">Current state</span>
            <span>Commands are refused before they reach the PC.</span>
          </div>
          <div className="problem-row">
            <span className="problem-label">Suggested action</span>
            <span>
              Re-enable remote access from the WOLF Control Panel on the PC itself. For security,
              this cannot be done remotely.
            </span>
          </div>
        </div>
      ) : null}

      {session.sessionError ? <Problem problem={session.sessionError} /> : null}

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? <Overview pc={pc} telemetry={telemetry} /> : null}
      {tab === 'remote' ? <RemoteDesktopPanel pc={pc} session={session} /> : null}
      {tab === 'processes' ? <Processes session={session} /> : null}
      {tab === 'services' ? <ServicesPanel session={session} /> : null}
      {tab === 'autoruns' ? <AutorunPanel session={session} /> : null}
      {tab === 'power' ? <Power pc={pc} session={session} onChanged={() => void load()} /> : null}
      {tab === 'audit' ? <AuditLog pcId={pcId} /> : null}

      {session.pending ? (
        <ConfirmDialog
          title={session.pending.title}
          description={session.pending.description}
          riskLevel={session.pending.riskLevel}
          requiresPassword={session.pending.requiresPassword}
          busy={session.confirming}
          error={session.confirmError}
          onCancel={session.cancel}
          onConfirm={session.confirm}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Overview({ pc, telemetry }: { pc: Pc; telemetry: TelemetrySample | null }) {
  const memoryPercent =
    telemetry?.memory.totalBytes && telemetry.memory.usedBytes
      ? (telemetry.memory.usedBytes / telemetry.memory.totalBytes) * 100
      : null;

  return (
    <div className="stack">
      <Panel title="Live metrics">
        {telemetry === null ? (
          <Empty>
            {pc.status === 'online'
              ? 'No telemetry has arrived from this PC yet.'
              : 'This PC is offline, so no live metrics are available.'}
          </Empty>
        ) : (
          <>
            <div className="grid-metrics">
              <Metric
                label="CPU"
                value={percent(telemetry.cpu.usagePercent)}
                usagePercent={telemetry.cpu.usagePercent}
                sub={pc.hardware?.cpuModel ?? undefined}
              />
              <Metric
                label="Memory"
                value={percent(memoryPercent)}
                usagePercent={memoryPercent}
                sub={`${bytes(telemetry.memory.usedBytes)} of ${bytes(telemetry.memory.totalBytes)}`}
              />
              <Metric label="Uptime" value={duration(telemetry.uptimeSeconds)} />
              <Metric
                label="CPU temperature"
                value={
                  telemetry.cpu.temperatureCelsius === null
                    ? UNAVAILABLE
                    : `${telemetry.cpu.temperatureCelsius.toFixed(0)} °C`
                }
                sub={telemetry.cpu.temperatureCelsius === null ? 'no readable sensor' : undefined}
              />
              <Metric
                label="Agent CPU"
                value={percent(telemetry.agent?.cpuPercent ?? null, 1)}
                sub={`WOLF using ${bytes(telemetry.agent?.memoryBytes ?? null)}`}
              />
              <Metric
                label="Battery"
                value={
                  telemetry.battery?.present ? percent(telemetry.battery.chargePercent) : 'no battery'
                }
                usagePercent={telemetry.battery?.present ? telemetry.battery.chargePercent : null}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              Sampled {relativeTime(telemetry.sampledAt)}
            </p>
          </>
        )}
      </Panel>

      {telemetry && telemetry.disks.length > 0 ? (
        <Panel title="Storage" flush>
          <table>
            <thead>
              <tr>
                <th>Volume</th>
                <th>Label</th>
                <th className="numeric">Free</th>
                <th className="numeric">Total</th>
                <th className="numeric">Active</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {telemetry.disks.map((disk) => (
                <tr key={disk.volume}>
                  <td className="mono">{disk.volume}</td>
                  <td className="secondary">{disk.label ?? '—'}</td>
                  <td className="numeric">{bytes(disk.freeBytes)}</td>
                  <td className="numeric">{bytes(disk.totalBytes)}</td>
                  <td className="numeric">{percent(disk.activeTimePercent)}</td>
                  <td className={disk.healthStatus === 'unknown' ? 'unavailable' : undefined}>
                    {disk.healthStatus}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {telemetry && telemetry.networks.length > 0 ? (
        <Panel title="Network" flush>
          <table>
            <thead>
              <tr>
                <th>Adapter</th>
                <th>Kind</th>
                <th>State</th>
                <th className="numeric">Down</th>
                <th className="numeric">Up</th>
              </tr>
            </thead>
            <tbody>
              {telemetry.networks.map((adapter) => (
                <tr key={adapter.adapterId}>
                  <td>{adapter.name}</td>
                  <td className="secondary">{adapter.kind}</td>
                  <td>{adapter.up ? 'up' : 'down'}</td>
                  <td className="numeric">{bytesPerSecond(adapter.receiveBytesPerSecond)}</td>
                  <td className="numeric">{bytesPerSecond(adapter.sendBytesPerSecond)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <Capabilities pc={pc} />
    </div>
  );
}

/**
 * What this PC can and cannot do.
 *
 * The unavailable list is shown as prominently as the available one. A capability WOLF has
 * not implemented for this agent build is stated plainly, so nobody looks for a feature
 * that would silently do nothing.
 */
function Capabilities({ pc }: { pc: Pc }) {
  const capabilities = pc.capabilities;
  if (!capabilities) {
    return (
      <Panel title="Capabilities">
        <Empty>This PC has not reported its capabilities yet.</Empty>
      </Panel>
    );
  }

  const entries: { label: string; available: boolean; note: string }[] = [
    {
      // Reported by the agent rather than inferred from the encoder list: this PC may own
      // a hardware encoder and still be unable to stream, because nobody is signed in or
      // because the build cannot capture yet.
      label: 'Remote desktop streaming',
      available: capabilities.remoteDesktopAvailable,
      note:
        capabilities.remoteDesktopUnavailableReason === 'capture-unsupported'
          ? 'Displays and encoders are detected; the capture pipeline is not implemented yet.'
          : capabilities.remoteDesktopUnavailableReason
            ? `Not available: ${capabilities.remoteDesktopUnavailableReason.replace(/-/g, ' ')}.`
            : 'Not available on this PC.',
    },
    {
      label: 'Hardware video encoding',
      available: capabilities.hardwareVideoEncoders.length > 0,
      note: 'No hardware encoder was detected; streaming would use the CPU.',
    },
    {
      label: 'Lock and sign-in screen capture',
      available: capabilities.secureDesktopCaptureAvailable,
      note: 'Requires the WOLF privileged helper.',
    },
    {
      label: 'Audio capture',
      available: capabilities.audioCaptureAvailable,
      note: 'Arrives with the remote desktop milestone.',
    },
    {
      label: 'Privileged helper',
      available: capabilities.privilegedHelperAvailable,
      note: 'Not installed; elevated operations are refused.',
    },
    {
      label: 'Remote unlock',
      available: capabilities.remoteUnlockProvisioned,
      note: 'No unlock credential has been provisioned on this PC.',
    },
    {
      label: 'Wake-on-LAN',
      available: capabilities.wakeOnLanCapable,
      note: 'Not detected on this PC.',
    },
  ];

  return (
    <Panel title="Capabilities">
      <div className="stack">
        <div className="secondary" style={{ fontSize: 13 }}>
          {pc.hardware?.osName ?? 'Windows'} · build {capabilities.windowsBuild ?? UNAVAILABLE} ·{' '}
          {capabilities.displayCount > 0
            ? `${capabilities.displayCount} display${capabilities.displayCount === 1 ? '' : 's'}`
            : 'display count unavailable from a service session'}
        </div>

        <div className="grid-metrics">
          {entries.map((entry) => (
            <div key={entry.label} className="metric">
              <div className="metric-label">{entry.label}</div>
              <div style={{ marginTop: 6 }}>
                <span className={entry.available ? 'status status-online' : 'status status-offline'}>
                  {entry.available ? 'available' : 'unavailable'}
                </span>
              </div>
              {!entry.available ? (
                <div className="metric-sub" style={{ marginTop: 6 }}>
                  {entry.note}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div>
          <h3>Commands this agent accepts</h3>
          <div className="mono secondary" style={{ marginTop: 6 }}>
            {capabilities.supportedCommands.length === 0
              ? UNAVAILABLE
              : capabilities.supportedCommands.join(', ')}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */

interface ProcessRow {
  pid: number;
  name: string;
  cpuPercent: number | null;
  workingSetBytes: number | null;
  threadCount: number | null;
  status: string;
  protectedProcess: boolean;
}

function Processes({ session }: { session: ReturnType<typeof usePcSession> }) {
  const [rows, setRows] = useState<ProcessRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    if (!session.sessionToken) return;
    setBusy(true);
    setError(null);
    try {
      const command = await session.run({
        type: 'process.list',
        payload: { limit: 400, includeIo: false },
        title: 'List processes',
        description: 'Read the process list from this PC.',
      });
      applyResult(command);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(false);
    }
  }, [session]);

  function applyResult(command: CommandView | null) {
    if (!command) return;
    if (command.status !== 'completed') {
      setError({
        code: command.failure?.code ?? 'command.failed',
        problem: 'The process list could not be read.',
        cause: command.failure?.message ?? `The command ended as "${command.status}".`,
        currentState: 'The list below may be out of date.',
        recommendedAction: command.failure?.limitation
          ? 'This is a Windows limitation on that PC rather than a WOLF fault.'
          : 'Retry. If it keeps failing, check the agent log on the PC.',
        referenceId: `WOLF-CMD-${command.id.slice(-4)}`,
        httpStatus: 502,
      });
      return;
    }

    const result = command.result as { processes?: ProcessRow[]; truncated?: boolean } | null;
    setRows(result?.processes ?? []);
    setTruncated(Boolean(result?.truncated));
  }

  useEffect(() => {
    if (session.sessionToken) void refresh();
    // Deliberately runs once per session token rather than on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionToken]);

  async function terminate(row: ProcessRow) {
    setError(null);
    try {
      const command = await session.run({
        type: 'process.terminate',
        payload: { pid: row.pid, expectedName: row.name, force: false },
        title: `Terminate ${row.name}`,
        description: `WOLF will ask ${row.name} (PID ${row.pid}) to close, then terminate it if it does not.`,
      });
      if (command) await refresh();
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  const visible = (rows ?? []).filter((row) =>
    search.trim() === '' ? true : row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="stack">
      {error ? <Problem problem={error} onRetry={() => void refresh()} /> : null}

      <Panel
        title="Processes"
        actions={
          <>
            <input
              type="search"
              placeholder="Filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 180 }}
              aria-label="Filter processes"
            />
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              {busy ? 'Reading…' : 'Refresh'}
            </button>
          </>
        }
        flush
      >
        {rows === null ? (
          <Empty>{busy ? 'Reading the process list…' : 'No process list has been read yet.'}</Empty>
        ) : visible.length === 0 ? (
          <Empty>No process matches that filter.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="numeric">PID</th>
                  <th className="numeric">Memory</th>
                  <th className="numeric">Threads</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible
                  .slice()
                  .sort((a, b) => (b.workingSetBytes ?? 0) - (a.workingSetBytes ?? 0))
                  .map((row) => (
                    <tr key={row.pid}>
                      <td>
                        {row.name}
                        {row.protectedProcess ? (
                          <span className="status status-warn" style={{ marginLeft: 8 }}>
                            protected
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric">{row.pid}</td>
                      <td className="numeric">{bytes(row.workingSetBytes)}</td>
                      <td className="numeric">{row.threadCount ?? UNAVAILABLE}</td>
                      <td className="secondary">{row.status}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="button-danger button-small"
                          onClick={() => void terminate(row)}
                          disabled={row.protectedProcess}
                          title={
                            row.protectedProcess
                              ? 'WOLF refuses to terminate critical Windows processes.'
                              : undefined
                          }
                        >
                          Terminate
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {truncated ? (
        <div className="notice">
          The agent returned a partial list because the machine has more processes than the
          requested limit. Filter to narrow the results.
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

const POWER_ACTIONS: { action: string; label: string; description: string; danger?: boolean }[] = [
  { action: 'lock', label: 'Lock', description: 'Lock the Windows session on this PC.' },
  { action: 'sign-out', label: 'Sign out', description: 'Sign the current user out of Windows.' },
  { action: 'sleep', label: 'Sleep', description: 'Put this PC to sleep.' },
  { action: 'hibernate', label: 'Hibernate', description: 'Hibernate this PC.' },
  { action: 'restart', label: 'Restart', description: 'Restart Windows on this PC.', danger: true },
  { action: 'shutdown', label: 'Shut down', description: 'Shut this PC down.', danger: true },
];

function Power({
  pc,
  session,
  onChanged,
}: {
  pc: Pc;
  session: ReturnType<typeof usePcSession>;
  onChanged: () => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [killing, setKilling] = useState(false);

  async function runPower(action: string, label: string, description: string) {
    setError(null);
    setResult(null);
    try {
      const command = await session.run({
        type: 'power.action',
        payload: { action, delaySeconds: 0, force: false },
        title: `${label} this PC`,
        description,
      });

      if (!command) return;

      if (command.status === 'completed') {
        setResult(`${label} was accepted by Windows.`);
      } else if (command.failure?.limitation) {
        // A platform limitation is reported as exactly that, not as a WOLF failure.
        setError({
          code: command.failure.code,
          problem: `${label} is not available on this PC.`,
          cause: command.failure.message ?? 'Windows does not permit this from the agent service.',
          currentState: 'Nothing was changed on the PC.',
          recommendedAction:
            'This is a Windows limitation rather than a WOLF fault. Installing the WOLF privileged helper enables some of these actions.',
          referenceId: `WOLF-PWR-${command.id.slice(-4)}`,
          httpStatus: 501,
        });
      } else {
        setError({
          code: command.failure?.code ?? 'command.failed',
          problem: `${label} did not complete.`,
          cause: command.failure?.message ?? `The command ended as "${command.status}".`,
          currentState: 'The PC may not have changed state.',
          recommendedAction: 'Check the PC, then retry if needed.',
          referenceId: `WOLF-PWR-${command.id.slice(-4)}`,
          httpStatus: 502,
        });
      }

      onChanged();
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  return (
    <div className="stack">
      {error ? <Problem problem={error} /> : null}
      {result ? <div className="notice">{result}</div> : null}

      <Panel title="Power">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {POWER_ACTIONS.map((entry) => (
            <button
              key={entry.action}
              type="button"
              className={entry.danger ? 'button-danger' : undefined}
              onClick={() => void runPower(entry.action, entry.label, entry.description)}
              disabled={pc.status !== 'online' || !pc.remoteAccessEnabled}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {pc.status !== 'online' ? (
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
            Power actions need the PC to be online.
          </p>
        ) : null}
      </Panel>

      <Panel title="Kill switch">
        <div className="stack">
          <p className="secondary" style={{ margin: 0 }}>
            Disabling remote access ends every session and makes WOLF refuse commands for this PC.
            Re-enabling it requires signing in to the WOLF Control Panel on the PC itself, so this
            is deliberately one-way from here.
          </p>
          <div>
            <button
              type="button"
              className="button-danger"
              disabled={!pc.remoteAccessEnabled || killing}
              onClick={() => {
                setKilling(true);
                void engageKillSwitch(pc.id, 'Engaged from the dashboard')
                  .then(() => onChanged())
                  .catch((caught: unknown) => {
                    if (caught instanceof WolfApiError) setError(caught.problem);
                  })
                  .finally(() => setKilling(false));
              }}
            >
              {pc.remoteAccessEnabled ? 'Disable remote access' : 'Remote access is disabled'}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function AuditLog({ pcId }: { pcId: string }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listAudit(pcId, 100);
      setEvents(result.events);
      setError(null);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }, [pcId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      {error ? <Problem problem={error} onRetry={() => void load()} /> : null}

      <Panel
        title="Audit log"
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
        flush
      >
        {events === null ? (
          <Empty>Loading…</Empty>
        ) : events.length === 0 ? (
          <Empty>Nothing has been recorded for this PC yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Risk</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="mono secondary">{timestamp(event.occurredAt)}</td>
                    <td>{event.action}</td>
                    <td className="secondary mono">
                      {event.target
                        ? Object.entries(event.target)
                            .filter(([key]) => key !== 'kind')
                            .map(([key, value]) => `${key}=${String(value)}`)
                            .join(' ')
                        : '—'}
                    </td>
                    <td>
                      <span
                        className={
                          event.riskLevel === 'critical'
                            ? 'status status-danger'
                            : event.riskLevel === 'high'
                              ? 'status status-warn'
                              : 'status status-offline'
                        }
                      >
                        {event.riskLevel}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          event.outcome === 'success'
                            ? 'status status-online'
                            : event.outcome === 'denied'
                              ? 'status status-warn'
                              : event.outcome === 'failure'
                                ? 'status status-danger'
                                : 'status status-offline'
                        }
                      >
                        {event.outcome}
                        {event.errorCode ? ` · ${event.errorCode}` : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

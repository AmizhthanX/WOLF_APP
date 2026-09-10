'use client';

import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import type { CommandView } from '@/lib/wolf';
import type { usePcSession } from '@/lib/use-pc-session';
import { Empty, Panel, Problem } from '@/components/ui';

/**
 * Windows services on the PC.
 *
 * On the command path rather than the data channel, which is the opposite of the terminal and
 * the file browser and worth knowing when reading this. Those carry content that must never
 * reach a server. A service change carries no content — it is a name and a verb — and what
 * matters about it is the reverse: that it is classified for risk, confirmed, and written to
 * an audit record. So it goes through `session.run`, which is where that machinery lives.
 */

interface ServiceRow {
  readonly name: string;
  readonly displayName: string;
  readonly status: string;
  readonly startType: string | null;
  readonly account: string | null;
  readonly imagePath: string | null;
  readonly canStop: boolean;
  /** Which of WOLF's protections covers this service, or null when none does. */
  readonly protectedBy: string | null;
}

/**
 * Why a service is off limits, in the operator's terms.
 *
 * Shown in the list rather than only on refusal. Finding out that a service cannot be stopped
 * *after* asking is a worse experience than seeing it before, and for the ones here the answer
 * will never change.
 */
const PROTECTIONS: Record<string, string> = {
  'wolf-service': 'WOLF’s own service. Stopping it would end this session.',
  'system-critical': 'Windows needs this to run at all.',
  'network-critical': 'This is part of how the PC stays reachable.',
};

const START_TYPES = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'automatic-delayed', label: 'Automatic (delayed)' },
  { id: 'manual', label: 'Manual' },
  { id: 'disabled', label: 'Disabled' },
];

export function ServicesPanel({ session }: { session: ReturnType<typeof usePcSession> }) {
  const [rows, setRows] = useState<ServiceRow[] | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [helperAvailable, setHelperAvailable] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session.sessionToken) return;
    setBusy(true);
    setError(null);

    try {
      const command = await session.run({
        type: 'service.list',
        payload: {},
        title: 'List services',
        description: 'Read the Windows service list from this PC.',
      });

      apply(command);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(false);
    }
  }, [session]);

  function apply(command: CommandView | null) {
    if (!command) return;

    if (command.status !== 'completed') {
      setError({
        code: command.failure?.code ?? 'command.failed',
        problem: 'The service list could not be read.',
        cause: command.failure?.message ?? `The command ended as "${command.status}".`,
        currentState: 'The list below may be out of date.',
        recommendedAction: command.failure?.limitation
          ? 'This is a limitation on that PC rather than a WOLF fault.'
          : 'Retry. If it keeps failing, check the agent log on the PC.',
        referenceId: `WOLF-CMD-${command.id.slice(-4)}`,
        httpStatus: 502,
      });
      return;
    }

    const result = command.result as {
      services?: ServiceRow[];
      helperAvailable?: boolean;
      unavailableReason?: string | null;
    } | null;

    setRows(result?.services ?? []);

    // An empty list and a reason are different from an empty list. Every Windows machine has
    // services, so a caller seeing none needs to be told whether WOLF could not ask.
    setHelperAvailable(result?.helperAvailable !== false);
    setUnavailableReason(result?.unavailableReason ?? null);
  }

  useEffect(() => {
    if (session.sessionToken) void refresh();
    // Once per session token rather than on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionToken]);

  async function control(row: ServiceRow, action: 'start' | 'stop' | 'restart') {
    setError(null);
    setNotice(null);

    try {
      const command = await session.run({
        type: 'service.control',
        payload: { name: row.name, action, expectedDisplayName: row.displayName },
        title: `${action[0]!.toUpperCase()}${action.slice(1)} ${row.displayName}`,
        description:
          action === 'start'
            ? `WOLF will start ${row.displayName} on this PC.`
            : `WOLF will ${action} ${row.displayName}. Anything depending on it stops too.`,
      });

      report(command, row);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  async function setStartType(row: ServiceRow, startType: string) {
    if (startType === row.startType) return;

    setError(null);
    setNotice(null);

    try {
      const command = await session.run({
        type: 'service.set-start-type',
        payload: { name: row.name, startType, expectedDisplayName: row.displayName },
        title: `Set ${row.displayName} to ${startType}`,
        description:
          startType === 'disabled'
            ? `${row.displayName} will not start again, including after a restart.`
            : `${row.displayName} will start ${startType} from now on.`,
      });

      report(command, row);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  /**
   * Say what actually happened, which is not always what was asked for.
   *
   * A refusal WOLF made on purpose is reported as a notice rather than an error: the product
   * is working exactly as designed, and dressing it as a failure would suggest it is the sort
   * of thing that can be retried into working.
   */
  function report(command: CommandView | null, row: ServiceRow) {
    if (!command) return;

    if (command.status === 'completed') {
      const result = command.result as { status?: string; note?: string | null } | null;
      setNotice(
        result?.note ?? `${row.displayName} is now ${result?.status ?? 'in an unknown state'}.`,
      );
      void refresh();
      return;
    }

    if (command.failure?.limitation) {
      setNotice(command.failure.message);
      return;
    }

    setError({
      code: command.failure?.code ?? 'command.failed',
      problem: `${row.displayName} could not be changed.`,
      cause: command.failure?.message ?? `The command ended as "${command.status}".`,
      currentState: 'Nothing on the PC was changed.',
      recommendedAction: 'Refresh the service list and try again.',
      referenceId: `WOLF-CMD-${command.id.slice(-4)}`,
      httpStatus: 502,
    });
  }

  const visible = (rows ?? []).filter((row) =>
    search.trim() === ''
      ? true
      : `${row.name} ${row.displayName}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="stack">
      {error ? <Problem problem={error} onRetry={() => void refresh()} /> : null}

      {!helperAvailable ? (
        <div className="notice">
          <strong>WOLF cannot read this PC&rsquo;s services.</strong>
          <div style={{ marginTop: 6 }}>
            {unavailableReason ??
              'The WOLF privileged helper is not running on that PC. Services are read and changed through it, so that the process holding the network connection is not the one holding administrator rights.'}
          </div>
        </div>
      ) : null}

      {notice ? <div className="notice">{notice}</div> : null}

      <Panel
        title="Services"
        actions={
          <>
            <input
              type="search"
              placeholder="Filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 180 }}
              aria-label="Filter services"
            />
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              {busy ? 'Reading…' : 'Refresh'}
            </button>
          </>
        }
        flush
      >
        {rows === null ? (
          <Empty>{busy ? 'Reading the service list…' : 'No service list has been read yet.'}</Empty>
        ) : visible.length === 0 ? (
          <Empty>No service matches that filter.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Starts</th>
                  <th>Account</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.name}>
                    <td>
                      {row.displayName}
                      <div className="muted">{row.name}</div>
                      {row.protectedBy ? (
                        <div className="muted">{PROTECTIONS[row.protectedBy] ?? row.protectedBy}</div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={
                          row.status === 'running'
                            ? 'status status-online'
                            : row.status === 'stopped'
                              ? 'status status-offline'
                              : 'status status-warn'
                        }
                      >
                        {row.status}
                      </span>
                    </td>
                    <td>
                      {row.protectedBy || row.startType === 'boot' || row.startType === 'system' ? (
                        // Boot and system start types are readable but not settable: they
                        // belong to drivers that load before the service control manager
                        // exists, and there is no safe way back from putting one there.
                        <span className="secondary">{row.startType ?? 'unknown'}</span>
                      ) : (
                        <select
                          value={row.startType ?? ''}
                          onChange={(event) => void setStartType(row, event.target.value)}
                          aria-label={`Start type for ${row.displayName}`}
                        >
                          {row.startType === null ? <option value="">unknown</option> : null}
                          {START_TYPES.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="secondary">{row.account ?? ''}</td>
                    <td style={{ textAlign: 'right' }}>
                      {row.status === 'running' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void control(row, 'restart')}
                            disabled={Boolean(row.protectedBy) || !row.canStop}
                          >
                            Restart
                          </button>{' '}
                          <button
                            type="button"
                            onClick={() => void control(row, 'stop')}
                            disabled={Boolean(row.protectedBy) || !row.canStop}
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => void control(row, 'start')}>
                          Start
                        </button>
                      )}
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

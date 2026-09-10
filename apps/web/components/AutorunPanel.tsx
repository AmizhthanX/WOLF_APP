'use client';

import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import type { CommandView } from '@/lib/wolf';
import type { usePcSession } from '@/lib/use-pc-session';
import { Empty, Panel, Problem } from '@/components/ui';

/**
 * What the PC does on its own: scheduled tasks and startup items.
 *
 * Shown together because they are the same question asked twice, and because an operator
 * looking into "why does this machine keep doing that" has to check both. With services these
 * are the three ways something runs without anybody asking.
 *
 * **WOLF can turn these off and on, and cannot create or remove them.** Disabling a startup
 * entry writes the same approval flag Task Manager writes, so the entry survives and can be
 * put back — which is why the buttons say enable and disable rather than remove.
 */

interface TaskRow {
  readonly path: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
  readonly lastResult: number;
  readonly account: string | null;
  readonly actions: readonly string[];
  readonly protectedBy: string | null;
}

interface StartupRow {
  readonly name: string;
  readonly command: string | null;
  readonly scope: string;
  readonly source: string;
  readonly user: string | null;
  readonly enabled: boolean;
  readonly protectedBy: string | null;
}

const PROTECTIONS: Record<string, string> = {
  'wolf-task': 'WOLF’s own scheduled work.',
  'wolf-startup': 'WOLF’s own startup entry.',
  'system-critical': 'Windows uses this to keep itself working.',
};

const SOURCES: Record<string, string> = {
  run: 'Run key',
  'run-once': 'RunOnce key',
  'startup-folder': 'Startup folder',
};

function when(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

export function AutorunPanel({ session }: { session: ReturnType<typeof usePcSession> }) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [startup, setStartup] = useState<StartupRow[] | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session.sessionToken) return;
    setBusy(true);
    setError(null);

    try {
      const taskCommand = await session.run({
        type: 'task.list',
        payload: {},
        title: 'List scheduled tasks',
        description: 'Read the scheduled tasks from this PC, hidden ones included.',
      });

      const startupCommand = await session.run({
        type: 'startup.list',
        payload: {},
        title: 'List startup items',
        description: 'Read what runs when somebody signs in to this PC.',
      });

      if (taskCommand?.status === 'completed') {
        const result = taskCommand.result as {
          tasks?: TaskRow[];
          helperAvailable?: boolean;
          unavailableReason?: string | null;
        } | null;

        setTasks(result?.tasks ?? []);
        // An empty list and a reason are different from an empty list: every Windows machine
        // ships with scheduled tasks, so none at all means WOLF could not ask.
        setUnavailable(result?.helperAvailable === false ? (result.unavailableReason ?? null) : null);
      }

      if (startupCommand?.status === 'completed') {
        const result = startupCommand.result as { entries?: StartupRow[] } | null;
        setStartup(result?.entries ?? []);
      }
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(false);
    }
  }, [session]);

  useEffect(() => {
    if (session.sessionToken) void refresh();
    // Once per session token rather than on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionToken]);

  async function controlTask(row: TaskRow, action: 'enable' | 'disable' | 'run') {
    setError(null);
    setNotice(null);

    try {
      const command = await session.run({
        type: 'task.control',
        payload: { path: row.path, action, expectedName: row.name },
        title: `${action[0]!.toUpperCase()}${action.slice(1)} ${row.name}`,
        description:
          action === 'run'
            ? `WOLF will ask this PC to run ${row.name} now. What it runs was decided by whoever registered it.`
            : `${row.name} will be ${action}d on this PC.`,
      });

      report(command, row.name);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  async function setStartupEnabled(row: StartupRow, enabled: boolean) {
    setError(null);
    setNotice(null);

    try {
      const command = await session.run({
        type: 'startup.set-enabled',
        payload: { name: row.name, scope: row.scope, source: row.source, enabled },
        title: `${enabled ? 'Enable' : 'Disable'} ${row.name} at sign-in`,
        description: enabled
          ? `${row.name} will start again when somebody signs in.`
          : `${row.name} will not start at sign-in. The entry itself stays, so this can be undone.`,
      });

      report(command, row.name);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }

  /**
   * A refusal WOLF made on purpose is a notice, not an error.
   *
   * The product is working exactly as designed, and dressing it as a failure would suggest it
   * is the sort of thing that retries into working.
   */
  function report(command: CommandView | null, name: string) {
    if (!command) return;

    if (command.status === 'completed') {
      setNotice(`${name} was changed on this PC.`);
      void refresh();
      return;
    }

    if (command.failure?.limitation) {
      setNotice(command.failure.message);
      return;
    }

    setError({
      code: command.failure?.code ?? 'command.failed',
      problem: `${name} could not be changed.`,
      cause: command.failure?.message ?? `The command ended as "${command.status}".`,
      currentState: 'Nothing on the PC was changed.',
      recommendedAction: 'Refresh and try again.',
      referenceId: `WOLF-CMD-${command.id.slice(-4)}`,
      httpStatus: 502,
    });
  }

  const term = search.trim().toLowerCase();
  const visibleTasks = (tasks ?? []).filter((row) =>
    term === '' ? true : `${row.path} ${row.actions.join(' ')}`.toLowerCase().includes(term),
  );
  const visibleStartup = (startup ?? []).filter((row) =>
    term === '' ? true : `${row.name} ${row.command ?? ''}`.toLowerCase().includes(term),
  );

  return (
    <div className="stack">
      {error ? <Problem problem={error} onRetry={() => void refresh()} /> : null}

      {unavailable ? (
        <div className="notice">
          <strong>WOLF cannot read what this PC runs on its own.</strong>
          <div style={{ marginTop: 6 }}>{unavailable}</div>
        </div>
      ) : null}

      {notice ? <div className="notice">{notice}</div> : null}

      <div className="notice">
        WOLF can turn these off and on. It cannot create a scheduled task or add a startup
        entry, and it cannot delete either — those are how Windows persistence is installed,
        and a remote tool that could do it would be one too. Disabling a startup entry leaves
        the entry in place, so it can be put back.
      </div>

      <Panel
        title="Startup items"
        actions={
          <>
            <input
              type="search"
              placeholder="Filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 180 }}
              aria-label="Filter tasks and startup items"
            />
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              {busy ? 'Reading…' : 'Refresh'}
            </button>
          </>
        }
        flush
      >
        {startup === null ? (
          <Empty>{busy ? 'Reading…' : 'Nothing has been read yet.'}</Empty>
        ) : visibleStartup.length === 0 ? (
          <Empty>Nothing matches that filter.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Where</th>
                  <th>Runs</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleStartup.map((row) => (
                  <tr key={`${row.scope}-${row.source}-${row.name}`}>
                    <td>
                      {row.name}
                      {row.protectedBy ? (
                        <div className="muted">{PROTECTIONS[row.protectedBy] ?? row.protectedBy}</div>
                      ) : null}
                    </td>
                    <td className="secondary">
                      {SOURCES[row.source] ?? row.source}
                      <div className="muted">{row.user ?? (row.scope === 'machine' ? 'everyone' : 'this user')}</div>
                    </td>
                    <td className="secondary" style={{ maxWidth: 380, wordBreak: 'break-all' }}>
                      {row.command ?? ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => void setStartupEnabled(row, !row.enabled)}
                        disabled={Boolean(row.protectedBy) && row.enabled}
                      >
                        {row.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Scheduled tasks" flush>
        {tasks === null ? (
          <Empty>{busy ? 'Reading…' : 'Nothing has been read yet.'}</Empty>
        ) : visibleTasks.length === 0 ? (
          <Empty>No task matches that filter.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>State</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((row) => (
                  <tr key={row.path}>
                    <td>
                      {row.name}
                      <div className="muted">{row.path}</div>
                      {/* What it runs is the first thing anybody investigating a machine
                          reads, so it is in the table rather than behind a click. */}
                      {row.actions.length > 0 ? (
                        <div className="muted" style={{ wordBreak: 'break-all' }}>
                          {row.actions[0]}
                        </div>
                      ) : null}
                      {row.protectedBy ? (
                        <div className="muted">{PROTECTIONS[row.protectedBy] ?? row.protectedBy}</div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={
                          !row.enabled
                            ? 'status status-offline'
                            : row.state === 'running'
                              ? 'status status-online'
                              : 'status status-warn'
                        }
                      >
                        {row.enabled ? row.state : 'disabled'}
                      </span>
                    </td>
                    <td className="secondary">
                      {when(row.lastRunAt)}
                      {row.lastResult !== 0 ? (
                        <div className="muted">exit {row.lastResult}</div>
                      ) : null}
                    </td>
                    <td className="secondary">{when(row.nextRunAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" onClick={() => void controlTask(row, 'run')}>
                        Run
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void controlTask(row, row.enabled ? 'disable' : 'enable')}
                        disabled={Boolean(row.protectedBy) && row.enabled}
                      >
                        {row.enabled ? 'Disable' : 'Enable'}
                      </button>
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

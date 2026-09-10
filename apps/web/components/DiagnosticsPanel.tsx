'use client';

import { useCallback, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import type { CommandView } from '@/lib/wolf';
import type { usePcSession } from '@/lib/use-pc-session';
import { Empty, Panel, Problem } from '@/components/ui';
import { bytes } from '@/lib/format';

/**
 * The three questions an operator asks when something is wrong and nothing has crashed.
 *
 * Nothing here runs on its own. Each section is read when asked for, because two of the three
 * cost something real: the connection list is the expensive half of a network read, and a
 * network test makes the PC emit packets on the operator's behalf.
 */

interface Adapter {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: string;
  readonly status: string;
  readonly macAddress: string | null;
  readonly speedBitsPerSecond: number | null;
  readonly addresses: readonly string[];
  readonly gateways: readonly string[];
  readonly dnsServers: readonly string[];
  readonly dhcpEnabled: boolean | null;
}

interface EventRow {
  readonly recordId: number | null;
  readonly provider: string | null;
  readonly eventId: number;
  readonly level: string;
  readonly createdAt: string | null;
  readonly message: string | null;
  readonly messageTruncated: boolean;
}

interface Inventory {
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly biosVendor: string | null;
  readonly biosVersion: string | null;
  readonly baseboard: string | null;
  readonly cpu: { name: string | null; cores: number | null; threads: number | null } | null;
  readonly memoryModules: readonly {
    slot: string | null;
    capacityBytes: number | null;
    speedMhz: number | null;
    manufacturer: string | null;
  }[];
  readonly disks: readonly { model: string | null; sizeBytes: number | null; busType: string | null }[];
  readonly gpus: readonly { name: string; driverVersion: string | null }[];
}

interface TestOutcome {
  readonly test: string;
  readonly target: string;
  readonly reachable: boolean;
  readonly resolved: readonly string[];
  readonly roundTripMs: readonly (number | null)[];
  readonly detail: string | null;
}

export function DiagnosticsPanel({ session }: { session: ReturnType<typeof usePcSession> }) {
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [hostName, setHostName] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [log, setLog] = useState('System');
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [test, setTest] = useState('ping');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('443');
  const [error, setError] = useState<WolfProblem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = useCallback((command: CommandView, what: string) => {
    setError({
      code: command.failure?.code ?? 'command.failed',
      problem: `${what} could not be read.`,
      cause: command.failure?.message ?? `The command ended as "${command.status}".`,
      currentState: 'Nothing on the PC was changed.',
      recommendedAction: command.failure?.limitation
        ? 'This is a limitation on that PC rather than a WOLF fault.'
        : 'Retry. If it keeps failing, check the agent log on the PC.',
      referenceId: `WOLF-CMD-${command.id.slice(-4)}`,
      httpStatus: 502,
    });
  }, []);

  const readNetwork = useCallback(
    async (includeConnections: boolean) => {
      setBusy('network');
      setError(null);

      try {
        const command = await session.run({
          type: 'network.info',
          payload: { includeConnections },
          title: 'Read network configuration',
          description: 'Read this PC’s addresses, gateways and DNS servers.',
        });

        if (!command) return;
        if (command.status !== 'completed') return fail(command, 'The network configuration');

        const result = command.result as { hostName?: string; adapters?: Adapter[] } | null;
        setHostName(result?.hostName ?? null);
        setAdapters(result?.adapters ?? []);
      } catch (caught) {
        if (caught instanceof WolfApiError) setError(caught.problem);
      } finally {
        setBusy(null);
      }
    },
    [fail, session],
  );

  const runTest = useCallback(async () => {
    if (target.trim() === '') return;

    setBusy('test');
    setError(null);
    setOutcome(null);

    try {
      const command = await session.run({
        type: 'network.test',
        payload:
          test === 'tcp'
            ? { test, target: target.trim(), port: Number(port) || 443, timeoutMs: 2000 }
            : { test, target: target.trim(), count: 4, timeoutMs: 2000 },
        title: `${test} ${target.trim()}`,
        // Said plainly, because it is what the confirmation is for. This is not a read: it
        // makes somebody else's machine send packets to a destination this operator chose,
        // and the audit record will name it.
        description: `WOLF will ask this PC to contact ${target.trim()}. The attempt is recorded in the audit log.`,
      });

      if (!command) return;
      if (command.status !== 'completed') return fail(command, 'That test');

      setOutcome(command.result as TestOutcome);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(null);
    }
  }, [fail, port, session, target, test]);

  const readEvents = useCallback(async () => {
    setBusy('events');
    setError(null);

    try {
      const command = await session.run({
        type: 'eventlog.query',
        payload: { log, minimumLevel: 'warning', withinHours: 24, limit: 100 },
        title: `Read the ${log} log`,
        description:
          log === 'Security'
            ? 'Read the Windows Security log — logon events, privilege use, account changes. The entries travel to WOLF and are kept with the command result.'
            : `Read warnings and errors from this PC’s ${log} log. The entries travel to WOLF and are kept with the command result.`,
      });

      if (!command) return;
      if (command.status !== 'completed') return fail(command, 'The event log');

      const result = command.result as { events?: EventRow[]; unavailableReason?: string | null } | null;
      setEvents(result?.events ?? []);

      if (result?.unavailableReason) {
        setError({
          code: 'eventlog.unavailable',
          problem: `The ${log} log could not be read.`,
          cause: result.unavailableReason,
          currentState: 'Nothing was read.',
          recommendedAction: 'The Security log needs the agent to be running with administrator rights.',
          referenceId: 'WOLF-EVT-0001',
          httpStatus: 403,
        });
      }
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(null);
    }
  }, [fail, log, session]);

  const readInventory = useCallback(
    async (includeSerialNumbers: boolean) => {
      setBusy('inventory');
      setError(null);

      try {
        const command = await session.run({
          type: 'hardware.inventory',
          payload: { includeSerialNumbers },
          title: includeSerialNumbers ? 'Read hardware inventory with serial numbers' : 'Read hardware inventory',
          description: includeSerialNumbers
            ? 'Read what this PC is made of, including the serial numbers of the machine and its parts.'
            : 'Read what this PC is made of.',
        });

        if (!command) return;
        if (command.status !== 'completed') return fail(command, 'The hardware inventory');

        setInventory(command.result as Inventory);
      } catch (caught) {
        if (caught instanceof WolfApiError) setError(caught.problem);
      } finally {
        setBusy(null);
      }
    },
    [fail, session],
  );

  return (
    <div className="stack">
      {error ? <Problem problem={error} /> : null}

      <Panel
        title="Network"
        actions={
          <>
            <button type="button" onClick={() => void readNetwork(false)} disabled={busy !== null}>
              {busy === 'network' ? 'Reading…' : 'Read'}
            </button>
            <button type="button" onClick={() => void readNetwork(true)} disabled={busy !== null}>
              With connections
            </button>
          </>
        }
      >
        {adapters === null ? (
          <Empty>Nothing has been read yet.</Empty>
        ) : (
          <div className="stack">
            <div className="muted">{hostName}</div>
            {adapters
              .filter((adapter) => adapter.kind !== 'loopback')
              .map((adapter) => (
                <div key={adapter.id} className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ minWidth: 200 }}>
                    <strong>{adapter.name}</strong>
                    <div className="muted">{adapter.description}</div>
                  </div>
                  <div>
                    <span
                      className={
                        adapter.status === 'up' ? 'status status-online' : 'status status-offline'
                      }
                    >
                      {adapter.status}
                    </span>
                    <div className="muted">
                      {adapter.addresses.join(', ') || 'no address'}
                      {adapter.gateways.length > 0 ? ` · via ${adapter.gateways.join(', ')}` : ''}
                      {adapter.dnsServers.length > 0 ? ` · DNS ${adapter.dnsServers.join(', ')}` : ''}
                      {adapter.dhcpEnabled === true ? ' · DHCP' : adapter.dhcpEnabled === false ? ' · static' : ''}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Panel>

      <Panel title="Reachability">
        <div className="stack">
          <div className="notice">
            This asks the PC to send packets to somewhere you choose. WOLF tests one host at a
            time, with a handful of packets and one port — never a range — and records what was
            probed in the audit log.
          </div>

          <div className="row">
            <select value={test} onChange={(event) => setTest(event.target.value)} aria-label="Test">
              <option value="ping">Ping</option>
              <option value="dns">Resolve a name</option>
              <option value="tcp">Connect to a port</option>
            </select>
            <input
              type="text"
              placeholder="host or address"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              style={{ width: 240 }}
              aria-label="Target"
            />
            {test === 'tcp' ? (
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                style={{ width: 90 }}
                aria-label="Port"
              />
            ) : null}
            <button type="button" onClick={() => void runTest()} disabled={busy !== null || target.trim() === ''}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
          </div>

          {outcome ? (
            <div className="notice">
              <strong>
                {outcome.reachable ? 'Reached' : 'Could not reach'} {outcome.target}
              </strong>
              <div style={{ marginTop: 6 }}>
                {outcome.resolved.length > 0 ? <div>Resolved to {outcome.resolved.join(', ')}</div> : null}
                {outcome.roundTripMs.length > 0 ? (
                  <div>
                    {outcome.roundTripMs
                      .map((value) => (value === null ? 'no answer' : `${Math.round(value)} ms`))
                      .join(' · ')}
                  </div>
                ) : null}
                {outcome.detail ? <div>{outcome.detail}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Event log"
        actions={
          <>
            <select value={log} onChange={(event) => setLog(event.target.value)} aria-label="Log">
              <option value="System">System</option>
              <option value="Application">Application</option>
              <option value="Security">Security</option>
              <option value="Setup">Setup</option>
            </select>
            <button type="button" onClick={() => void readEvents()} disabled={busy !== null}>
              {busy === 'events' ? 'Reading…' : 'Read'}
            </button>
          </>
        }
        flush
      >
        {events === null ? (
          <Empty>Nothing has been read yet. Warnings and errors from the last day.</Empty>
        ) : events.length === 0 ? (
          <Empty>Nothing at that level in the last day, which is good news.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((row, index) => (
                  <tr key={`${row.recordId ?? index}`}>
                    <td className="secondary" style={{ whiteSpace: 'nowrap' }}>
                      {row.createdAt ? new Date(row.createdAt).toLocaleString() : ''}
                    </td>
                    <td>
                      <span
                        className={
                          row.level === 'critical' || row.level === 'error'
                            ? 'status status-offline'
                            : row.level === 'warning'
                              ? 'status status-warn'
                              : 'status'
                        }
                      >
                        {row.level}
                      </span>
                    </td>
                    <td className="secondary">
                      {row.provider}
                      <div className="muted">#{row.eventId}</div>
                    </td>
                    <td style={{ maxWidth: 520 }}>
                      {row.message ?? <span className="muted">no message text on this PC</span>}
                      {row.messageTruncated ? <div className="muted">…cut by WOLF</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="What this PC is made of"
        actions={
          <>
            <button type="button" onClick={() => void readInventory(false)} disabled={busy !== null}>
              {busy === 'inventory' ? 'Reading…' : 'Read'}
            </button>
            <button type="button" onClick={() => void readInventory(true)} disabled={busy !== null}>
              With serial numbers
            </button>
          </>
        }
      >
        {inventory === null ? (
          <Empty>Nothing has been read yet.</Empty>
        ) : (
          <div className="stack">
            <div>
              <strong>
                {inventory.manufacturer} {inventory.model}
              </strong>
              <div className="muted">
                {inventory.baseboard}
                {inventory.biosVendor ? ` · BIOS ${inventory.biosVendor} ${inventory.biosVersion ?? ''}` : ''}
              </div>
            </div>

            {inventory.cpu ? (
              <div>
                {inventory.cpu.name}
                <div className="muted">
                  {inventory.cpu.cores} cores, {inventory.cpu.threads} threads
                </div>
              </div>
            ) : null}

            {inventory.memoryModules.length > 0 ? (
              <div>
                <strong>Memory</strong>
                {inventory.memoryModules.map((module, index) => (
                  <div key={index} className="muted">
                    {module.slot}: {bytes(module.capacityBytes)}
                    {module.speedMhz ? ` @ ${module.speedMhz} MHz` : ''}
                    {module.manufacturer ? ` · ${module.manufacturer}` : ''}
                  </div>
                ))}
              </div>
            ) : null}

            {inventory.disks.length > 0 ? (
              <div>
                <strong>Disks</strong>
                {inventory.disks.map((disk, index) => (
                  <div key={index} className="muted">
                    {disk.model} · {bytes(disk.sizeBytes)}
                    {disk.busType ? ` · ${disk.busType}` : ''}
                  </div>
                ))}
              </div>
            ) : null}

            {inventory.gpus.length > 0 ? (
              <div>
                <strong>Graphics</strong>
                {inventory.gpus.map((gpu, index) => (
                  <div key={index} className="muted">
                    {gpu.name}
                    {gpu.driverVersion ? ` · driver ${gpu.driverVersion}` : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

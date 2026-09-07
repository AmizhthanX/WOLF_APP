'use client';

import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import { getIceServers, type DisplayInfo, type Pc } from '@/lib/wolf';
import type { usePcSession } from '@/lib/use-pc-session';
import { Empty, Panel, Problem } from '@/components/ui';
import { RemoteDesktopViewer } from '@/components/RemoteDesktopViewer';

/**
 * Reasons a PC cannot stream, in the operator's terms.
 *
 * Each pairs a plain statement with whether waiting will fix it. That distinction is the
 * whole point: "someone is signing in" and "this machine has no encoder" both mean no
 * stream right now, but only one of them is worth waiting for.
 */
const REASONS: Record<string, { text: string; transient: boolean }> = {
  locked: { text: 'The workstation is locked.', transient: true },
  login: { text: 'The Windows sign-in screen is showing.', transient: true },
  'signed-out': { text: 'Nobody is signed in at this PC.', transient: true },
  restarting: { text: 'The PC is restarting.', transient: true },
  'no-session-host': {
    text: 'The WOLF session host is not running in the signed-in session.',
    transient: true,
  },
  'no-display': { text: 'No display is attached to this PC.', transient: false },
  'no-encoder': { text: 'This PC has no video encoder WOLF can use.', transient: false },
  'capture-unsupported': {
    text: 'This PC cannot capture its screen — the agent found no usable capture API.',
    transient: false,
  },
  'transport-unavailable': {
    text: 'This agent build can capture the screen but cannot yet deliver it to a viewer.',
    transient: false,
  },
  'codec-mismatch': {
    text: 'This PC and your browser share no video codec.',
    transient: false,
  },
  'kill-switch': { text: 'Remote access is disabled for this PC.', transient: false },
};

export function RemoteDesktopPanel({
  pc,
  session,
}: {
  pc: Pc;
  session: ReturnType<typeof usePcSession>;
}) {
  const capabilities = pc.capabilities;
  const [displays, setDisplays] = useState<DisplayInfo[] | null>(null);
  const [reachability, setReachability] = useState<{
    reachability: string;
    note: string | null;
  } | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDisplays = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const command = await session.run({
        type: 'remote-desktop.list-displays',
        payload: { refresh: true },
        title: 'List displays',
        description: 'Read the display layout from this PC.',
      });

      if (!command) return;

      if (command.status === 'completed') {
        const result = command.result as { displays?: DisplayInfo[] } | null;
        setDisplays(result?.displays ?? []);
        return;
      }

      setError({
        code: command.failure?.code ?? 'command.failed',
        problem: 'The display layout could not be read.',
        cause: command.failure?.message ?? `The command ended as "${command.status}".`,
        currentState: 'No display information is available.',
        recommendedAction: command.failure?.limitation
          ? 'This needs somebody signed in at the PC. It resolves on its own once they are.'
          : 'Retry once the PC is in a normal desktop session.',
        referenceId: `WOLF-RTC-${command.id.slice(-4)}`,
        httpStatus: 502,
      });
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setBusy(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session.sessionToken) return;

    void getIceServers(pc.id, session.sessionToken)
      .then((result) => setReachability({ reachability: result.reachability, note: result.note }))
      .catch(() => {
        // Not fatal: the panel still shows capability information without it.
        setReachability(null);
      });
  }, [pc.id, session.sessionToken]);

  const reason = capabilities?.remoteDesktopUnavailableReason;
  const explanation = reason ? REASONS[reason] : null;

  return (
    <div className="stack">
      {error ? <Problem problem={error} onRetry={() => void loadDisplays()} /> : null}

      <Panel title="Remote desktop">
        {!capabilities ? (
          <Empty>This PC has not reported its capabilities yet.</Empty>
        ) : (
          <div className="stack">
            <div className="row">
              <span
                className={
                  capabilities.remoteDesktopAvailable
                    ? 'status status-online'
                    : explanation?.transient
                      ? 'status status-warn'
                      : 'status status-offline'
                }
              >
                {capabilities.remoteDesktopAvailable ? 'ready to stream' : 'not available'}
              </span>
              {reachability ? (
                <span className="route-badge">
                  {reachability.reachability === 'lan-only' ? 'LAN only' : 'LAN and internet'}
                </span>
              ) : null}
            </div>

            {!capabilities.remoteDesktopAvailable ? (
              <div className="notice">
                <strong>{explanation?.text ?? 'Streaming is not available on this PC.'}</strong>
                <div style={{ marginTop: 6 }}>
                  {explanation?.transient
                    ? 'This resolves on its own — WOLF will offer the stream as soon as it can.'
                    : 'This will not resolve on its own.'}
                </div>
              </div>
            ) : null}

            {reachability?.note ? <div className="notice">{reachability.note}</div> : null}
          </div>
        )}
      </Panel>

      {capabilities?.remoteDesktopAvailable ? (
        <RemoteDesktopViewer
          pcId={pc.id}
          sessionToken={session.sessionToken}
          displays={displays}
        />
      ) : null}

      <Panel
        title="Displays"
        actions={
          <button type="button" onClick={() => void loadDisplays()} disabled={busy}>
            {busy ? 'Reading…' : 'Refresh'}
          </button>
        }
        flush
      >
        {displays === null ? (
          <Empty>
            {capabilities && capabilities.displayCount > 0
              ? `${capabilities.displayCount} display${capabilities.displayCount === 1 ? '' : 's'} detected. Refresh to see the layout.`
              : 'No display layout has been read yet.'}
          </Empty>
        ) : displays.length === 0 ? (
          <Empty>The PC reported no attached displays.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Display</th>
                <th className="numeric">Resolution</th>
                <th className="numeric">Refresh</th>
                <th className="numeric">Scale</th>
                <th>Position</th>
              </tr>
            </thead>
            <tbody>
              {displays.map((display) => (
                <tr key={display.id}>
                  <td>
                    {display.name}
                    {display.primary ? (
                      <span className="status status-info" style={{ marginLeft: 8 }}>
                        primary
                      </span>
                    ) : null}
                    {display.hdr ? (
                      <span className="status status-info" style={{ marginLeft: 8 }}>
                        HDR
                      </span>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {display.widthPixels} × {display.heightPixels}
                  </td>
                  <td className="numeric">
                    {display.refreshHz === null ? (
                      <span className="unavailable">unknown</span>
                    ) : (
                      `${display.refreshHz} Hz`
                    )}
                  </td>
                  <td className="numeric">
                    {display.scaleFactor === null ? (
                      <span className="unavailable">unknown</span>
                    ) : (
                      `${Math.round(display.scaleFactor * 100)}%`
                    )}
                  </td>
                  <td className="mono secondary">
                    {display.originX}, {display.originY}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Video encoders">
        {!capabilities || capabilities.videoEncoders.length === 0 ? (
          <Empty>
            No encoders have been reported. They are detected inside the signed-in session, so
            this fills in once somebody is signed in at the PC.
          </Empty>
        ) : (
          <div className="stack">
            <div className="grid-metrics">
              {capabilities.videoEncoders.map((encoder) => {
                const hardware = encoder.endsWith('-hardware');
                return (
                  <div key={encoder} className="metric">
                    <div className="metric-label">{encoder.replace(/-(hardware|software)$/, '')}</div>
                    <div style={{ marginTop: 6 }}>
                      <span className={hardware ? 'status status-online' : 'status status-offline'}>
                        {hardware ? 'hardware' : 'software'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              A software encoder works but costs this PC&apos;s CPU. WOLF prefers a hardware
              encoder when both sides support the codec.
              {capabilities.preferredVideoCodec
                ? ` Preferred here: ${capabilities.preferredVideoCodec.toUpperCase()}.`
                : ''}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

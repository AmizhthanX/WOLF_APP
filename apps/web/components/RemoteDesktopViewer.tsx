'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRemoteDesktop } from '@/lib/use-remote-desktop';
import { TerminalPanel } from '@/components/TerminalPanel';
import { FilePanel } from '@/components/FilePanel';
import { NO_OVERRIDES } from '@/lib/remote-desktop';
import type {
  InputEvent,
  QualityOverrides,
  StreamPhase,
  StreamProfile,
} from '@/lib/remote-desktop';
import {
  isExtendedCode,
  normalizePoint,
  pointerButtonFor,
  scrollNotches,
  virtualKeyFor,
} from '@/lib/input-capture';
import type { DisplayInfo } from '@/lib/wolf';
import { Panel } from '@/components/ui';

/**
 * The stream itself: the picture, what it cost to deliver, and the controls over it.
 *
 * Two sets of statistics are shown side by side because they answer different questions and
 * only one side can measure each. The PC knows what it cost to capture and encode; the
 * browser knows what the network did to the result. Showing them together is what turns
 * "it feels laggy" into a specific answer.
 */

const PHASES: Record<StreamPhase, { label: string; tone: 'online' | 'warn' | 'offline' | 'info' }> = {
  idle: { label: 'not streaming', tone: 'offline' },
  authenticating: { label: 'authenticating', tone: 'info' },
  requesting: { label: 'asking the PC', tone: 'info' },
  negotiating: { label: 'negotiating', tone: 'info' },
  connecting: { label: 'connecting', tone: 'info' },
  streaming: { label: 'streaming', tone: 'online' },
  reconnecting: { label: 'reconnecting', tone: 'warn' },
  stopped: { label: 'stopped', tone: 'offline' },
  failed: { label: 'failed', tone: 'offline' },
};

/**
 * Presets, in the terms an operator actually chooses between.
 *
 * These mirror the built-in profiles the API serves. They are stated as what the stream
 * will be asked for, never as what it will get: the PC answers with what it could honour,
 * and the adjustments it reports are shown below the picture.
 */
const PRESETS: { id: string; label: string; hint: string; profile: StreamProfile }[] = [
  {
    id: 'lan-maximum-quality',
    label: 'Maximum quality',
    hint: 'For a fast local network.',
    profile: {
      name: 'LAN — Maximum Quality',
      maxWidthPixels: null,
      maxHeightPixels: null,
      targetFps: 60,
      minBitrateBps: 8_000_000,
      maxBitrateBps: 80_000_000,
      codecPreference: [],
      audioEnabled: false,
      qualityBias: 'quality',
      adaptive: true,
      overrides: NO_OVERRIDES,
    },
  },
  {
    id: 'internet-balanced',
    label: 'Balanced',
    hint: 'A sensible default over the internet.',
    profile: {
      name: 'Internet — Balanced',
      maxWidthPixels: null,
      maxHeightPixels: null,
      targetFps: 60,
      minBitrateBps: 1_500_000,
      maxBitrateBps: 20_000_000,
      codecPreference: [],
      audioEnabled: false,
      qualityBias: 'balanced',
      adaptive: true,
      overrides: NO_OVERRIDES,
    },
  },
  {
    id: 'mobile-low-bandwidth',
    label: 'Low bandwidth',
    hint: 'For mobile data or a poor link.',
    profile: {
      name: 'Mobile Data — Low Bandwidth',
      maxWidthPixels: 1280,
      maxHeightPixels: 720,
      targetFps: 30,
      minBitrateBps: 400_000,
      maxBitrateBps: 3_000_000,
      codecPreference: [],
      audioEnabled: false,
      qualityBias: 'performance',
      adaptive: true,
      overrides: NO_OVERRIDES,
    },
  },
];

/**
 * The values a lever can be pinned to.
 *
 * A short list rather than a free number box. Every value here is one the agent can
 * actually hold — the frame rates are the ones the adaptation ladder uses, the scales are
 * the ones the encoder will rebuild for — and a text field would mostly collect numbers
 * that come back clamped.
 */
const PIN_CHOICES = {
  bitrateBps: [1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 40_000_000],
  frameRate: [15, 24, 30, 48, 60],
  resolutionScale: [0.5, 0.75, 1],
};

/**
 * Hold pins inside what the chosen preset can express.
 *
 * The API rejects a pin above its own profile's ceiling, because a bitrate pinned higher
 * than the maximum has no reading that is not a guess. Switching preset can leave a pin
 * stranded above the new ceiling, so it is brought down here rather than sent to be
 * refused.
 */
function fitOverrides(profile: StreamProfile, overrides: QualityOverrides): QualityOverrides {
  return {
    bitrateBps:
      overrides.bitrateBps === null
        ? null
        : Math.min(overrides.bitrateBps, profile.maxBitrateBps),
    frameRate:
      overrides.frameRate === null ? null : Math.min(overrides.frameRate, profile.targetFps),
    resolutionScale: overrides.resolutionScale,
  };
}

function megabits(bitsPerSecond: number | null): string {
  if (bitsPerSecond === null) return 'not measured';
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1000)} kbps`;
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}

function milliseconds(value: number | null, digits = 1): string {
  return value === null ? 'not measured' : `${value.toFixed(digits)} ms`;
}

/**
 * Why control is not available, in the operator's terms.
 *
 * The distinction that matters is between "ask again in a moment" and "this is not yours to
 * take": somebody else driving is a different situation from a session that was never
 * granted control, and only one of them is worth waiting out.
 */
/**
 * Why a stream is running below the profile it was asked for.
 *
 * Each names the thing to look at. "Your network", "this PC's encoder", and "the PC is not
 * producing frames" are three different problems, and a single "degraded" badge would send
 * the operator to investigate the wrong one.
 */
const DEGRADED_REASONS: Record<string, string> = {
  bandwidth: 'The connection cannot carry the requested quality.',
  'packet-loss': 'The connection is losing packets.',
  'encoder-overloaded': "The PC's encoder cannot keep up at this quality.",
  'capture-slow': 'The PC is not producing frames fast enough to capture.',
  'cpu-saturated': "The PC's processor is saturated.",
  'profile-unsupported': 'This PC cannot meet the requested profile.',
};

const CONTROL_REFUSALS: Record<string, string> = {
  'capability-missing': 'This session was not granted control of this PC.',
  'held-by-another-session': 'Somebody else is controlling this PC right now.',
  released: 'You released control.',
  'session-ended': 'The session ended.',
  'kill-switch': 'Remote access is disabled for this PC.',
  unsupported: 'This PC cannot accept remote input.',
};

/** A statistic, or an honest statement that it has not been measured. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const unknown = value === 'not measured' || value === 'unknown';
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={unknown ? 'unavailable' : 'metric-value'}>{value}</div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function RemoteDesktopViewer({
  pcId,
  sessionToken,
  displays,
}: {
  pcId: string;
  sessionToken: string | null;
  displays: DisplayInfo[] | null;
}) {
  const view = useRemoteDesktop(pcId, sessionToken);
  const video = useRef<HTMLVideoElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const [presetId, setPresetId] = useState('internet-balanced');
  const [displayId, setDisplayId] = useState<string | null>(null);

  // Off unless somebody turns it on. Listening to a machine is a separate act from watching
  // it, and starting a stream is not a decision to start listening.
  const [wantAudio, setWantAudio] = useState(false);
  const [overrides, setOverrides] = useState<QualityOverrides>(NO_OVERRIDES);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  const controlling = view.control?.granted === true;

  // Events are batched to one frame rather than sent individually. Pointer movement
  // arrives far faster than it is worth putting on the wire, and a batch per frame is
  // both fewer messages and a more faithful record of what the operator did.
  const pending = useRef<InputEvent[]>([]);
  const flushHandle = useRef<number | null>(null);
  const sendInput = view.sendInput;

  const queue = useCallback(
    (event: InputEvent) => {
      pending.current.push(event);
      if (flushHandle.current !== null) return;

      flushHandle.current = requestAnimationFrame(() => {
        flushHandle.current = null;
        const batch = pending.current;
        pending.current = [];
        sendInput(batch);
      });
    },
    [sendInput],
  );

  const preset = useMemo(
    () => PRESETS.find((entry) => entry.id === presetId) ?? PRESETS[1]!,
    [presetId],
  );

  /** The preset, with whatever the operator has pinned on top of it. */
  const profile = useMemo<StreamProfile>(
    () => ({ ...preset.profile, overrides: fitOverrides(preset.profile, overrides) }),
    [preset, overrides],
  );

  /**
   * Pin or unpin one lever, and tell a running stream straight away.
   *
   * Applied live rather than on the next start: the whole point of a pin is that the
   * operator can see its effect on the picture in front of them.
   */
  const pin = useCallback(
    (lever: keyof QualityOverrides, value: number | null) => {
      const next = fitOverrides(preset.profile, { ...overrides, [lever]: value });
      setOverrides(next);

      if (view.phase === 'streaming' || view.phase === 'reconnecting') {
        view.setProfile({ ...preset.profile, overrides: next });
      }
    },
    [overrides, preset, view],
  );

  useEffect(() => {
    if (video.current && view.mediaStream) {
      video.current.srcObject = view.mediaStream;
    }
  }, [view.mediaStream]);

  /**
   * Capture the operator's input while control is held.
   *
   * Attached only when control has actually been granted, so nothing is captured — and the
   * browser's own shortcuts keep working — for somebody who is only watching.
   */
  useEffect(() => {
    const element = surface.current;
    const picture = video.current;
    if (!controlling || !element || !picture) return;

    const point = (event: MouseEvent) => normalizePoint(picture, event.clientX, event.clientY);

    const onMove = (event: MouseEvent) => {
      const at = point(event);
      if (at) queue({ type: 'pointer.move', x: at.x, y: at.y, offsetMs: 0 });
    };

    const onButton = (event: MouseEvent, action: 'down' | 'up') => {
      const at = point(event);
      const button = pointerButtonFor(event.button);
      if (!at || !button) return;

      event.preventDefault();
      queue({ type: 'pointer.button', button, action, x: at.x, y: at.y, offsetMs: 0 });
    };

    const onDown = (event: MouseEvent) => onButton(event, 'down');
    const onUp = (event: MouseEvent) => onButton(event, 'up');

    const onWheel = (event: WheelEvent) => {
      const at = point(event);
      if (!at) return;

      event.preventDefault();
      const { deltaX, deltaY } = scrollNotches(event);
      queue({ type: 'pointer.scroll', x: at.x, y: at.y, deltaX, deltaY, offsetMs: 0 });
    };

    // The remote machine gets the right-click, so the local menu must not open.
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    const onKey = (event: KeyboardEvent, action: 'down' | 'up') => {
      const key = virtualKeyFor(event.code);
      if (key === null) return;

      // Held while the surface has focus, so the browser's own shortcuts do not fire on
      // keys meant for the PC. The release button stays reachable with the mouse.
      event.preventDefault();
      queue({
        type: 'key',
        key,
        action,
        scanCode: null,
        extended: isExtendedCode(event.code),
        offsetMs: 0,
      });
    };

    const onKeyDown = (event: KeyboardEvent) => onKey(event, 'down');
    const onKeyUp = (event: KeyboardEvent) => onKey(event, 'up');

    element.addEventListener('mousemove', onMove);
    element.addEventListener('mousedown', onDown);
    element.addEventListener('mouseup', onUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('keyup', onKeyUp);

    return () => {
      element.removeEventListener('mousemove', onMove);
      element.removeEventListener('mousedown', onDown);
      element.removeEventListener('mouseup', onUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('keyup', onKeyUp);

      if (flushHandle.current !== null) {
        cancelAnimationFrame(flushHandle.current);
        flushHandle.current = null;
      }
      pending.current = [];
    };
  }, [controlling, queue]);

  const phase = PHASES[view.phase];
  const running = view.phase === 'streaming' || view.phase === 'reconnecting';
  const busy =
    view.phase === 'authenticating' ||
    view.phase === 'requesting' ||
    view.phase === 'negotiating' ||
    view.phase === 'connecting';

  const agent = view.agentStats;
  const client = view.clientStats;

  // The state message says so immediately; the statistics confirm it a moment later. Either
  // is enough to tell the operator the picture they are looking at is not the one they asked
  // for.
  const degraded = view.degradedReason ?? agent?.degradedReason ?? null;

  // Not a fault, and not something to leave the operator to work out from the picture: what
  // they can type on a lock screen, and what they cannot, is different from the desktop.
  const secure = view.showing === 'secure-desktop';

  // What the PC settled on, not what was asked for: a session without the `audio`
  // capability, or a machine with no sound device, comes back with this null and an
  // adjustment saying which.
  const audible = view.negotiation?.audioCodec != null;

  return (
    <div className="stack">
      <Panel
        title="Screen"
        actions={
          running || busy ? (
            <button type="button" onClick={view.stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => view.start(profile, displayId, wantAudio)}
              disabled={!sessionToken}
            >
              Start streaming
            </button>
          )
        }
      >
        <div className="stack">
          <div className="row">
            <span className={`status status-${phase.tone}`}>{phase.label}</span>
            {view.negotiation ? (
              <>
                <span className="route-badge">
                  {view.negotiation.videoCodec.toUpperCase()}
                  {view.negotiation.hardwareEncoded ? ' · hardware' : ' · software'}
                </span>
                <span className="route-badge">
                  {view.negotiation.display.widthPixels} × {view.negotiation.display.heightPixels}
                </span>
              </>
            ) : null}
            {client?.route ? <span className="route-badge">{client.route}</span> : null}
            {audible ? <span className="route-badge">sound</span> : null}
            {degraded ? <span className="status status-warn">below profile</span> : null}
            {secure ? <span className="status status-warn">lock screen</span> : null}
          </div>

          {degraded ? (
            <div className="muted">
              {DEGRADED_REASONS[degraded] ?? degraded} WOLF has lowered the quality to keep
              the stream running, and will raise it again when it can.
            </div>
          ) : null}

          {secure ? (
            <div className="notice">
              <strong>This is the PC&rsquo;s lock screen.</strong>
              <div style={{ marginTop: 6 }}>
                You can sign in here as you would at the machine itself. What you type goes
                to the lock screen and nowhere else &mdash; WOLF does not store it, log it,
                or know which of the keystrokes was the password. Ctrl+Alt+Delete and other
                system combinations are not delivered here; sign in first and they work as
                usual.
              </div>
            </div>
          ) : null}

          {view.detail ? <div className="muted">{view.detail}</div> : null}

          <div
            ref={surface}
            className={controlling ? 'viewer-surface viewer-surface-live' : 'viewer-surface'}
            // Focusable so it can receive keys. Without a focus target, keystrokes go to
            // the page and the remote machine never sees them.
            tabIndex={controlling ? 0 : -1}
          >
            <video
              ref={video}
              autoPlay
              playsInline
              // Muted unless the PC actually agreed to send sound. Unmuting a stream that
              // carries no audio track would show a live speaker icon over silence.
              muted={!audible}
              // Controls are deliberately absent: this is a live screen, not a recording,
              // and a scrub bar over it would suggest otherwise.
              className={view.mediaStream ? 'viewer-video' : 'viewer-video viewer-video-empty'}
            />

            {!view.mediaStream ? (
              <div className="viewer-overlay">
                {busy ? (
                  <span>Setting up the stream…</span>
                ) : view.phase === 'failed' ? (
                  <span>The stream could not start.</span>
                ) : (
                  <span>Not streaming.</span>
                )}
              </div>
            ) : null}
          </div>

          {/*
            Control is stated rather than implied. A viewer who does not know whether their
            clicks are going anywhere will assume the stream is broken.
          */}
          {running ? (
            <div className="row">
              {controlling ? (
                <>
                  <span className="status status-online">you have control</span>
                  <button type="button" onClick={view.releaseControl}>
                    Release control
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Click the picture to give it your keyboard.
                  </span>
                </>
              ) : (
                <>
                  <span className="status status-offline">view only</span>
                  <button type="button" onClick={view.requestControl}>
                    Take control
                  </button>
                  {view.control?.reason && view.control.reason !== 'granted' ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {CONTROL_REFUSALS[view.control.reason] ?? view.control.reason}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {view.error ? (
            <div className="notice">
              <strong>{view.error.message}</strong>
              <div style={{ marginTop: 6 }}>
                {view.error.limitation
                  ? 'This is a limitation of the PC or of Windows, not a WOLF failure.'
                  : null}{' '}
                {view.error.recommendedAction}
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Quality">
        <div className="stack">
          <div className="row">
            {PRESETS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === presetId ? 'preset preset-active' : 'preset'}
                onClick={() => {
                  setPresetId(entry.id);

                  // Pins survive a preset change, brought inside the new preset's ceilings.
                  // Someone who pinned 30 fps to keep a link usable did not stop meaning it
                  // because they also switched to a lower-bandwidth preset.
                  const fitted = fitOverrides(entry.profile, overrides);
                  setOverrides(fitted);

                  // A running stream is changed in place where the PC can manage it; a
                  // stopped one simply starts with the new profile next time.
                  if (running) view.setProfile({ ...entry.profile, overrides: fitted });
                }}
              >
                <span>{entry.label}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {entry.hint}
                </span>
              </button>
            ))}
          </div>

          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={wantAudio}
              onChange={(event) => setWantAudio(event.target.checked)}
              disabled={running || busy}
            />
            <span>Play this PC&apos;s sound</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {running || busy
                ? audible
                  ? 'Streaming the sound this PC is playing.'
                  : 'This stream has no audio.'
                : 'What the PC is playing \u2014 not its microphone.'}
            </span>
          </label>

          {displays && displays.length > 1 ? (
            <label className="row" style={{ gap: 8 }}>
              <span className="muted">Display</span>
              <select
                value={displayId ?? ''}
                onChange={(event) => {
                  const chosen = event.target.value || null;
                  setDisplayId(chosen);

                  // Switched in place on a running stream. Restarting would cost a fresh
                  // negotiation and several seconds of black screen just to look at the
                  // other monitor.
                  if (running) view.setDisplay(chosen);
                }}
                disabled={busy}
              >
                <option value="">Primary</option>
                {displays.map((display) => (
                  <option key={display.id} value={display.id}>
                    {display.name} ({display.widthPixels} × {display.heightPixels})
                    {display.primary ? ' — primary' : ''}
                  </option>
                ))}
              </select>
              {view.negotiation ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  Showing {view.negotiation.display.name}.
                </span>
              ) : null}
            </label>
          ) : null}

          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
            <legend className="muted" style={{ fontSize: 12, padding: 0 }}>
              Hold a setting steady. Anything left on <span className="mono">Automatic</span> keeps
              adapting to the link.
            </legend>

            {(
              [
                {
                  lever: 'bitrateBps' as const,
                  label: 'Bitrate',
                  choices: PIN_CHOICES.bitrateBps.filter(
                    (value) => value <= preset.profile.maxBitrateBps,
                  ),
                  format: megabits,
                },
                {
                  lever: 'frameRate' as const,
                  label: 'Frame rate',
                  choices: PIN_CHOICES.frameRate.filter(
                    (value) => value <= preset.profile.targetFps,
                  ),
                  format: (value: number) => `${value} fps`,
                },
                {
                  lever: 'resolutionScale' as const,
                  label: 'Resolution',
                  choices: PIN_CHOICES.resolutionScale,
                  format: (value: number) =>
                    value === 1 ? 'Full size' : `${Math.round(value * 100)}% of full size`,
                },
              ]
            ).map((row) => (
              <label key={row.lever} className="row" style={{ gap: 8 }}>
                <span className="muted" style={{ minWidth: 88 }}>
                  {row.label}
                </span>
                <select
                  value={overrides[row.lever] ?? ''}
                  onChange={(event) =>
                    pin(row.lever, event.target.value === '' ? null : Number(event.target.value))
                  }
                  disabled={busy}
                >
                  <option value="">Automatic</option>
                  {row.choices.map((value) => (
                    <option key={value} value={value}>
                      {row.format(value)}
                    </option>
                  ))}
                </select>
                {overrides[row.lever] !== null ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Held here. The PC says so below if it cannot manage it.
                  </span>
                ) : null}
              </label>
            ))}
          </fieldset>

          {view.adjustments.length > 0 ? (
            <div className="stack">
              <div className="muted" style={{ fontSize: 12 }}>
                The PC could not honour every setting, and said which:
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Asked for</th>
                    <th>Got</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {view.adjustments.map((adjustment) => (
                    <tr key={adjustment.setting}>
                      <td className="mono">{adjustment.setting}</td>
                      <td className="mono secondary">{adjustment.requested}</td>
                      <td className="mono">{adjustment.applied}</td>
                      <td className="secondary">{adjustment.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Panel>

      {running ? (
        <Panel title="Clipboard">
          <div className="stack">
            <div className="muted" style={{ fontSize: 12 }}>
              Clipboard content travels straight between this browser and the PC. It never
              reaches a WOLF server, and nothing about it is stored or logged anywhere.
            </div>

            {view.clipboardFromPc !== null ? (
              <div className="notice">
                <strong>This PC copied {view.clipboardFromPc.length} characters.</strong>
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(view.clipboardFromPc ?? '')
                        .then(() => view.clearClipboard())
                        .catch(() => setClipboardError('This browser would not let WOLF write to your clipboard.'));
                    }}
                  >
                    Copy to my clipboard
                  </button>
                  <button type="button" onClick={view.clearClipboard}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setClipboardError(null);
                  void navigator.clipboard
                    .readText()
                    .then((text) => {
                      if (text.length === 0) {
                        setClipboardError('Your clipboard is empty.');
                        return;
                      }

                      if (!view.sendClipboard(text)) {
                        setClipboardError('That could not be sent to the PC.');
                      }
                    })
                    .catch(() =>
                      setClipboardError(
                        'This browser would not let WOLF read your clipboard. Most browsers ask ' +
                          'for permission the first time.',
                      ),
                    );
                }}
              >
                Send my clipboard to this PC
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Text only, up to 256 KB.
              </span>
            </div>

            {/*
              Reading and writing the clipboard is permission-gated in every browser, and
              WOLF never writes to the operator's clipboard on its own — a remote machine
              silently replacing what you copied is not something to do without being asked.
            */}
            {clipboardError ?? view.clipboardNotice ? (
              <div className="notice">{clipboardError ?? view.clipboardNotice}</div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {running ? (
        <Panel title="Live statistics">
          <div className="stack">
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Measured in this browser — what the network did to the stream.
              </div>
              <div className="grid-metrics">
                <Stat label="Frame rate" value={client?.fps === null || client === null ? 'not measured' : `${client.fps.toFixed(1)} fps`} />
                <Stat label="Bitrate" value={megabits(client?.bitrateBps ?? null)} />
                <Stat
                  label="Round trip"
                  value={milliseconds(client?.roundTripMs ?? null)}
                  hint="Time for a packet to get there and back."
                />
                <Stat label="Jitter" value={milliseconds(client?.jitterMs ?? null, 2)} />
                <Stat
                  label="Packet loss"
                  value={
                    client?.packetLossPercent === null || client === null
                      ? 'not measured'
                      : `${client.packetLossPercent.toFixed(2)}%`
                  }
                />
                <Stat
                  label="Decode time"
                  value={milliseconds(client?.decodeMsPerFrame ?? null, 2)}
                  hint="Per frame, in this browser."
                />
              </div>
            </div>

            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Reported by the PC — what it cost to capture and encode.
              </div>
              <div className="grid-metrics">
                <Stat
                  label="Capture rate"
                  value={agent?.fps === null || agent === null ? 'not measured' : `${agent.fps.toFixed(1)} fps`}
                />
                <Stat
                  label="Encode time"
                  value={milliseconds(agent?.encodeMsPerFrame ?? null, 2)}
                  hint="Per frame, on the PC."
                />
                <Stat label="Encoder" value={agent?.encoder ?? 'unknown'} />
                <Stat
                  label="Acceleration"
                  value={
                    agent?.encoderHardware === null || agent === null
                      ? 'unknown'
                      : agent.encoderHardware
                        ? 'hardware'
                        : 'software (costs CPU)'
                  }
                />
                <Stat
                  label="Key frames"
                  value={agent?.keyFramesSent === null || agent === null ? 'not measured' : String(agent.keyFramesSent)}
                />
                <Stat label="Route" value={agent?.route ?? client?.route ?? 'unknown'} />
              </div>
            </div>

            {degraded ? (
              <div className="notice">
                <strong>Running below the requested profile.</strong>
                <div style={{ marginTop: 6 }}>{DEGRADED_REASONS[degraded] ?? degraded}</div>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {/*
        Below the screen rather than beside it, and sharing the stream's view: the terminal
        travels on the same data channel, so it exists only while the stream does. It is
        still its own capability and its own lease — being able to see a screen has never
        meant being allowed to run commands on the machine behind it.
      */}
      <TerminalPanel view={view} />

      {/*
        Files travel on the same data channel, so like the terminal they exist only while the
        stream does — and like the terminal they are their own capability and their own lease.
      */}
      <FilePanel view={view} />
    </div>
  );
}

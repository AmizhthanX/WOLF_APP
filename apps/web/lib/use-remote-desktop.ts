'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { REALTIME_URL, WolfApiError } from './client';
import { getIceServers } from './wolf';
import {
  RemoteDesktopStream,
  type ClipboardEvent,
  type AgentStats,
  type ClientStats,
  type InputControl,
  type InputEvent,
  type StreamAdjustment,
  type StreamError,
  type StreamNegotiation,
  type StreamPhase,
  type StreamProfile,
} from './remote-desktop';

/**
 * One remote desktop stream, tied to a component's lifetime.
 *
 * The stream itself lives in a ref, not in state: re-rendering must not restart a
 * negotiation, and unmounting must stop the capture. That second point is the one that
 * matters — a stream left running after the operator navigates away is a PC still
 * capturing somebody's screen for a viewer who has gone.
 */
export interface RemoteDesktopView {
  readonly phase: StreamPhase;
  readonly detail: string | null;
  readonly negotiation: StreamNegotiation | null;
  readonly agentStats: AgentStats | null;
  readonly clientStats: ClientStats | null;
  readonly error: StreamError | null;
  readonly mediaStream: MediaStream | null;
  readonly adjustments: StreamAdjustment[];
  readonly active: boolean;
  /** Who holds keyboard and mouse control, as the cloud last decided. */
  readonly control: InputControl | null;
  /** Why the stream is running below its profile, or null when it is not. */
  readonly degradedReason: string | null;
  /**
   * The last thing the PC put on its clipboard, waiting for the operator to take it.
   *
   * Held in memory for as long as the panel shows it and no longer. WOLF never writes it to
   * the operator's own clipboard on its own: a remote machine silently replacing what you
   * copied is not something to do without being asked.
   */
  readonly clipboardFromPc: string | null;
  /** Why a clipboard exchange did not happen, when one did not. */
  readonly clipboardNotice: string | null;
  /** Send the operator's clipboard text to the PC. False when the channel is not open. */
  sendClipboard(text: string): boolean;
  /** Forget the offered content, once it has been taken or dismissed. */
  clearClipboard(): void;
  start(profile: StreamProfile, displayId: string | null, requestAudio: boolean): void;
  stop(): void;
  setProfile(profile: StreamProfile): void;
  /** Switch which display is streamed, without restarting. */
  setDisplay(displayId: string | null): void;
  requestControl(): void;
  releaseControl(): void;
  sendInput(events: InputEvent[]): void;
}

export function useRemoteDesktop(pcId: string, sessionToken: string | null): RemoteDesktopView {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [negotiation, setNegotiation] = useState<StreamNegotiation | null>(null);
  const [agentStats, setAgentStats] = useState<AgentStats | null>(null);
  const [clientStats, setClientStats] = useState<ClientStats | null>(null);
  const [error, setError] = useState<StreamError | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [control, setControl] = useState<InputControl | null>(null);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [clipboardFromPc, setClipboardFromPc] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);

  const stream = useRef<RemoteDesktopStream | null>(null);

  const stop = useCallback(() => {
    stream.current?.stop();
    stream.current = null;
    setMediaStream(null);
    setControl(null);
    setDegradedReason(null);

    // Nothing about what was copied outlives the stream.
    setClipboardFromPc(null);
    setClipboardNotice(null);
  }, []);

  // Unmount stops the stream. Without this, navigating away leaves the PC encoding.
  useEffect(() => stop, [stop]);

  const start = useCallback(
    (profile: StreamProfile, displayId: string | null, requestAudio: boolean) => {
      if (!sessionToken || stream.current) return;

      setError(null);
      setNegotiation(null);
      setAgentStats(null);
      setClientStats(null);
      setPhase('authenticating');
      setDetail(null);
      setControl(null);
      setDegradedReason(null);
      setClipboardFromPc(null);
      setClipboardNotice(null);

      void (async () => {
        let iceServers: RTCIceServer[] = [];

        try {
          const configuration = await getIceServers(pcId, sessionToken);
          iceServers = configuration.configuration.iceServers.map((server) => ({
            urls: server.urls,
            username: server.username ?? undefined,
            credential: server.credential ?? undefined,
          }));
        } catch (caught) {
          // Not fatal on a local network, where host candidates are all ICE needs. It is
          // fatal anywhere else, and the connection failure will say so precisely rather
          // than being pre-empted by a guess here.
          if (caught instanceof WolfApiError && caught.problem.httpStatus === 403) {
            setError({
              code: caught.problem.code,
              message: caught.problem.problem,
              limitation: false,
              recommendedAction: caught.problem.recommendedAction,
            });
            setPhase('failed');
            return;
          }
        }

        const started = new RemoteDesktopStream({
          realtimeUrl: REALTIME_URL,
          sessionToken,
          iceServers,
          profile,
          displayId,
          requestAudio,
          events: {
            onPhase: (next, why) => {
              setPhase(next);
              setDetail(why);
            },
            onTrack: setMediaStream,
            onNegotiation: setNegotiation,
            onAgentStats: setAgentStats,
            onClientStats: setClientStats,
            onError: setError,
            onInputControl: setControl,
            onDegraded: setDegradedReason,
            onClipboard: (event: ClipboardEvent) => {
              if (event.kind === 'content') {
                setClipboardFromPc(event.text);
                setClipboardNotice(null);
                return;
              }

              setClipboardNotice(event.detail);
            },
          },
        });

        stream.current = started;
        started.start();
      })();
    },
    [pcId, sessionToken],
  );

  const sendClipboard = useCallback((text: string) => {
    const sent = stream.current?.sendClipboard(text) ?? false;
    if (!sent) setClipboardNotice('The connection to this PC is not ready for clipboard content.');
    return sent;
  }, []);

  const clearClipboard = useCallback(() => {
    setClipboardFromPc(null);
    setClipboardNotice(null);
  }, []);

  const setDisplay = useCallback((displayId: string | null) => {
    stream.current?.setDisplay(displayId);
  }, []);

  const setProfile = useCallback((profile: StreamProfile) => {
    stream.current?.setProfile(profile);
  }, []);

  const requestControl = useCallback(() => stream.current?.requestControl(), []);
  const releaseControl = useCallback(() => stream.current?.releaseControl(), []);
  const sendInput = useCallback((events: InputEvent[]) => stream.current?.sendInput(events), []);

  return {
    phase,
    detail,
    negotiation,
    agentStats,
    clientStats,
    error,
    mediaStream,
    adjustments: negotiation?.adjustments ?? [],
    active: stream.current !== null && phase !== 'stopped' && phase !== 'failed',
    control,
    degradedReason,
    clipboardFromPc,
    clipboardNotice,
    sendClipboard,
    clearClipboard,
    setDisplay,
    start,
    stop,
    setProfile,
    requestControl,
    releaseControl,
    sendInput,
  };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { REALTIME_URL, WolfApiError } from './client';
import { getIceServers } from './wolf';
import {
  FileRefusal,
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
  type StreamSurface,
  type TerminalEvent,
  type TerminalShell,
  type FileChunk,
  type FileInfo,
  type FileListing,
  type FileWritten,
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
  /** Which desktop the frames are coming from. */
  readonly showing: StreamSurface;
  /** Why the secure desktop is showing, when it is. */
  readonly showingReason: string | null;
  /**
   * Who holds the terminal, as the cloud last decided.
   *
   * Its own lease, separate from `control`: holding the keyboard is not the same as being
   * allowed to run commands, and the UI must not offer one because the operator has the
   * other.
   */
  readonly terminalControl: InputControl | null;
  /** Ask for a shell, or give it back. */
  requestTerminal(): void;
  releaseTerminal(): void;
  /** Open a shell and get its id, or null when there is nowhere to send the request. */
  openTerminal(shell: TerminalShell, columns: number, rows: number): string | null;
  sendTerminalInput(terminalId: string, data: string): boolean;
  resizeTerminal(terminalId: string, columns: number, rows: number): void;
  closeTerminal(terminalId: string): void;
  /**
   * Subscribe to what the shells are saying.
   *
   * A subscription rather than state on purpose. Terminal output arrives continuously and in
   * volume; putting it through React state would re-render the whole panel per chunk, and —
   * more to the point — would keep the contents of somebody's terminal in a place that
   * outlives the component. The renderer holds it and nothing else does.
   */
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  /**
   * Who holds this PC's files, as the cloud last decided.
   *
   * Its own lease again. Watching a screen is not being handed the disks behind it.
   */
  readonly fileControl: InputControl | null;
  requestFiles(): void;
  releaseFiles(): void;
  /** Browse. Null lists the drives, which is the root of the tree. */
  listFiles(path: string | null): Promise<FileListing>;
  statFile(path: string): Promise<FileInfo>;
  readFile(path: string, offset: number, length: number): Promise<FileChunk>;
  writeFile(options: {
    transferId: string;
    path: string;
    offset: number;
    bytes: Uint8Array;
    final: boolean;
    overwrite: boolean;
    totalBytes: number;
    fileSha256?: string | null;
  }): Promise<FileWritten>;
  cancelTransfer(transferId: string): Promise<void>;
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
  const [showing, setShowing] = useState<StreamSurface>('desktop');
  const [showingReason, setShowingReason] = useState<string | null>(null);
  const [terminalControl, setTerminalControl] = useState<InputControl | null>(null);
  const [fileControl, setFileControl] = useState<InputControl | null>(null);

  // Held in a ref rather than state: these fire continuously while a shell is producing
  // output, and re-rendering the page for each chunk would make a busy command unusable.
  const terminalListeners = useRef(new Set<(event: TerminalEvent) => void>());
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
            onTerminalControl: setTerminalControl,
            onFileControl: setFileControl,
            onTerminal: (event: TerminalEvent) => {
              for (const listener of terminalListeners.current) listener(event);
            },
            onSurface: (surface, why) => {
              setShowing(surface);
              setShowingReason(why);
            },
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

  const requestTerminal = useCallback(() => stream.current?.requestTerminal(), []);
  const releaseTerminal = useCallback(() => stream.current?.releaseTerminal(), []);

  const openTerminal = useCallback(
    (shell: TerminalShell, columns: number, rows: number) =>
      stream.current?.openTerminal(shell, columns, rows) ?? null,
    [],
  );

  const sendTerminalInput = useCallback(
    (terminalId: string, data: string) =>
      stream.current?.sendTerminalInput(terminalId, data) ?? false,
    [],
  );

  const resizeTerminal = useCallback(
    (terminalId: string, columns: number, rows: number) =>
      stream.current?.resizeTerminal(terminalId, columns, rows),
    [],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => stream.current?.closeTerminal(terminalId),
    [],
  );

  const onTerminalEvent = useCallback((listener: (event: TerminalEvent) => void) => {
    terminalListeners.current.add(listener);
    return () => {
      terminalListeners.current.delete(listener);
    };
  }, []);

  const requestFiles = useCallback(() => stream.current?.requestFiles(), []);
  const releaseFiles = useCallback(() => stream.current?.releaseFiles(), []);

  /**
   * A stream that has gone is the ordinary way these fail.
   *
   * Rejecting with the same error the client uses keeps one shape for the panel to handle,
   * rather than a null it has to remember to check.
   */
  // An interruption, not a refusal: a transfer that meets this can carry on once there is a
  // stream again.
  const noStream = () =>
    Promise.reject(
      new FileRefusal('interrupted', 'There is no connection to this PC right now.', false),
    );

  const listFiles = useCallback(
    (path: string | null) => stream.current?.listFiles(path) ?? noStream(),
    [],
  );

  const statFile = useCallback((path: string) => stream.current?.statFile(path) ?? noStream(), []);

  const readFile = useCallback(
    (path: string, offset: number, length: number) =>
      stream.current?.readFile(path, offset, length) ?? noStream(),
    [],
  );

  const writeFile = useCallback(
    (options: {
      transferId: string;
      path: string;
      offset: number;
      bytes: Uint8Array;
      final: boolean;
      overwrite: boolean;
      totalBytes: number;
      fileSha256?: string | null;
    }) => stream.current?.writeFile(options) ?? noStream(),
    [],
  );

  const cancelTransfer = useCallback(
    (transferId: string) => stream.current?.cancelTransfer(transferId) ?? Promise.resolve(),
    [],
  );

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
    showing,
    showingReason,
    terminalControl,
    requestTerminal,
    releaseTerminal,
    openTerminal,
    sendTerminalInput,
    resizeTerminal,
    closeTerminal,
    onTerminalEvent,
    fileControl,
    requestFiles,
    releaseFiles,
    listFiles,
    statFile,
    readFile,
    writeFile,
    cancelTransfer,
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

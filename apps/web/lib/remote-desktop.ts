'use client';

import { newId } from '@wolf/shared-types';

/**
 * The browser half of a remote desktop stream.
 *
 * Deliberately not a React hook. Everything here is a state machine over a WebSocket and an
 * `RTCPeerConnection`, and both of those outlive any render: a component that re-mounts
 * must not tear down a live stream, and a stream must not survive the session that
 * authorised it. Keeping the machine separate makes both of those explicit, and lets the
 * negotiation be tested without a DOM.
 *
 * The agent is the offerer. This side answers, because the agent is the only one that knows
 * which encoder the PC actually has and at what profile and level it is producing pictures.
 */

const PROTOCOL_VERSION = 1;

/**
 * The largest clipboard payload WOLF will carry, matching the protocol.
 *
 * Checked here as well as at the far end so an oversized paste is refused before it is sent
 * rather than after, which is the difference between a message and a wasted round trip.
 */
const MAX_CLIPBOARD_TEXT = 256 * 1024;

/**
 * How often to renew the control lease.
 *
 * Comfortably inside the two minutes the cloud grants, so a slow round trip or a missed
 * renewal does not drop control mid-sentence.
 */
const RENEW_INTERVAL_MS = 45_000;

/** The protocol's ceiling on one batch. */
const MAX_EVENTS_PER_BATCH = 128;

export type StreamPhase =
  | 'idle'
  | 'authenticating'
  | 'requesting'
  | 'negotiating'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

/**
 * Levers the operator has taken away from adaptation.
 *
 * Null means "let it adapt". Pinning one lever does not pin the others: holding the
 * resolution so text stays readable while the frame rate does whatever the link forces is
 * the case this exists for.
 */
export interface QualityOverrides {
  bitrateBps: number | null;
  frameRate: number | null;
  resolutionScale: number | null;
}

export const NO_OVERRIDES: QualityOverrides = {
  bitrateBps: null,
  frameRate: null,
  resolutionScale: null,
};

export interface StreamProfile {
  name: string;
  maxWidthPixels: number | null;
  maxHeightPixels: number | null;
  targetFps: number;
  minBitrateBps: number;
  maxBitrateBps: number;
  codecPreference: string[];
  audioEnabled: boolean;
  qualityBias: 'quality' | 'balanced' | 'performance';
  adaptive: boolean;
  overrides: QualityOverrides;
}

export interface StreamAdjustment {
  setting: string;
  requested: string;
  applied: string;
  reason: string;
}

/**
 * Which desktop's pixels are on the track, mirroring `packages/protocol`.
 *
 * A running stream switches between them without renegotiating: when the screen locks, the
 * frames start coming from a host on the Winlogon desktop and go out on the connection that
 * is already open.
 */
export type StreamSurface = 'desktop' | 'secure-desktop';

/** Shells WOLF will start, mirroring `packages/protocol`. Names, never paths. */
export type TerminalShell = 'cmd' | 'powershell' | 'pwsh';

/** Matches the protocol's per-message cap on terminal traffic. */
export const MAX_TERMINAL_CHUNK = 64 * 1024;

/** Matches the protocol's per-message cap on file traffic. */
export const MAX_FILE_CHUNK = 64 * 1024;

/** One thing in a directory on the PC, mirroring `packages/protocol`. */
export interface FileEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'drive';
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
  readonly readOnly: boolean;
  readonly hidden: boolean;
  /** True for a symlink or junction — a folder that is really somewhere else. */
  readonly reparse: boolean;
  readonly protectedLocation: boolean;
  /** Present on drives, where the name is a label rather than a path. */
  readonly path?: string;
}

export interface FileListing {
  readonly path: string | null;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}

export interface FileInfo {
  readonly path: string;
  readonly entry: FileEntry | null;
  /** Bytes already written to a partial upload here, or null when there is none. */
  readonly partialBytes: number | null;
}

export interface FileChunk {
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
  readonly totalBytes: number;
}

/** A change to make on the PC. */
export type FileChange =
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string; readonly newName: string }
  | { readonly kind: 'move'; readonly path: string; readonly destinationFolder: string }
  | { readonly kind: 'create-folder'; readonly path: string };

export interface FileWritten {
  readonly bytesWritten: number;
  readonly sha256: string | null;
  readonly complete: boolean;
}

/**
 * A refusal from the PC, as an error the caller can catch.
 *
 * Thrown rather than returned because every one of these ends a transfer, and a caller that
 * forgot to check a returned status would carry on sending chunks into a file that is not
 * being written.
 */
export class FileRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly limitation: boolean,
  ) {
    super(message);
    this.name = 'FileRefusal';
  }
}

/** Something the PC said about a shell. */
export interface TerminalEvent {
  readonly kind: 'opened' | 'output' | 'exited' | 'refused';
  readonly terminalId: string;
  readonly shell: string | null;
  readonly processId: number | null;
  /** Only for `output`, and only ever handed straight to the renderer. */
  readonly data: string | null;
  readonly detail: string | null;
  /** True when the PC is saying Windows cannot, rather than WOLF will not. */
  readonly limitation: boolean;
}

export interface StreamNegotiation {
  streamId: string;
  display: {
    id: string;
    name: string;
    widthPixels: number;
    heightPixels: number;
    refreshHz: number | null;
    primary: boolean;
    scaleFactor: number | null;
  };
  videoCodec: string;
  hardwareEncoded: boolean;
  audioCodec: string | null;
  effectiveProfile: StreamProfile;
  adjustments: StreamAdjustment[];
  startedAt: string;
}

/** What the agent reports about itself. Nulls mean "not measured", never zero. */
export interface AgentStats {
  state: string;
  route: 'lan' | 'p2p' | 'relay' | null;
  fps: number | null;
  widthPixels: number | null;
  heightPixels: number | null;
  keyFramesSent: number | null;
  encoder: string | null;
  encoderHardware: boolean | null;
  encodeMsPerFrame: number | null;
  degradedReason: string | null;
}

/**
 * What this browser can measure that the agent cannot.
 *
 * Round-trip time, jitter, and loss are properties of the path, and only the receiving end
 * sees them. The agent reports them as null; these come from `RTCPeerConnection.getStats()`
 * and are the numbers that actually answer "why is this laggy".
 */
export interface ClientStats {
  fps: number | null;
  bitrateBps: number | null;
  widthPixels: number | null;
  heightPixels: number | null;
  roundTripMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  packetLossPercent: number | null;
  framesDropped: number | null;
  decodeMsPerFrame: number | null;
  /** Candidate pair actually carrying the media, as the browser sees it. */
  route: 'lan' | 'p2p' | 'relay' | null;
  codec: string | null;
}

export interface StreamError {
  code: string;
  message: string;
  limitation: boolean;
  recommendedAction: string | null;
}

/** One input event, in the shape `packages/protocol/src/input.ts` defines. */
export type InputEvent =
  | { type: 'pointer.move'; x: number; y: number; offsetMs: number }
  | {
      type: 'pointer.button';
      button: string;
      action: 'down' | 'up';
      x: number;
      y: number;
      offsetMs: number;
    }
  | {
      type: 'pointer.scroll';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      offsetMs: number;
    }
  | {
      type: 'key';
      key: number;
      action: 'down' | 'up';
      scanCode: number | null;
      extended: boolean;
      offsetMs: number;
    }
  | { type: 'text'; value: string; offsetMs: number }
  | { type: 'system.combo'; combo: string; offsetMs: number };

/**
 * Who holds keyboard and mouse control, as the cloud decided it.
 *
 * `expiresAt` is why this is not a boolean: the grant lapses, and a client that stopped
 * renewing has to stop believing it can drive.
 */
export interface InputControl {
  granted: boolean;
  holderSessionId: string | null;
  expiresAt: string | null;
  reason: string | null;
}

/** Clipboard content the PC offered, or a reason it could not be exchanged. */
export interface ClipboardEvent {
  readonly kind: 'content' | 'refused' | 'unsupported';
  /** Present only for `content`. Never persisted anywhere by WOLF. */
  readonly text: string | null;
  /** Present for `refused` and `unsupported`. */
  readonly detail: string | null;
}

export interface StreamEvents {
  onPhase(phase: StreamPhase, detail: string | null): void;
  onTrack(stream: MediaStream): void;
  onNegotiation(negotiation: StreamNegotiation): void;
  onAgentStats(stats: AgentStats): void;
  onClientStats(stats: ClientStats): void;
  onError(error: StreamError): void;
  onInputControl(control: InputControl): void;
  /** The reason the stream is running below its profile, or null when it is not. */
  onDegraded(reason: string | null): void;
  /** Who holds the terminal, as the cloud last decided. */
  onTerminalControl(control: InputControl): void;
  /** Who holds this PC's files, as the cloud last decided. */
  onFileControl(control: InputControl): void;
  /**
   * Something a shell said, or something the PC refused to do with one.
   *
   * Output arrives here and goes straight to the renderer. It is never stored, never sent
   * anywhere, and never logged — one line of it is somebody's connection string.
   */
  onTerminal(event: TerminalEvent): void;
  /**
   * Which desktop the frames are coming from, whenever it changes.
   *
   * The operator has to be told when the picture becomes their own lock screen: what they
   * type there goes to the lock screen, and system combinations are refused on it. The
   * stream itself does not stop or restart, so nothing else would say so.
   */
  onSurface(surface: StreamSurface, detail: string | null): void;
  /** Something happened to the clipboard: content arrived, or an exchange was refused. */
  onClipboard(event: ClipboardEvent): void;
}

export interface StreamOptions {
  realtimeUrl: string;
  sessionToken: string;
  iceServers: RTCIceServer[];
  profile: StreamProfile;
  displayId: string | null;
  /**
   * Whether to ask the PC for its sound.
   *
   * Off unless the operator turned it on. Listening to somebody's machine is not something
   * to start doing because a stream happened to begin.
   */
  requestAudio: boolean;
  events: StreamEvents;
}

/**
 * The H.264 profiles this browser says it decodes, in the names the PC chooses between.
 *
 * Without this the PC encodes High profile for every browser, and a browser that decodes only Constrained Baseline —
 * Firefox's OpenH264, some Windows editions without media codecs — answers with the video refused, which reached the
 * owner as "The client's answer could not be used: VideoIncompatible". The Android client already said which
 * profiles it decodes; the dashboard now does the same, from `RTCRtpReceiver.getCapabilities`.
 *
 * A decoder for a profile also decodes the simpler ones: High covers Main and Constrained Baseline, Main covers
 * Constrained Baseline. `profile-level-id` starts with the profile: 64 High, 4d Main, 42 Baseline family. Null when
 * the browser does not say, so the PC keeps its default rather than being told "none".
 */
export function decodableH264Profiles(
  codecs: readonly { mimeType: string; sdpFmtpLine?: string }[] | null = typeof RTCRtpReceiver !== 'undefined' &&
  RTCRtpReceiver.getCapabilities
    ? (RTCRtpReceiver.getCapabilities('video')?.codecs ?? null)
    : null,
): string[] | null {
  if (!codecs) return null;

  const accepted = new Set<string>();
  for (const codec of codecs) {
    if (codec.mimeType.toLowerCase() !== 'video/h264') continue;
    const match = /profile-level-id=([0-9a-f]{2})/i.exec(codec.sdpFmtpLine ?? '');
    switch (match?.[1]?.toLowerCase()) {
      case '64':
        accepted.add('high').add('main').add('constrained-baseline');
        break;
      case '4d':
        accepted.add('main').add('constrained-baseline');
        break;
      case '42':
        accepted.add('constrained-baseline');
        break;
    }
  }

  if (accepted.size === 0) return null;
  return ['high', 'main', 'constrained-baseline'].filter((profile) => accepted.has(profile));
}

/** Codecs this browser can actually decode, in WOLF's preference order. */
export function decodableCodecs(): string[] {
  const capabilities =
    typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
      ? RTCRtpReceiver.getCapabilities('video')
      : null;

  if (!capabilities) {
    // Every browser that implements WebRTC at all is required to decode H.264, so this is
    // a floor rather than a guess. Claiming more than this without evidence would produce
    // a negotiated stream the browser cannot render.
    return ['h264'];
  }

  const names = new Set(
    capabilities.codecs.map((codec) => codec.mimeType.split('/')[1]?.toLowerCase() ?? ''),
  );

  const wanted: [string, string][] = [
    ['av1', 'av1'],
    ['h265', 'h265'],
    ['h264', 'h264'],
    ['vp9', 'vp9'],
    ['vp8', 'vp8'],
  ];

  const found = wanted.filter(([, mime]) => names.has(mime)).map(([name]) => name);
  return found.length > 0 ? found : ['h264'];
}

export class RemoteDesktopStream {
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private terminalRenewTimer: ReturnType<typeof setInterval> | null = null;
  private hasTerminal = false;
  private fileRenewTimer: ReturnType<typeof setInterval> | null = null;
  private hasFiles = false;

  /**
   * File requests waiting for their answer.
   *
   * Files are request/response, unlike everything else on this channel: a listing is asked
   * for and arrives once. Correlating by id rather than by order matters because a browse and
   * a transfer chunk can be in flight together, and a client that assumed order would hand
   * one the other's answer.
   */
  private readonly pendingFiles = new Map<
    string,
    { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  private readonly options: StreamOptions;
  private readonly streamId = newId();

  private sessionId: string | null = null;
  private phase: StreamPhase = 'idle';
  private profile: StreamProfile;
  private closed = false;
  private hasControl = false;
  private sequence = 0;

  /** Previous sample, so rates can be derived rather than reported as totals. */
  private lastSample: { at: number; bytes: number; frames: number; decodeMs: number } | null = null;

  constructor(options: StreamOptions) {
    this.options = options;
    this.profile = options.profile;
  }

  get id(): string {
    return this.streamId;
  }

  start(): void {
    this.setPhase('authenticating', null);

    const socket = new WebSocket(`${this.options.realtimeUrl.replace(/\/+$/, '')}/client`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.send({
        kind: 'client.auth',
        protocolVersion: PROTOCOL_VERSION,
        sessionToken: this.options.sessionToken,
      });
    });

    socket.addEventListener('message', (event) => {
      void this.handle(String(event.data));
    });

    socket.addEventListener('error', () => {
      // The close handler carries the useful detail; this fires first and says nothing.
    });

    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.setPhase('failed', 'The connection to WOLF closed.');
      this.teardownPeer();
    });
  }

  /**
   * Ask for keyboard and mouse control.
   *
   * The cloud decides and answers with `input.control`; nothing here assumes the answer.
   * The request repeats on a timer while control is held, because the grant expires — an
   * operator who closes the laptop stops holding somebody else's keyboard.
   */
  requestControl(): void {
    this.signal({ type: 'input.request' });

    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => {
      if (this.hasControl) this.signal({ type: 'input.request' });
    }, RENEW_INTERVAL_MS);
  }

  releaseControl(): void {
    this.stopRenewing();
    this.signal({ type: 'input.release' });
  }

  /**
   * Ask to be allowed a shell on the PC.
   *
   * Its own lease, arbitrated by the cloud like keyboard control and renewed the same way.
   * It is a separate ask from `requestControl` on purpose: holding the keyboard is not the
   * same as being allowed to run commands, and an operator who wanted one should not
   * silently acquire the other.
   */
  requestTerminal(): void {
    this.signal({ type: 'terminal.request' });

    if (this.terminalRenewTimer) return;
    this.terminalRenewTimer = setInterval(() => {
      if (this.hasTerminal) this.signal({ type: 'terminal.request' });
    }, RENEW_INTERVAL_MS);
  }

  releaseTerminal(): void {
    this.stopRenewingTerminal();
    this.hasTerminal = false;
    this.signal({ type: 'terminal.release' });
  }

  /** Whether this session currently holds the terminal lease. */
  get holdsTerminal(): boolean {
    return this.hasTerminal;
  }

  /**
   * Open a shell on the PC, and get an id back to address it with.
   *
   * Returns null when there is nowhere to send the request — no lease, or a data channel
   * that is not open. Null rather than a thrown error because "not yet" is the ordinary
   * state of this for the first second of a stream.
   */
  openTerminal(shell: TerminalShell, columns: number, rows: number): string | null {
    if (!this.hasTerminal) return null;
    if (this.control?.readyState !== 'open') return null;

    const terminalId = newId();

    this.control.send(
      JSON.stringify({
        kind: 'terminal.open',
        streamId: this.streamId,
        terminalId,
        shell,
        columns,
        rows,
        workingDirectory: null,
      }),
    );

    return terminalId;
  }

  /**
   * Type into a shell.
   *
   * On the data channel, never through the cloud — the same reason as the clipboard and a
   * stronger one. What is typed into a terminal, and what it prints back, routinely contains
   * secrets nobody meant to disclose. Content that never reaches a server cannot be stored
   * by one.
   */
  sendTerminalInput(terminalId: string, data: string): boolean {
    if (!this.hasTerminal) return false;
    if (this.control?.readyState !== 'open') return false;
    if (data.length > MAX_TERMINAL_CHUNK) return false;

    this.control.send(JSON.stringify({ kind: 'terminal.input', terminalId, data }));
    return true;
  }

  /** Tell the shell the viewer is a different size, so its own wrapping matches. */
  resizeTerminal(terminalId: string, columns: number, rows: number): void {
    if (this.control?.readyState !== 'open') return;
    this.control.send(JSON.stringify({ kind: 'terminal.resize', terminalId, columns, rows }));
  }

  closeTerminal(terminalId: string): void {
    if (this.control?.readyState !== 'open') return;
    this.control.send(JSON.stringify({ kind: 'terminal.close', terminalId }));
  }

  /**
   * Ask to be allowed at this PC's files.
   *
   * Its own lease again, and asked for separately: watching a screen is not being handed the
   * disks behind it.
   */
  requestFiles(): void {
    this.signal({ type: 'file.request' });

    if (this.fileRenewTimer) return;
    this.fileRenewTimer = setInterval(() => {
      if (this.hasFiles) this.signal({ type: 'file.request' });
    }, RENEW_INTERVAL_MS);
  }

  releaseFiles(): void {
    this.stopRenewingFiles();
    this.hasFiles = false;
    this.signal({ type: 'file.release' });
  }

  /** Whether this session currently holds the file lease. */
  get holdsFiles(): boolean {
    return this.hasFiles;
  }

  /** List a folder, or the PC's drives when `path` is null. */
  async listFiles(path: string | null): Promise<FileListing> {
    const answer = await this.askFiles({ kind: 'file.list', path });

    return {
      path: (answer['path'] as string | null) ?? null,
      entries: (answer['entries'] as FileEntry[] | undefined) ?? [],
      truncated: answer['truncated'] === true,
    };
  }

  /** What is at a path, and how far a partial upload there got. */
  async statFile(path: string): Promise<FileInfo> {
    const answer = await this.askFiles({ kind: 'file.stat', path });

    return {
      path: String(answer['path'] ?? path),
      entry: (answer['entry'] as FileEntry | null) ?? null,
      partialBytes: (answer['partialBytes'] as number | null) ?? null,
    };
  }

  /**
   * Read one chunk of a file.
   *
   * The checksum is verified here rather than trusted. A byte that arrives wrong is caught
   * where it happened, instead of as a file that turns out to be broken a week later — and
   * this is the end that can retry.
   */
  async readFile(path: string, offset: number, length: number): Promise<FileChunk> {
    const answer = await this.askFiles({
      kind: 'file.read',
      path,
      offset,
      length: Math.min(length, MAX_FILE_CHUNK),
    });

    const bytes = decodeBase64(String(answer['data'] ?? ''));
    const digest = await sha256Hex(bytes);

    if (digest !== String(answer['sha256'])) {
      throw new FileRefusal(
        'corrupt',
        'A chunk of that file arrived with the wrong checksum and was discarded.',
        false,
      );
    }

    return {
      offset: Number(answer['offset'] ?? offset),
      bytes,
      eof: answer['eof'] === true,
      totalBytes: Number(answer['totalBytes'] ?? 0),
    };
  }

  /** Write one chunk to the PC. The checksum goes with it so the far end can check. */
  async writeFile(options: {
    transferId: string;
    path: string;
    offset: number;
    bytes: Uint8Array;
    final: boolean;
    overwrite: boolean;
    totalBytes: number;
    /** On the final chunk: SHA-256 of the whole file, so a mismatch is never put in place. */
    fileSha256?: string | null;
  }): Promise<FileWritten> {
    const answer = await this.askFiles({
      kind: 'file.write',
      transferId: options.transferId,
      path: options.path,
      offset: options.offset,
      data: encodeBase64(options.bytes),
      sha256: await sha256Hex(options.bytes),
      final: options.final,
      overwrite: options.overwrite,
      totalBytes: options.totalBytes,
      fileSha256: options.fileSha256 ?? null,
    });

    return {
      bytesWritten: Number(answer['bytesWritten'] ?? 0),
      sha256: (answer['sha256'] as string | null) ?? null,
      complete: answer['complete'] === true,
    };
  }

  /**
   * Stop a transfer. The part file on the PC goes with it.
   *
   * Only for a transfer somebody decided to stop. One the connection interrupted is left alone,
   * and its part file waits on the PC to be resumed.
   */
  async cancelTransfer(transferId: string): Promise<void> {
    await this.askFiles({ kind: 'file.cancel', transferId });
  }

  /**
   * Change something on the PC: to the Recycle Bin, a new name, another folder on the same drive, or a new
   * folder. Resolves when the PC has done it; a refusal is thrown with the PC's words. The PC tells the cloud
   * that it happened, never what it was called.
   */
  async changeFile(change: FileChange): Promise<void> {
    switch (change.kind) {
      case 'delete':
        await this.askFiles({ kind: 'file.delete', path: change.path });
        return;
      case 'rename':
        await this.askFiles({ kind: 'file.rename', path: change.path, newName: change.newName });
        return;
      case 'move':
        await this.askFiles({ kind: 'file.move', path: change.path, destinationFolder: change.destinationFolder });
        return;
      case 'create-folder':
        await this.askFiles({ kind: 'file.create-folder', path: change.path });
        return;
    }
  }

  /**
   * Send one file request and wait for the answer with the matching id.
   *
   * Refusals arrive as rejections, so a caller that forgot to check cannot carry on sending
   * chunks into a file that is not being written.
   */
  private askFiles(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.hasFiles) {
      return Promise.reject(
        new FileRefusal('not-permitted', 'This session does not hold this PC\'s files.', false),
      );
    }

    if (this.control?.readyState !== 'open') {
      return Promise.reject(
        new FileRefusal('interrupted', 'The connection to this PC is not ready.', false),
      );
    }

    const requestId = newId();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingFiles.set(requestId, { resolve, reject });
      this.control!.send(JSON.stringify({ ...message, requestId }));
    });
  }

  private stopRenewingFiles(): void {
    if (this.fileRenewTimer) {
      clearInterval(this.fileRenewTimer);
      this.fileRenewTimer = null;
    }
  }

  /**
   * Send input events to the PC.
   *
   * Straight down the data channel, never through the cloud: a keystroke that took a
   * round trip through a server before reaching the machine would feel like a machine that
   * is thinking about it.
   */
  sendInput(events: InputEvent[]): void {
    if (events.length === 0) return;
    if (!this.hasControl) return;
    if (this.control?.readyState !== 'open') return;

    this.control.send(
      JSON.stringify({
        kind: 'input',
        batch: {
          streamId: this.streamId,
          sequence: this.sequence++,
          sentAt: new Date().toISOString(),
          // Bounded here as well as at the far end, so a burst of pointer movement cannot
          // produce a batch the host is obliged to reject whole.
          events: events.slice(0, MAX_EVENTS_PER_BATCH),
        },
      }),
    );
  }

  /**
   * Send clipboard text to the PC.
   *
   * On the data channel, never through the cloud. That is the whole reason WOLF can promise
   * it does not store what you copied: the content never reaches a server that could.
   */
  sendClipboard(text: string): boolean {
    if (this.control?.readyState !== 'open') return false;
    if (text.length > MAX_CLIPBOARD_TEXT) return false;

    this.control.send(
      JSON.stringify({
        kind: 'clipboard.content',
        streamId: this.streamId,
        format: 'text',
        text,
        origin: 'client',
        at: new Date().toISOString(),
      }),
    );

    return true;
  }

  /** Stop renewing the input lease. Losing the keyboard says nothing about the terminal. */
  private stopRenewing(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  private stopRenewingTerminal(): void {
    if (this.terminalRenewTimer) {
      clearInterval(this.terminalRenewTimer);
      this.terminalRenewTimer = null;
    }
  }

  /**
   * Stop asking for anything, for a stream that is going away.
   *
   * Both leases, which is the point: they renew on separate timers because they are separate
   * grants, and a stream that stopped while still renewing one would keep asking the cloud
   * for a shell on a PC nobody is looking at, for as long as the tab stayed open. Found by
   * the test suite hanging, which is the harmless version of the same bug.
   */
  private stopAllRenewing(): void {
    this.stopRenewing();
    this.stopRenewingTerminal();
    this.stopRenewingFiles();

    // Nothing is coming back for these. Left hanging they would be promises the caller awaits
    // forever, which is a file manager that shows a spinner until the tab is closed.
    for (const pending of this.pendingFiles.values()) {
      // "interrupted", not "failed": nothing on the PC went wrong, and a transfer can carry on
      // from where it was once there is a connection again.
      pending.reject(new FileRefusal('interrupted', 'The connection to this PC ended.', false));
    }
    this.pendingFiles.clear();
  }

  /**
   * Change the profile on a running stream.
   *
   * The agent answers with what it could actually apply, so nothing here assumes the change
   * took effect.
   */
  setProfile(profile: StreamProfile): void {
    this.profile = profile;
    this.signal({ type: 'stream.set-profile', profile });
  }

  /**
   * Look at a different display on the same PC.
   *
   * Switched in place rather than by restarting: tearing the stream down would cost a fresh
   * negotiation and several seconds of black screen. The agent answers with a new
   * `stream.ready`, so the panel's labels follow whatever it actually switched to.
   */
  setDisplay(displayId: string | null): void {
    this.signal({ type: 'stream.set-display', displayId });
  }

  stop(reason: 'client-closed' | 'session-ended' = 'client-closed'): void {
    if (this.closed) return;
    this.closed = true;

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.signal({ type: 'stream.stop', reason, detail: null });
    }

    this.stopAllRenewing();
    this.teardownPeer();
    this.socket?.close();
    this.socket = null;
    this.setPhase('stopped', null);
  }

  // -------------------------------------------------------------------------
  // Signaling
  // -------------------------------------------------------------------------

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private signal(payload: Record<string, unknown>): void {
    if (!this.sessionId) return;

    this.send({
      kind: 'client.signal',
      protocolVersion: PROTOCOL_VERSION,
      envelope: {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        streamId: this.streamId,
        sentAt: new Date().toISOString(),
        payload,
      },
    });
  }

  private async handle(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (message['kind']) {
      case 'cloud.client-auth-accepted': {
        this.sessionId = String(message['sessionId']);

        if (message['agentConnected'] === false) {
          this.fail(
            'agent-offline',
            'This PC is not connected to WOLF right now.',
            true,
            'The stream starts on its own once the PC is back online.',
          );
          return;
        }

        this.setPhase('requesting', null);
        this.signal({
          type: 'stream.request',
          request: {
            displayId: this.options.displayId,
            profile: this.profile,
            clientCodecs: decodableCodecs(),
            requestAudio: this.options.requestAudio,
            ...(decodableH264Profiles() ? { h264Profiles: decodableH264Profiles() } : {}),
          },
        });
        return;
      }

      case 'cloud.client-auth-rejected': {
        this.fail(
          String(message['reason'] ?? 'rejected'),
          String(message['detail'] ?? 'WOLF refused the streaming session.'),
          false,
          'Reload the page to open a new session.',
        );
        return;
      }

      case 'cloud.peer-gone': {
        this.fail(
          String(message['reason'] ?? 'peer-gone'),
          String(message['detail'] ?? 'The PC stopped responding.'),
          true,
          'The stream can be started again once the PC is back.',
        );
        return;
      }

      case 'cloud.signal': {
        const envelope = message['envelope'] as { streamId?: string; payload?: Record<string, unknown> };

        // Signaling for another stream in the same session is not ours to act on.
        if (envelope?.streamId !== this.streamId) return;
        await this.handleSignal(envelope.payload ?? {});
        return;
      }

      default:
        return;
    }
  }

  private async handleSignal(payload: Record<string, unknown>): Promise<void> {
    switch (payload['type']) {
      case 'stream.ready': {
        const negotiation = payload['negotiation'] as StreamNegotiation;
        this.setPhase('negotiating', null);
        this.options.events.onNegotiation(negotiation);
        return;
      }

      case 'sdp.offer': {
        await this.answer(String(payload['sdp']));
        return;
      }

      case 'ice.candidate': {
        try {
          await this.peer?.addIceCandidate({
            candidate: String(payload['candidate']),
            sdpMid: (payload['sdpMid'] as string | null) ?? undefined,
            sdpMLineIndex: (payload['sdpMLineIndex'] as number | null) ?? undefined,
          });
        } catch {
          // One unusable candidate is not fatal; ICE tries every other pair.
        }
        return;
      }

      case 'ice.complete':
        return;

      case 'input.control': {
        this.hasControl = payload['granted'] === true;
        if (!this.hasControl) this.stopRenewing();

        this.options.events.onInputControl({
          granted: this.hasControl,
          holderSessionId: (payload['holderSessionId'] as string | null) ?? null,
          expiresAt: (payload['expiresAt'] as string | null) ?? null,
          reason: (payload['reason'] as string | null) ?? null,
        });
        return;
      }

      case 'terminal.control': {
        this.hasTerminal = payload['granted'] === true;

        if (!this.hasTerminal) this.stopRenewingTerminal();

        this.options.events.onTerminalControl({
          granted: this.hasTerminal,
          holderSessionId: (payload['holderSessionId'] as string | null) ?? null,
          expiresAt: (payload['expiresAt'] as string | null) ?? null,
          reason: (payload['reason'] as string | null) ?? null,
        });
        return;
      }

      case 'file.control': {
        this.hasFiles = payload['granted'] === true;
        if (!this.hasFiles) this.stopRenewingFiles();

        this.options.events.onFileControl({
          granted: this.hasFiles,
          holderSessionId: (payload['holderSessionId'] as string | null) ?? null,
          expiresAt: (payload['expiresAt'] as string | null) ?? null,
          reason: (payload['reason'] as string | null) ?? null,
        });
        return;
      }

      case 'stream.state': {
        const state = String(payload['state']);
        const detail = (payload['detail'] as string | null) ?? null;

        // Absent from an agent that predates the field, and read as the ordinary desktop —
        // which is what such an agent can only ever be showing.
        const showing: StreamSurface =
          payload['showing'] === 'secure-desktop' ? 'secure-desktop' : 'desktop';
        this.options.events.onSurface(showing, showing === 'desktop' ? null : detail);

        if (state === 'STREAMING') this.setPhase('streaming', null);
        else if (state === 'RECONNECTING') this.setPhase('reconnecting', detail);
        else if (state === 'OFFLINE') this.setPhase('stopped', detail);
        else if (state === 'DEGRADED') {
          // Still streaming — the picture is arriving, just below the profile that was
          // asked for. Reporting it as a fault would be wrong; reporting nothing would
          // leave the operator wondering why it looks soft.
          this.setPhase('streaming', null);
          this.options.events.onDegraded(detail);
        }

        // A state change back to streaming clears any standing degradation.
        if (state === 'STREAMING') this.options.events.onDegraded(null);
        return;
      }

      case 'stream.stats': {
        const stats = payload['stats'] as Record<string, unknown>;
        this.options.events.onAgentStats({
          state: String(stats['state']),
          route: (stats['route'] as AgentStats['route']) ?? null,
          fps: (stats['fps'] as number | null) ?? null,
          widthPixels: (stats['widthPixels'] as number | null) ?? null,
          heightPixels: (stats['heightPixels'] as number | null) ?? null,
          keyFramesSent: (stats['keyFramesSent'] as number | null) ?? null,
          encoder: (stats['encoder'] as string | null) ?? null,
          encoderHardware: (stats['encoderHardware'] as boolean | null) ?? null,
          encodeMsPerFrame: (stats['encodeMsPerFrame'] as number | null) ?? null,
          degradedReason: (stats['degradedReason'] as string | null) ?? null,
        });
        return;
      }

      case 'stream.stop': {
        this.setPhase('stopped', (payload['detail'] as string | null) ?? null);
        this.teardownPeer();
        return;
      }

      case 'stream.error': {
        this.options.events.onError({
          code: String(payload['code']),
          message: String(payload['message']),
          limitation: payload['limitation'] === true,
          recommendedAction: (payload['recommendedAction'] as string | null) ?? null,
        });

        // An error that arrives before there is a peer connection ended the attempt; one
        // that arrives during a running stream is a report about it, not the end of it.
        if (!this.peer) this.setPhase('failed', String(payload['message']));
        return;
      }

      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Peer connection
  // -------------------------------------------------------------------------

  private async answer(sdp: string): Promise<void> {
    this.setPhase('connecting', null);

    const peer = new RTCPeerConnection({
      iceServers: this.options.iceServers,
      // "all" so a host candidate can win on a LAN. Forcing relay is a diagnostic.
      iceTransportPolicy: 'all',
    });
    this.peer = peer;

    peer.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) this.options.events.onTrack(stream);
    });

    // The agent opens the control channel as part of its offer, so this side receives it
    // rather than creating one — a channel added here would need a second negotiation.
    peer.addEventListener('datachannel', (event) => {
      this.control = event.channel;
      this.control.addEventListener('message', (message) => {
        this.handleControlMessage(String(message.data));
      });
    });

    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.signal({
          type: 'ice.candidate',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment ?? null,
        });
      } else {
        this.signal({ type: 'ice.complete' });
      }
    });

    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') {
        this.fail(
          'ice-failed',
          'The direct connection to this PC could not be established.',
          false,
          'On a different network this needs a TURN relay; configure one and try again.',
        );
      } else if (peer.connectionState === 'disconnected') {
        this.setPhase('reconnecting', 'The connection to the PC dropped.');
      }
    });

    await peer.setRemoteDescription({ type: 'offer', sdp });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    this.signal({ type: 'sdp.answer', sdp: answer.sdp ?? '' });
    this.startStatsPolling();
  }

  /**
   * Whatever the PC sent back on the data channel.
   *
   * Discriminated on `kind` rather than by which fields are present: this channel carries
   * input rejections and clipboard content, and telling them apart by guessing would let a
   * malformed message of one sort be read as the other.
   */
  private handleControlMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (message['kind']) {
      case 'input.response':
        this.handleInputResponse(message['response'] as Record<string, unknown> | undefined);
        return;

      case 'clipboard.content':
        // Handed to the UI and nowhere else. It is not stored, not logged, and does not
        // touch the operator's own clipboard until they ask for it.
        this.options.events.onClipboard({
          kind: 'content',
          text: String(message['text'] ?? ''),
          detail: null,
        });
        return;

      case 'clipboard.refused':
        this.options.events.onClipboard({
          kind: 'refused',
          text: null,
          detail: String(message['detail'] ?? 'The PC would not take that clipboard content.'),
        });
        return;

      case 'clipboard.unsupported':
        this.options.events.onClipboard({
          kind: 'unsupported',
          text: null,
          detail: `The PC's clipboard holds ${String(message['describes'] ?? 'something')}, which WOLF does not carry.`,
        });
        return;

      case 'terminal.opened':
        this.options.events.onTerminal({
          kind: 'opened',
          terminalId: String(message['terminalId'] ?? ''),
          shell: String(message['shell'] ?? ''),
          processId: Number(message['processId'] ?? 0),
          data: null,
          detail: null,
          limitation: false,
        });
        return;

      case 'terminal.output':
        // Handed to the renderer and nowhere else. Not stored, not sent anywhere, not
        // logged: this is the contents of somebody's terminal.
        this.options.events.onTerminal({
          kind: 'output',
          terminalId: String(message['terminalId'] ?? ''),
          shell: null,
          processId: null,
          data: String(message['data'] ?? ''),
          detail: null,
          limitation: false,
        });
        return;

      case 'terminal.exited':
        this.options.events.onTerminal({
          kind: 'exited',
          terminalId: String(message['terminalId'] ?? ''),
          shell: null,
          processId: null,
          data: null,
          detail:
            message['exitCode'] === null || message['exitCode'] === undefined
              ? `The shell ended (${String(message['reason'] ?? 'exited')}).`
              : `The shell exited with code ${String(message['exitCode'])}.`,
          limitation: false,
        });
        return;

      case 'file.listing':
      case 'file.info':
      case 'file.chunk':
      case 'file.written':
      case 'file.done': {
        // Handed to whoever asked and nowhere else. Nothing here keeps a copy of a listing or
        // a chunk: the browser holds a transfer only while it is running.
        const pending = this.pendingFiles.get(String(message['requestId'] ?? ''));
        if (!pending) return;

        this.pendingFiles.delete(String(message['requestId']));
        pending.resolve(message);
        return;
      }

      case 'file.refused': {
        const pending = this.pendingFiles.get(String(message['requestId'] ?? ''));
        if (!pending) return;

        this.pendingFiles.delete(String(message['requestId']));
        pending.reject(
          new FileRefusal(
            String(message['reason'] ?? 'failed'),
            String(message['detail'] ?? 'The PC refused that file operation.'),
            message['limitation'] === true,
          ),
        );
        return;
      }

      case 'terminal.refused':
        this.options.events.onTerminal({
          kind: 'refused',
          terminalId: String(message['terminalId'] ?? ''),
          shell: null,
          processId: null,
          data: null,
          detail: String(message['detail'] ?? 'The PC would not open that terminal.'),
          limitation: message['limitation'] === true,
        });
        return;

      default:
        return;
    }
  }

  /**
   * A rejection from the PC, about input it would not inject.
   *
   * Only failures come back this way. A healthy stream sends nothing per batch, because
   * acknowledging every one would double the message rate for no benefit.
   */
  private handleInputResponse(response: Record<string, unknown> | undefined): void {
    if (!response || typeof response['outcome'] !== 'string') return;

    this.options.events.onError({
      code: `input-${String(response['outcome'])}`,
      message: String(response['reason'] ?? 'The PC refused that input.'),
      limitation: response['limitation'] === true,
      recommendedAction: null,
    });
  }

  /**
   * Sample what the browser knows about the connection.
   *
   * Every value here is one the agent cannot see. Rates are derived from the change between
   * samples rather than reported as running totals, because a total is not something an
   * operator can read a problem out of.
   */
  private startStatsPolling(): void {
    if (this.statsTimer) return;

    this.statsTimer = setInterval(() => {
      void this.sampleStats();
    }, 1000);
  }

  private async sampleStats(): Promise<void> {
    const peer = this.peer;
    if (!peer) return;

    let report: RTCStatsReport;
    try {
      report = await peer.getStats();
    } catch {
      return;
    }

    const stats: ClientStats = {
      fps: null,
      bitrateBps: null,
      widthPixels: null,
      heightPixels: null,
      roundTripMs: null,
      jitterMs: null,
      packetsLost: null,
      packetLossPercent: null,
      framesDropped: null,
      decodeMsPerFrame: null,
      route: null,
      codec: null,
    };

    const now = performance.now();
    let bytes = 0;
    let frames = 0;
    let decodeMs = 0;
    let received = 0;
    let lost = 0;
    const codecs = new Map<string, string>();

    report.forEach((entry) => {
      if (entry.type === 'codec') {
        codecs.set(entry.id as string, String(entry.mimeType ?? '').split('/')[1] ?? '');
        return;
      }

      if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
        bytes = Number(entry.bytesReceived ?? 0);
        frames = Number(entry.framesDecoded ?? 0);
        decodeMs = Number(entry.totalDecodeTime ?? 0) * 1000;
        received = Number(entry.packetsReceived ?? 0);
        lost = Number(entry.packetsLost ?? 0);

        stats.widthPixels = entry.frameWidth ? Number(entry.frameWidth) : null;
        stats.heightPixels = entry.frameHeight ? Number(entry.frameHeight) : null;
        stats.framesDropped = entry.framesDropped === undefined ? null : Number(entry.framesDropped);
        stats.jitterMs = entry.jitter === undefined ? null : Number(entry.jitter) * 1000;
        stats.packetsLost = Number.isFinite(lost) ? lost : null;

        const codecName = entry.codecId ? codecs.get(String(entry.codecId)) : undefined;
        if (codecName) stats.codec = codecName;
        return;
      }

      if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
        if (entry.currentRoundTripTime !== undefined) {
          stats.roundTripMs = Number(entry.currentRoundTripTime) * 1000;
        }
      }

      if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
        if (entry.candidateType === 'relay') stats.route = 'relay';
        else if (stats.route === null && entry.candidateType === 'host') stats.route = 'lan';
        else if (stats.route !== 'relay' && entry.candidateType) stats.route = 'p2p';
      }
    });

    if (received + lost > 0) {
      stats.packetLossPercent = (lost / (received + lost)) * 100;
    }

    const previous = this.lastSample;
    if (previous) {
      const seconds = (now - previous.at) / 1000;
      if (seconds > 0) {
        stats.bitrateBps = ((bytes - previous.bytes) * 8) / seconds;
        stats.fps = (frames - previous.frames) / seconds;

        const decodedFrames = frames - previous.frames;
        if (decodedFrames > 0) {
          stats.decodeMsPerFrame = (decodeMs - previous.decodeMs) / decodedFrames;
        }
      }
    }

    this.lastSample = { at: now, bytes, frames, decodeMs };
    this.options.events.onClientStats(stats);
  }

  private teardownPeer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.peer?.close();
    this.peer = null;
  }

  private fail(code: string, message: string, limitation: boolean, action: string | null): void {
    this.options.events.onError({ code, message, limitation, recommendedAction: action });
    this.setPhase('failed', message);
    this.teardownPeer();
  }

  private setPhase(phase: StreamPhase, detail: string | null): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.events.onPhase(phase, detail);
  }
}

/**
 * Base64 without a data URL round trip.
 *
 * `btoa` takes a string of code points below 256, so the bytes are widened one at a time. In
 * chunks, because spreading a 64 KB array into `String.fromCharCode` is an argument list long
 * enough to overflow the stack in some browsers — which shows up as a transfer that works
 * everywhere except one person's laptop.
 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 8192;

  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }

  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/** SHA-256 as lowercase hex, matching what the agent computes over the same bytes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

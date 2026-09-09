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

  private stopRenewing(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
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

    this.stopRenewing();
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

      case 'stream.state': {
        const state = String(payload['state']);
        const detail = (payload['detail'] as string | null) ?? null;

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

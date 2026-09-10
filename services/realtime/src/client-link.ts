import type { WebSocket } from 'ws';
import type { Logger } from 'pino';
import { verifyAccessToken } from '@wolf/auth';
import {
  PROTOCOL_VERSION,
  clientMessage,
  isClientToAgent,
  type ClientMessage,
  type CloudClientMessage,
  type SignalEnvelope,
} from '@wolf/protocol';
import type { ClientLinkHandle } from './client-registry.js';
import type { RealtimeContext } from './context.js';

/** Time an unauthenticated client socket may exist before it is closed. */
const AUTH_TIMEOUT_MS = 10_000;
/** Largest client message accepted. SDP is the biggest legitimate one. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Streams one session may have open at once. */
const MAX_STREAMS_PER_SESSION = 4;

/**
 * How long a grant of keyboard and mouse control lasts before it has to be renewed.
 *
 * Short on purpose, and enforced by the session host rather than only here. An operator who
 * walks away stops holding the keyboard within two minutes, and a cloud that becomes
 * unreachable cannot leave a PC permanently controllable by whoever held it last.
 */
const INPUT_LEASE_SECONDS = 120;

/**
 * How long a grant of the terminal lasts before it has to be renewed.
 *
 * Longer than input, because a shell is not a continuous activity: an operator reads output,
 * thinks, and types again, and a lease that lapsed while they were reading would close their
 * shell mid-task. Still bounded, and for the same reason — a cloud that becomes unreachable
 * must not leave a command prompt open on somebody's PC indefinitely.
 */
const TERMINAL_LEASE_SECONDS = 600;

type LinkState = 'connecting' | 'authenticated' | 'closed';

export interface ClientLinkOptions {
  readonly socket: WebSocket;
  readonly context: RealtimeContext;
  readonly remoteAddress: string | null;
}

/**
 * One browser or Android client, connected for signaling.
 *
 * Everything this class does is authorization. It is the component standing between an
 * authenticated user and a live desktop, so its job is to make sure that a message only
 * ever reaches the PC the session was granted against, in the direction the protocol
 * allows, while that session still holds the capability it was granted.
 *
 * It is deliberately not a tunnel. Every message is parsed, checked, and re-serialized;
 * nothing is forwarded as opaque bytes.
 */
export class ClientLink implements ClientLinkHandle {
  readonly connectedAt = new Date();
  sessionId = '';
  pcId = '';
  userId = '';
  deviceId = '';

  private state: LinkState = 'connecting';
  private capabilities: readonly string[] = [];
  private readonly socket: WebSocket;
  private readonly context: RealtimeContext;
  private readonly remoteAddress: string | null;
  private readonly logger: Logger;
  private authTimer: NodeJS.Timeout | null = null;
  private readonly openStreams = new Set<string>();
  /** Streams for which this session currently holds the input lease. */
  private readonly heldInputStreams = new Set<string>();
  /** Streams for which this session currently holds the terminal lease. */
  private readonly heldTerminalStreams = new Set<string>();

  constructor(options: ClientLinkOptions) {
    this.socket = options.socket;
    this.context = options.context;
    this.remoteAddress = options.remoteAddress;
    this.logger = options.context.logger.child({ component: 'client-link' });

    this.socket.on('message', (data, isBinary) => void this.onMessage(data, isBinary));
    this.socket.on('close', () => void this.onClose());
    this.socket.on('error', (error) => {
      this.logger.warn({ sessionId: this.sessionId || null, err: error.message }, 'Client socket error');
    });

    this.authTimer = setTimeout(() => {
      if (this.state === 'connecting') this.close('authentication-timeout');
    }, AUTH_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private async onMessage(data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.close('binary-frames-not-accepted');
      return;
    }

    const text = String(data);
    if (text.length > MAX_MESSAGE_BYTES) {
      this.close('message-too-large');
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      this.close('malformed-json');
      return;
    }

    const parsed = clientMessage.safeParse(parsedJson);
    if (!parsed.success) {
      this.logger.warn(
        {
          sessionId: this.sessionId || null,
          issueCount: parsed.error.issues.length,
          // Paths and codes, never values: a rejected message may carry clipboard text.
          issues: parsed.error.issues.slice(0, 8).map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
          })),
        },
        'Rejected a malformed client message',
      );
      this.close('malformed-message');
      return;
    }

    try {
      await this.handle(parsed.data);
    } catch (error) {
      this.logger.error(
        { sessionId: this.sessionId || null, err: error instanceof Error ? error.message : String(error) },
        'Failed to handle a client message',
      );
    }
  }

  private async handle(message: ClientMessage): Promise<void> {
    if (this.state === 'connecting' && message.kind !== 'client.auth') {
      this.close('unauthenticated-message');
      return;
    }

    switch (message.kind) {
      case 'client.auth':
        await this.authenticate(message.sessionToken);
        return;
      case 'client.signal':
        await this.relayToAgent(message.envelope);
        return;
      case 'client.ping':
        return;
    }
  }

  /**
   * Authenticate with a session token.
   *
   * A session token — not an account token. It names the PC, the session, and the
   * capabilities that session holds, and every one of those is re-checked here against
   * live state rather than trusted from the token: a session that ended a second ago must
   * not be able to open a stream because its token has not expired yet.
   */
  private async authenticate(sessionToken: string): Promise<void> {
    const verified = verifyAccessToken(sessionToken, {
      signer: this.context.signer,
      issuer: this.context.config.tokens.issuer,
      audience: this.context.config.tokens.audience,
      now: this.context.now().getTime(),
    });

    if (!verified.ok) {
      await this.rejectAuth(
        verified.reason === 'expired' ? 'expired-token' : 'bad-token',
        `The session token was rejected (${verified.reason}).`,
      );
      return;
    }

    const claims = verified.claims;
    if (!claims.sid || !claims.pid) {
      await this.rejectAuth(
        'bad-token',
        'Signaling requires a session token scoped to a PC, not an account token.',
      );
      return;
    }

    const session = await this.context.repos.sessions.findActive(
      claims.sid,
      claims.sub,
      this.context.now(),
    );
    if (!session || session.pcId !== claims.pid) {
      // Engaging the kill switch ends every session for the PC, so "your session ended" is
      // technically true but useless. Name the actual cause when there is a better one.
      const pc = await this.context.repos.pcs.findById(claims.pid, claims.sub);
      if (pc && !pc.remoteAccessEnabled) {
        await this.rejectAuth('kill-switch', 'Remote access is disabled for this PC.');
        return;
      }

      await this.rejectAuth('session-ended', 'The session has ended or expired.');
      return;
    }

    // The device must still be authorized: revoking a device has to take effect on a live
    // socket, not only on the next HTTP call.
    const device = await this.context.repos.devices.findActive(claims.did, claims.sub);
    if (!device) {
      await this.rejectAuth('bad-token', 'The device is no longer authorized.');
      return;
    }

    if (!session.capabilities.includes('screen')) {
      await this.rejectAuth(
        'capability-missing',
        'This session was not granted the screen capability.',
      );
      return;
    }

    const pc = await this.context.repos.pcs.findById(claims.pid, claims.sub);
    if (!pc) {
      await this.rejectAuth('session-ended', 'That PC is no longer registered.');
      return;
    }
    if (!pc.remoteAccessEnabled) {
      await this.rejectAuth('kill-switch', 'Remote access is disabled for this PC.');
      return;
    }

    this.sessionId = session.id;
    this.pcId = session.pcId;
    this.userId = claims.sub;
    this.deviceId = claims.did;
    this.capabilities = session.capabilities;
    this.state = 'authenticated';
    if (this.authTimer) clearTimeout(this.authTimer);

    this.context.clients.add(this);

    this.send({
      kind: 'cloud.client-auth-accepted',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      pcId: this.pcId,
      capabilities: [...this.capabilities],
      // Told up front so the UI can say "this PC is offline" rather than offering a stream
      // that will never negotiate.
      agentConnected: this.context.agents.get(this.pcId) !== null,
      serverTime: this.context.now().toISOString(),
    });

    this.logger.info(
      { sessionId: this.sessionId, pcId: this.pcId },
      'Client link authenticated for signaling',
    );
  }

  private async rejectAuth(
    reason:
      | 'bad-token'
      | 'expired-token'
      | 'session-ended'
      | 'capability-missing'
      | 'kill-switch'
      | 'protocol-version'
      | 'rate-limited',
    detail: string,
  ): Promise<void> {
    this.send({
      kind: 'cloud.client-auth-rejected',
      protocolVersion: PROTOCOL_VERSION,
      reason,
      detail,
    });

    await this.context.repos.audit.recordSecurityEvent({
      type: 'unauthorized-command',
      sourceIp: this.remoteAddress,
      detail: { action: 'client.auth', reason },
    });

    this.logger.warn({ reason, sourceIp: this.remoteAddress }, 'Client signaling refused');
    this.close(`auth-rejected:${reason}`);
  }

  // ---------------------------------------------------------------------------
  // Relay
  // ---------------------------------------------------------------------------

  /**
   * Forward a signaling message to the agent.
   *
   * The checks below are the whole security boundary of remote desktop signaling, so they
   * are done in full on every message rather than once at connect time.
   */
  private async relayToAgent(envelope: SignalEnvelope): Promise<void> {
    // A client may only signal within its own session. Anything else is an attempt to
    // reach a session it was not granted.
    if (envelope.sessionId !== this.sessionId) {
      this.logger.warn(
        { sessionId: this.sessionId, attempted: envelope.sessionId },
        'Client tried to signal outside its own session',
      );
      await this.context.repos.audit.recordSecurityEvent({
        type: 'unauthorized-command',
        userId: this.userId,
        deviceId: this.deviceId,
        pcId: this.pcId,
        sourceIp: this.remoteAddress,
        detail: { action: 'client.signal', reason: 'session-mismatch' },
      });
      this.close('session-mismatch');
      return;
    }

    if (!isClientToAgent(envelope.payload.type)) {
      // A client sending `stream.stats` would be trying to make the record say the stream
      // was healthy. Direction is enforced, not assumed.
      this.sendStreamError(
        envelope,
        'signal.wrong-direction',
        `A client cannot send "${envelope.payload.type}".`,
      );
      return;
    }

    const pc = await this.context.repos.pcs.findById(this.pcId, this.userId);
    if (!pc || !pc.remoteAccessEnabled) {
      await this.releaseAllInput('kill-switch');
      await this.releaseAllTerminals('kill-switch');
      this.notifyPeerGone('kill-switch', 'Remote access is disabled for this PC.');
      this.close('kill-switch');
      return;
    }

    const agent = this.context.agents.get(this.pcId);
    if (!agent) {
      this.notifyPeerGone('agent-disconnected', 'The WOLF agent on this PC is not connected.');
      return;
    }

    if (envelope.payload.type === 'stream.request') {
      const allowed = await this.beginStream(envelope);
      if (!allowed) return;
    }

    if (envelope.payload.type === 'stream.stop') {
      await this.context.repos.remoteDesktop.endStream(envelope.streamId, envelope.payload.reason);
      this.openStreams.delete(envelope.streamId);
      await this.releaseInput(envelope.streamId, 'released');
      await this.releaseTerminal(envelope.streamId, 'released');
    }

    // Control of the keyboard and mouse is arbitrated here rather than forwarded. The PC
    // cannot decide between two sessions competing for it — only the cloud sees both — and
    // a client deciding for itself is not a decision at all.
    if (envelope.payload.type === 'input.request') {
      await this.acquireInput(envelope.streamId);
      return;
    }

    if (envelope.payload.type === 'input.release') {
      await this.releaseInput(envelope.streamId, 'released');
      return;
    }

    // The terminal is arbitrated here for the same reason and with more at stake: a session
    // holding this lease can run commands on somebody's PC, and two sessions holding it at
    // once would produce a command line neither operator typed.
    if (envelope.payload.type === 'terminal.request') {
      await this.acquireTerminal(envelope.streamId);
      return;
    }

    if (envelope.payload.type === 'terminal.release') {
      await this.releaseTerminal(envelope.streamId, 'released');
      return;
    }

    agent.sendSignal(envelope, this.deviceId, this.capabilities);
  }

  // ---------------------------------------------------------------------------
  // Input arbitration
  // ---------------------------------------------------------------------------

  /**
   * Take the input lease for this session, or report who has it.
   *
   * Renewing is the same operation as taking: the lease is re-issued to whoever already
   * holds it, so a client that keeps asking keeps control and one that stops asking loses
   * it without anybody having to notice it went away.
   */
  private async acquireInput(streamId: string): Promise<void> {
    if (!this.capabilities.includes('input')) {
      // The session was never granted control. Told plainly, because an operator watching
      // a screen that ignores their mouse deserves better than silence.
      this.publishInputControl(streamId, {
        granted: false,
        holderSessionId: null,
        expiresAt: null,
        reason: 'capability-missing',
      });
      return;
    }

    const expiresAt = new Date(this.context.now().getTime() + INPUT_LEASE_SECONDS * 1000);
    const outcome = await this.context.repos.sessions.acquireResource({
      pcId: this.pcId,
      resource: 'input',
      sessionId: this.sessionId,
      expiresAt,
    });

    if (!outcome.acquired) {
      // Somebody else is driving. Taking it from them silently is what makes remote
      // support frightening; an explicit transfer is a separate, deliberate act.
      this.publishInputControl(streamId, {
        granted: false,
        holderSessionId: outcome.heldBy,
        expiresAt: null,
        reason: 'held-by-another-session',
      });
      return;
    }

    this.heldInputStreams.add(streamId);
    this.publishInputControl(streamId, {
      granted: true,
      holderSessionId: this.sessionId,
      expiresAt: expiresAt.toISOString(),
      reason: 'granted',
    });
  }

  private async releaseInput(
    streamId: string,
    reason: 'released' | 'session-ended' | 'kill-switch',
  ): Promise<void> {
    if (!this.heldInputStreams.delete(streamId)) return;

    await this.context.repos.sessions.releaseResource(this.pcId, 'input', this.sessionId);
    this.publishInputControl(streamId, {
      granted: false,
      holderSessionId: null,
      expiresAt: null,
      reason,
    });
  }

  /** Release every held lease, for a client that is going away. */
  private async releaseAllInput(reason: 'session-ended' | 'kill-switch'): Promise<void> {
    for (const streamId of [...this.heldInputStreams]) {
      await this.releaseInput(streamId, reason);
    }
  }

  /**
   * Tell both ends who holds control.
   *
   * Both, always, and from here only. The PC needs it because it is what gates injection;
   * the client needs it because it decides whether to capture the operator's keyboard. A
   * message that reached only one of them would leave the two disagreeing about who is
   * driving.
   */
  private publishInputControl(
    streamId: string,
    control: {
      granted: boolean;
      holderSessionId: string | null;
      expiresAt: string | null;
      reason:
        | 'granted'
        | 'capability-missing'
        | 'held-by-another-session'
        | 'released'
        | 'session-ended'
        | 'kill-switch'
        | 'unsupported';
    },
  ): void {
    const envelope: SignalEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId,
      sentAt: this.context.now().toISOString(),
      payload: { type: 'input.control', ...control },
    };

    this.deliverSignal(envelope);
    this.context.agents.get(this.pcId)?.sendSignal(envelope, this.deviceId, this.capabilities);

    this.logger.info(
      {
        pcId: this.pcId,
        sessionId: this.sessionId,
        streamId,
        granted: control.granted,
        reason: control.reason,
      },
      'Input control decided',
    );
  }

  // ---------------------------------------------------------------------------
  // Terminal arbitration
  // ---------------------------------------------------------------------------

  /**
   * Take the terminal lease for this session, or report who has it.
   *
   * Renewing is the same operation as taking, exactly as it is for input. What differs is
   * what a refusal means: an operator refused the keyboard watches a screen that ignores
   * their mouse, and an operator refused the terminal has no shell at all.
   */
  private async acquireTerminal(streamId: string): Promise<void> {
    if (!this.capabilities.includes('terminal')) {
      // Its own capability, and not implied by any other. Watching a screen and running
      // commands on the machine behind it are different intrusions.
      this.publishTerminalControl(streamId, {
        granted: false,
        holderSessionId: null,
        expiresAt: null,
        reason: 'capability-missing',
      });
      return;
    }

    const expiresAt = new Date(this.context.now().getTime() + TERMINAL_LEASE_SECONDS * 1000);
    const outcome = await this.context.repos.sessions.acquireResource({
      pcId: this.pcId,
      resource: 'terminal',
      sessionId: this.sessionId,
      expiresAt,
    });

    if (!outcome.acquired) {
      this.publishTerminalControl(streamId, {
        granted: false,
        holderSessionId: outcome.heldBy,
        expiresAt: null,
        reason: 'held-by-another-session',
      });
      return;
    }

    this.heldTerminalStreams.add(streamId);
    this.publishTerminalControl(streamId, {
      granted: true,
      holderSessionId: this.sessionId,
      expiresAt: expiresAt.toISOString(),
      reason: 'granted',
    });
  }

  private async releaseTerminal(
    streamId: string,
    reason: 'released' | 'session-ended' | 'kill-switch',
  ): Promise<void> {
    if (!this.heldTerminalStreams.delete(streamId)) return;

    await this.context.repos.sessions.releaseResource(this.pcId, 'terminal', this.sessionId);
    this.publishTerminalControl(streamId, {
      granted: false,
      holderSessionId: null,
      expiresAt: null,
      reason,
    });
  }

  /** Release every held terminal, for a client that is going away. */
  private async releaseAllTerminals(reason: 'session-ended' | 'kill-switch'): Promise<void> {
    for (const streamId of [...this.heldTerminalStreams]) {
      await this.releaseTerminal(streamId, reason);
    }
  }

  /**
   * Tell both ends who holds the terminal.
   *
   * Both, always, and from here only — the PC because it is what gates opening a shell, the
   * client because it decides whether to show one. What is logged is the decision and never
   * anything a shell carried: this service does not see terminal traffic at all, and that is
   * deliberate rather than incidental.
   */
  private publishTerminalControl(
    streamId: string,
    control: {
      granted: boolean;
      holderSessionId: string | null;
      expiresAt: string | null;
      reason:
        | 'granted'
        | 'capability-missing'
        | 'held-by-another-session'
        | 'released'
        | 'session-ended'
        | 'kill-switch'
        | 'unsupported';
    },
  ): void {
    const envelope: SignalEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId,
      sentAt: this.context.now().toISOString(),
      payload: { type: 'terminal.control', ...control },
    };

    this.deliverSignal(envelope);
    this.context.agents.get(this.pcId)?.sendSignal(envelope, this.deviceId, this.capabilities);

    this.logger.info(
      {
        pcId: this.pcId,
        sessionId: this.sessionId,
        streamId,
        granted: control.granted,
        reason: control.reason,
      },
      'Terminal control decided',
    );
  }

  /**
   * Record a new stream and enforce the per-session limit.
   *
   * The limit exists because each stream is a capture pipeline and an encoder on someone's
   * PC. Letting a client open them without bound would be a denial of service against the
   * machine the operator is trying to use.
   */
  private async beginStream(envelope: SignalEnvelope): Promise<boolean> {
    if (envelope.payload.type !== 'stream.request') return true;

    if (this.openStreams.size >= MAX_STREAMS_PER_SESSION && !this.openStreams.has(envelope.streamId)) {
      this.sendStreamError(
        envelope,
        'stream.too-many',
        `A session may run at most ${MAX_STREAMS_PER_SESSION} streams at once.`,
        'Close a stream before starting another.',
      );
      return false;
    }

    const existing = await this.context.repos.remoteDesktop.findStream(envelope.streamId);
    if (existing) {
      // A repeated request for a live stream is a reconnect, not a new stream.
      if (existing.sessionId !== this.sessionId) {
        this.sendStreamError(
          envelope,
          'stream.not-yours',
          'That stream belongs to a different session.',
        );
        return false;
      }
      this.openStreams.add(envelope.streamId);
      return true;
    }

    await this.context.repos.remoteDesktop.createStream({
      id: envelope.streamId,
      sessionId: this.sessionId,
      pcId: this.pcId,
      userId: this.userId,
      deviceId: this.deviceId,
      displayId: envelope.payload.request.displayId,
      audioEnabled: envelope.payload.request.requestAudio,
      requestedProfile: envelope.payload.request.profile,
    });
    this.openStreams.add(envelope.streamId);

    await this.context.repos.audit.record({
      category: 'session',
      action: 'remote-desktop.stream.start',
      outcome: 'pending',
      riskLevel: 'medium',
      userId: this.userId,
      deviceId: this.deviceId,
      pcId: this.pcId,
      sessionId: this.sessionId,
      sourceIp: this.remoteAddress,
      target: { kind: 'stream', streamId: envelope.streamId },
      // Settings only. Nothing about what is on the screen is recorded, here or anywhere.
      afterValue: {
        displayId: envelope.payload.request.displayId,
        targetFps: envelope.payload.request.profile.targetFps,
        maxBitrateBps: envelope.payload.request.profile.maxBitrateBps,
        audioRequested: envelope.payload.request.requestAudio,
      },
    });

    this.logger.info(
      { sessionId: this.sessionId, pcId: this.pcId, streamId: envelope.streamId },
      'Stream requested',
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  deliverSignal(envelope: SignalEnvelope): void {
    this.send({ kind: 'cloud.signal', protocolVersion: PROTOCOL_VERSION, envelope });
  }

  notifyPeerGone(
    reason: 'agent-disconnected' | 'session-ended' | 'kill-switch',
    detail: string,
  ): void {
    this.send({ kind: 'cloud.peer-gone', protocolVersion: PROTOCOL_VERSION, reason, detail });
  }

  private sendStreamError(
    envelope: SignalEnvelope,
    code: string,
    message: string,
    recommendedAction: string | null = null,
  ): void {
    this.deliverSignal({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: envelope.sessionId,
      streamId: envelope.streamId,
      sentAt: this.context.now().toISOString(),
      payload: { type: 'stream.error', code, message, limitation: false, recommendedAction },
    });
  }

  private send(message: CloudClientMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  ping(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping();
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.authTimer) clearTimeout(this.authTimer);
    try {
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
  }

  private async onClose(): Promise<void> {
    this.state = 'closed';
    if (this.authTimer) clearTimeout(this.authTimer);
    this.context.clients.remove(this);

    if (!this.sessionId) return;

    // A client that vanishes must not keep holding the keyboard. The lease would expire on
    // its own within two minutes, but two minutes of a PC nobody can control is two minutes
    // too many when the answer is already known.
    await this.releaseAllInput('session-ended');
    await this.releaseAllTerminals('session-ended');

    // A client that vanishes also leaves an encoder running on someone's PC. Tell the agent
    // to stop, and close the records, rather than waiting for a timeout to notice.
    const agent = this.context.agents.get(this.pcId);
    for (const streamId of this.openStreams) {
      agent?.sendSignal(
        {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          streamId,
          sentAt: this.context.now().toISOString(),
          payload: { type: 'stream.stop', reason: 'client-closed', detail: 'The client disconnected.' },
        },
        this.deviceId,
      );

      await this.context.repos.remoteDesktop
        .endStream(streamId, 'client-disconnected')
        .catch((error: unknown) => {
          this.logger.error({ streamId, err: String(error) }, 'Failed to close a stream record');
        });
    }

    this.openStreams.clear();
    this.logger.info({ sessionId: this.sessionId, pcId: this.pcId }, 'Client link closed');
  }
}

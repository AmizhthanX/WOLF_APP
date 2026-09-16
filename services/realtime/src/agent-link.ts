import type { WebSocket } from 'ws';
import type { Logger } from 'pino';
import { createChallenge, verifyChallengeResponse, type Challenge } from '@wolf/auth';
import { newId } from '@wolf/shared-types';
import {
  PROTOCOL_VERSION,
  agentMessage,
  challengeSigningPayload,
  isAgentToClient,
  type AgentMessage,
  type CloudMessage,
  type SignalEnvelope,
} from '@wolf/protocol';
import { telemetryBatch } from '@wolf/telemetry-schema';
import { applyCommandResult, buildIceConfiguration } from '@wolf/server-core';
import type { AgentLinkHandle } from './registry.js';
import type { RealtimeContext } from './context.js';

/** Time an unauthenticated socket is allowed to exist before it is closed. */
const AUTH_TIMEOUT_MS = 15_000;
/** Time after authentication in which the agent must send its hello. */
const HELLO_TIMEOUT_MS = 15_000;
/** Largest message accepted from an agent. Telemetry batches are the biggest legitimate one. */
const MAX_MESSAGE_BYTES = 512 * 1024;

type LinkState = 'challenged' | 'authenticated' | 'ready' | 'closed';

export interface AgentLinkOptions {
  readonly socket: WebSocket;
  readonly context: RealtimeContext;
  readonly remoteAddress: string | null;
}

/**
 * One authenticated agent connection.
 *
 * The PC dials out, so no inbound port is ever opened on the machine. Before the socket
 * can carry anything, the agent must sign a per-connection nonce with the private half of
 * the identity it enrolled with — a stolen bearer token alone cannot impersonate a PC.
 */
export class AgentLink implements AgentLinkHandle {
  readonly connectedAt = new Date();
  pcId = '';
  userId = '';

  private state: LinkState = 'challenged';
  private readonly socket: WebSocket;
  private readonly context: RealtimeContext;
  private readonly remoteAddress: string | null;
  private readonly challenge: Challenge;
  private readonly logger: Logger;
  private agentVersion = 'unknown';
  private authTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private heartbeatSeconds = 30;
  /** Device of the most recent signaling peer, used when the agent must be told to stop. */
  private deviceIdForSignals: string | null = null;
  /** Capabilities of the session whose signalling was last relayed to this agent. */
  private capabilitiesForSignals: readonly string[] = [];

  constructor(options: AgentLinkOptions) {
    this.socket = options.socket;
    this.context = options.context;
    this.remoteAddress = options.remoteAddress;
    this.challenge = createChallenge(options.context.now());
    this.logger = options.context.logger.child({ component: 'agent-link' });

    this.socket.on('message', (data, isBinary) => void this.onMessage(data, isBinary));
    this.socket.on('close', (code, reason) => this.onClose(code, reason.toString()));
    this.socket.on('error', (error) => {
      this.logger.warn({ pcId: this.pcId || null, err: error.message }, 'Agent socket error');
    });

    this.send({
      kind: 'cloud.challenge',
      protocolVersion: PROTOCOL_VERSION,
      nonce: this.challenge.nonce,
      serverTime: this.challenge.issuedAt.toISOString(),
    });

    this.authTimer = setTimeout(() => {
      if (this.state === 'challenged') this.close('authentication-timeout');
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

    const parsed = agentMessage.safeParse(parsedJson);
    if (!parsed.success) {
      this.logger.warn(
        {
          pcId: this.pcId || null,
          issueCount: parsed.error.issues.length,
          // Paths and codes, never values: the message that failed may carry clipboard
          // text or session material. A bare count is not diagnosable — it cost a day of
          // an agent reconnecting in a loop with nothing in the log to say which field
          // the two sides disagreed about.
          issues: parsed.error.issues.slice(0, 8).map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
          })),
        },
        'Rejected a malformed agent message',
      );
      this.close('malformed-message');
      return;
    }

    try {
      await this.handle(parsed.data);
    } catch (error) {
      this.logger.error(
        { pcId: this.pcId || null, err: error instanceof Error ? error.message : String(error) },
        'Failed to handle an agent message',
      );
    }
  }

  private async handle(message: AgentMessage): Promise<void> {
    // Everything except the authentication response requires an authenticated link.
    if (this.state === 'challenged' && message.kind !== 'agent.auth') {
      this.close('unauthenticated-message');
      return;
    }

    switch (message.kind) {
      case 'agent.auth':
        await this.handleAuth(message);
        return;
      case 'agent.hello':
        await this.handleHello(message);
        return;
      case 'agent.heartbeat':
        await this.handleHeartbeat(message);
        return;
      case 'agent.telemetry':
        await this.handleTelemetry(message);
        return;
      case 'agent.command-result':
        await applyCommandResult(this.context, this.pcId, message.result);
        return;
      case 'agent.command-progress':
        await this.context.repos.commands.markRunning(
          message.progress.commandId,
          new Date(message.progress.at),
        );
        return;
      case 'agent.event':
        await this.handleEvent(message);
        return;
      case 'agent.signal':
        await this.handleSignal(message.envelope);
        return;
    }
  }

  /**
   * Route a signaling message from this agent to the client that asked for it.
   *
   * Two checks matter here, and both keep an agent inside its own lane: the payload must be
   * one an agent is allowed to send, and the target session must actually belong to this
   * PC. Without the second, a compromised agent could inject stream state into a session
   * that is watching a different machine.
   */
  private async handleSignal(envelope: SignalEnvelope): Promise<void> {
    if (!isAgentToClient(envelope.payload.type)) {
      this.logger.warn(
        { pcId: this.pcId, type: envelope.payload.type },
        'Agent sent a signaling payload it is not allowed to send',
      );
      return;
    }

    const client = this.context.clients.get(envelope.sessionId);
    if (!client) {
      // The client went away mid-negotiation. Tell the agent to stop rather than leaving a
      // capture pipeline running for nobody.
      this.sendSignal(
        {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: envelope.sessionId,
          streamId: envelope.streamId,
          sentAt: this.context.now().toISOString(),
          payload: {
            type: 'stream.stop',
            reason: 'client-closed',
            detail: 'No client is connected for this session.',
          },
        },
        this.deviceIdForSignals ?? '',
      );
      return;
    }

    if (client.pcId !== this.pcId) {
      this.logger.error(
        { pcId: this.pcId, sessionPcId: client.pcId, sessionId: envelope.sessionId },
        'Agent tried to signal a session belonging to another PC',
      );
      await this.context.repos.audit.recordSecurityEvent({
        type: 'unauthorized-command',
        pcId: this.pcId,
        sourceIp: this.remoteAddress,
        detail: { action: 'agent.signal', reason: 'pc-mismatch' },
      });
      return;
    }

    await this.recordStreamProgress(envelope);
    client.deliverSignal(envelope);
  }

  /** Keep the stream record in step with what the agent reports. Metadata only. */
  private async recordStreamProgress(envelope: SignalEnvelope): Promise<void> {
    const { remoteDesktop } = this.context.repos;

    switch (envelope.payload.type) {
      case 'stream.ready': {
        const negotiation = envelope.payload.negotiation;
        await remoteDesktop.recordNegotiation({
          id: envelope.streamId,
          displayId: negotiation.display.id,
          videoCodec: negotiation.videoCodec,
          hardwareEncoded: negotiation.hardwareEncoded,
          effectiveProfile: negotiation.effectiveProfile,
        });
        await this.context.repos.audit.record({
          category: 'session',
          action: 'remote-desktop.stream.start',
          outcome: 'success',
          riskLevel: 'medium',
          pcId: this.pcId,
          userId: this.userId,
          sessionId: envelope.sessionId,
          target: { kind: 'stream', streamId: envelope.streamId },
          afterValue: {
            codec: negotiation.videoCodec,
            hardwareEncoded: negotiation.hardwareEncoded,
            display: negotiation.display.id,
            adjustments: negotiation.adjustments.length,
          },
        });
        return;
      }

      case 'stream.state':
        await remoteDesktop.updateState({
          id: envelope.streamId,
          state: envelope.payload.state,
          unavailableReason: envelope.payload.unavailableReason,
        });
        return;

      case 'stream.stats':
        await remoteDesktop.recordStats(envelope.streamId, envelope.payload.stats);
        return;

      case 'stream.stop':
        await remoteDesktop.endStream(envelope.streamId, envelope.payload.reason);
        return;

      default:
        return;
    }
  }

  private async handleAuth(message: Extract<AgentMessage, { kind: 'agent.auth' }>): Promise<void> {
    if (this.state !== 'challenged') {
      this.close('duplicate-auth');
      return;
    }

    const identity = await this.context.repos.pcs.findIdentity(message.pcId);
    if (!identity || !identity.publicKey) {
      await this.rejectAuth('unknown-pc', message.pcId, 60);
      return;
    }
    if (identity.registrationState !== 'active') {
      await this.rejectAuth('revoked', message.pcId, 3600);
      return;
    }

    const verified = verifyChallengeResponse({
      challenge: this.challenge,
      presentedNonce: message.nonce,
      signingPayload: challengeSigningPayload(message.pcId, this.challenge.nonce),
      signature: message.signature,
      publicKey: identity.publicKey,
      now: this.context.now(),
    });

    if (!verified.ok) {
      await this.rejectAuth(
        verified.reason === 'expired' ? 'expired-challenge' : 'bad-signature',
        message.pcId,
        30,
      );
      return;
    }

    this.pcId = identity.id;
    this.userId = identity.userId;
    this.agentVersion = message.agentVersion;
    this.state = 'authenticated';
    if (this.authTimer) clearTimeout(this.authTimer);

    this.send({
      kind: 'cloud.auth-accepted',
      protocolVersion: PROTOCOL_VERSION,
      pcId: identity.id,
      serverTime: this.context.now().toISOString(),
      heartbeatSeconds: this.heartbeatSeconds,
      telemetryUploadSeconds: 15,
      remoteAccessEnabled: identity.remoteAccessEnabled,
    });

    this.helloTimer = setTimeout(() => {
      if (this.state === 'authenticated') this.close('hello-timeout');
    }, HELLO_TIMEOUT_MS);

    this.logger.info({ pcId: this.pcId, agentVersion: this.agentVersion }, 'Agent authenticated');
  }

  private async rejectAuth(
    reason: 'unknown-pc' | 'revoked' | 'bad-signature' | 'expired-challenge',
    pcId: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    this.send({
      kind: 'cloud.auth-rejected',
      protocolVersion: PROTOCOL_VERSION,
      reason,
      retryAfterSeconds,
    });
    await this.context.repos.audit.recordSecurityEvent({
      type: 'unauthorized-command',
      pcId: reason === 'unknown-pc' ? null : pcId,
      sourceIp: this.remoteAddress,
      detail: { action: 'agent.auth', reason },
    });
    this.logger.warn({ pcId, reason, sourceIp: this.remoteAddress }, 'Agent authentication refused');
    this.close(`auth-rejected:${reason}`);
  }

  private async handleHello(
    message: Extract<AgentMessage, { kind: 'agent.hello' }>,
  ): Promise<void> {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.state = 'ready';

    const { repos } = this.context;
    const now = this.context.now();

    await repos.pcs.upsertCapabilities(this.pcId, {
      hardwareVideoEncoders: message.capabilities.hardwareVideoEncoders,
      preferredVideoCodec: message.capabilities.preferredVideoCodec,
      displayCount: message.capabilities.displayCount,
      audioCaptureAvailable: message.capabilities.audioCaptureAvailable,
      wakeOnLanCapable: message.capabilities.wakeOnLanCapable,
      privilegedHelperAvailable: message.capabilities.privilegedHelperAvailable,
      secureDesktopCaptureAvailable: message.capabilities.secureDesktopCaptureAvailable,
      remoteUnlockProvisioned: message.capabilities.remoteUnlockProvisioned,
      gpuVendors: message.capabilities.gpuVendors,
      windowsBuild: message.capabilities.windowsBuild,
      supportedCommands: message.capabilities.supportedCommands,
      remoteDesktopAvailable: message.capabilities.remoteDesktopAvailable,
      remoteDesktopUnavailableReason: message.capabilities.remoteDesktopUnavailableReason,
      videoEncoders: message.capabilities.videoEncoders,
    });

    await repos.pcs.recordWakeAddress(this.pcId, message.capabilities.wakeMacAddress);

    await repos.pcs.upsertHardware(this.pcId, {
      cpuModel: message.info.cpuModel,
      cpuCores: message.info.cpuCores,
      cpuThreads: message.info.cpuThreads,
      totalMemoryBytes: message.info.totalMemoryBytes,
      gpus: message.info.gpus,
      osName: message.info.osName,
      osVersion: message.info.osVersion,
      osBuild: message.info.osBuild,
      machineArchitecture: message.info.architecture,
      bootedAt: message.info.bootedAt,
    });

    await repos.pcs.setPresence(this.pcId, {
      status: 'online',
      sessionState: message.sessionState,
      // The transport this link arrived on is the cloud relay by definition; direct LAN
      // and P2P routes are negotiated separately and reported by the client session.
      route: 'relay',
      agentVersion: this.agentVersion,
      localKillSwitchEngaged: message.localKillSwitchEngaged,
      lastSeenAt: now,
    });

    await repos.audit.record({
      category: 'pc',
      action: 'pc.agent-connected',
      outcome: 'success',
      riskLevel: 'low',
      userId: this.userId,
      pcId: this.pcId,
      sourceIp: this.remoteAddress,
      route: 'relay',
      afterValue: {
        agentVersion: this.agentVersion,
        sessionState: message.sessionState,
        localKillSwitchEngaged: message.localKillSwitchEngaged,
      },
    });

    this.context.agents.add(this);
    await this.deliverPending();
  }

  private async handleHeartbeat(
    message: Extract<AgentMessage, { kind: 'agent.heartbeat' }>,
  ): Promise<void> {
    await this.context.repos.pcs.setPresence(this.pcId, {
      status: 'online',
      sessionState: message.sessionState,
      route: 'relay',
      localKillSwitchEngaged: message.localKillSwitchEngaged,
      lastSeenAt: this.context.now(),
    });
  }

  private async handleTelemetry(
    message: Extract<AgentMessage, { kind: 'agent.telemetry' }>,
  ): Promise<void> {
    const parsed = telemetryBatch.safeParse(message.batch);
    if (!parsed.success) {
      this.logger.warn({ pcId: this.pcId }, 'Discarded a malformed telemetry batch');
      return;
    }

    // Samples far outside the accepted clock window are dropped rather than stored: they
    // would land in the wrong partition and skew every aggregate over that window.
    const now = this.context.now().getTime();
    const driftMs = this.context.config.maxClockDriftSeconds * 1000;
    const accepted = parsed.data.samples.filter((sample) => {
      const sampledAt = new Date(sample.sampledAt).getTime();
      return Number.isFinite(sampledAt) && Math.abs(now - sampledAt) <= driftMs;
    });

    if (accepted.length !== parsed.data.samples.length) {
      this.logger.warn(
        { pcId: this.pcId, dropped: parsed.data.samples.length - accepted.length },
        'Dropped telemetry samples outside the accepted clock window',
      );
    }
    if (accepted.length === 0) return;

    await this.context.repos.telemetry.insertBatch(this.pcId, accepted);
  }

  private async handleEvent(
    message: Extract<AgentMessage, { kind: 'agent.event' }>,
  ): Promise<void> {
    await this.context.db.query(
      'INSERT INTO system_events (id, pc_id, at, type, detail) VALUES ($1, $2, $3, $4, $5)',
      [
        newId(),
        this.pcId,
        new Date(message.event.at),
        message.event.type,
        JSON.stringify(message.event.detail),
      ],
    );

    if (message.event.type === 'session-state-changed') {
      const state = message.event.detail['state'];
      if (typeof state === 'string') {
        await this.context.repos.pcs.setPresence(this.pcId, {
          status: 'online',
          sessionState: state as never,
          route: 'relay',
          lastSeenAt: this.context.now(),
        });
      }
    }

    if (message.event.type === 'kill-switch-changed') {
      const engaged = message.event.detail['engaged'];
      await this.context.repos.pcs.setPresence(this.pcId, {
        status: 'online',
        route: 'relay',
        localKillSwitchEngaged: engaged === true,
        lastSeenAt: this.context.now(),
      });
      await this.context.repos.audit.record({
        category: 'kill-switch',
        action: engaged === true ? 'pc.kill-switch.engage' : 'pc.kill-switch.release',
        outcome: 'success',
        riskLevel: 'critical',
        userId: this.userId,
        pcId: this.pcId,
        afterValue: { localKillSwitchEngaged: engaged === true, source: 'local' },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Claim and send every command waiting for this PC.
   *
   * Claiming marks the rows sent in one statement, so if two instances ever believe they
   * hold the same PC, only one of them can claim any given command.
   */
  async deliverPending(): Promise<void> {
    if (this.state !== 'ready') return;

    const pending = await this.context.repos.commands.claimPending(this.pcId);
    for (const command of pending) {
      this.send({
        kind: 'cloud.command',
        protocolVersion: PROTOCOL_VERSION,
        envelope: {
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.id,
          pcId: command.pcId,
          requestId: command.requestId,
          issuedAt: command.createdAt.toISOString(),
          expiresAt: command.expiresAt.toISOString(),
          idempotencyKey: command.idempotencyKey,
          authorization: command.authorization,
          command: command.payload,
        },
      });
    }

    if (pending.length > 0) {
      this.logger.info({ pcId: this.pcId, count: pending.length }, 'Delivered pending commands');
    }
  }

  /**
   * Deliver a client signaling message to this agent.
   *
   * A stream request carries the ICE servers for the agent's side with it. They are minted
   * here rather than sent at connect because TURN credentials expire in an hour and an
   * agent link stays up for days, and they are attached to the message rather than placed
   * inside the payload because the client must not be able to choose the agent's relay.
   */
  sendSignal(envelope: SignalEnvelope, deviceId: string, capabilities: readonly string[] = []): void {
    this.deviceIdForSignals = deviceId;
    this.capabilitiesForSignals = capabilities;

    const iceServers =
      envelope.payload.type === 'stream.request' && this.userId
        ? buildIceConfiguration(this.context.config.ice, this.userId, this.context.now())
            .iceServers
        : [];

    this.send({
      kind: 'cloud.signal',
      protocolVersion: PROTOCOL_VERSION,
      envelope,
      deviceId,
      iceServers,
      audioAllowed: this.capabilitiesForSignals.includes('audio'),
      clipboardAllowed: this.capabilitiesForSignals.includes('clipboard'),
      terminalAllowed: this.capabilitiesForSignals.includes('terminal'),
      filesAllowed: this.capabilitiesForSignals.includes('file-transfer'),
    });
  }

  notifyKillSwitch(enabled: boolean): void {
    this.send({
      kind: 'cloud.kill-switch',
      protocolVersion: PROTOCOL_VERSION,
      remoteAccessEnabled: enabled,
      changedAt: this.context.now().toISOString(),
    });
  }

  ping(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping();
  }

  private send(message: CloudMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    try {
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
  }

  private onClose(code: number, reason: string): void {
    this.state = 'closed';
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.context.agents.remove(this);

    if (!this.pcId) return;

    // Mark the PC offline immediately rather than waiting for the presence sweep: the
    // dashboard must never claim a machine is reachable once its link is gone.
    void this.context.repos.pcs
      .setPresence(this.pcId, { status: 'offline', route: null })
      .catch((error: unknown) => {
        this.logger.error(
          { pcId: this.pcId, err: String(error) },
          'Failed to mark PC offline after disconnect',
        );
      });

    // Anyone watching this PC is now watching nothing. Say so rather than leaving a
    // client waiting for an answer that will not come.
    for (const client of this.context.clients.forPc(this.pcId)) {
      client.notifyPeerGone('agent-disconnected', 'The WOLF agent on this PC disconnected.');
    }

    void this.context.repos.remoteDesktop
      .endStreamsForPc(this.pcId, 'agent-disconnected')
      .catch(() => undefined);

    this.logger.info({ pcId: this.pcId, code, reason }, 'Agent link closed');
  }
}

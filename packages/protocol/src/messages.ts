import { z } from 'zod';
import { base64Url, isoDateTime, wolfId } from '@wolf/validation';
import { WINDOWS_SESSION_STATES } from '@wolf/shared-types';
import { telemetryBatch } from '@wolf/telemetry-schema';
import { commandEnvelope, commandProgress, commandResult, PROTOCOL_VERSION } from './envelope.js';
import { systemCapabilitiesResult, systemInfoResult } from './results.js';
import { iceServer, signalEnvelope } from './signaling.js';

/**
 * Agent link protocol.
 *
 * The PC always dials out to the cloud; the cloud never needs an inbound port on the PC.
 * The link is authenticated by challenge and response over the PC's Ed25519 identity key,
 * on top of TLS, so a stolen bearer token alone cannot impersonate a PC.
 */

/** Cloud -> agent: sent immediately on connect, before anything else is accepted. */
export const challengeMessage = z.object({
  kind: z.literal('cloud.challenge'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** Random per-connection nonce. Signing it proves possession of the PC private key. */
  nonce: base64Url.max(128),
  serverTime: isoDateTime,
});

/** Agent -> cloud: response to the challenge. */
export const agentAuthMessage = z.object({
  kind: z.literal('agent.auth'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  pcId: wolfId,
  agentVersion: z.string().max(64),
  /** Ed25519 signature over the canonical challenge string. */
  signature: base64Url.max(256),
  /** Echoed so the server can reject a response bound to a different nonce. */
  nonce: base64Url.max(128),
});

/** Cloud -> agent: authentication accepted; the link may now carry traffic. */
export const authAcceptedMessage = z.object({
  kind: z.literal('cloud.auth-accepted'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  pcId: wolfId,
  serverTime: isoDateTime,
  /** Heartbeat cadence the agent must honour to stay marked online. */
  heartbeatSeconds: z.number().int().min(5).max(300),
  /** Telemetry upload cadence for batched samples. */
  telemetryUploadSeconds: z.number().int().min(1).max(300),
  /** Remote access state as the cloud knows it, so the agent can reconcile a kill switch. */
  remoteAccessEnabled: z.boolean(),
});

/** Cloud -> agent: authentication refused. The agent must not retry in a tight loop. */
export const authRejectedMessage = z.object({
  kind: z.literal('cloud.auth-rejected'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reason: z.enum([
    'unknown-pc',
    'revoked',
    'bad-signature',
    'expired-challenge',
    'protocol-version',
    'rate-limited',
  ]),
  /** Seconds the agent should wait before reconnecting. */
  retryAfterSeconds: z.number().int().min(0).max(86_400),
});

/** Agent -> cloud: full identity and capability report, sent right after authentication. */
export const agentHelloMessage = z.object({
  kind: z.literal('agent.hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  info: systemInfoResult,
  capabilities: systemCapabilitiesResult,
  sessionState: z.enum(WINDOWS_SESSION_STATES),
  /** True when the local kill switch is engaged on the PC itself. */
  localKillSwitchEngaged: z.boolean(),
  /** Commands the agent buffered while offline and still holds. */
  queuedResultCount: z.number().int().nonnegative().default(0),
});

export const agentHeartbeatMessage = z.object({
  kind: z.literal('agent.heartbeat'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  at: isoDateTime,
  sessionState: z.enum(WINDOWS_SESSION_STATES),
  localKillSwitchEngaged: z.boolean(),
  activeSessionCount: z.number().int().nonnegative(),
});

export const agentTelemetryMessage = z.object({
  kind: z.literal('agent.telemetry'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  batch: telemetryBatch,
});

export const agentCommandResultMessage = z.object({
  kind: z.literal('agent.command-result'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  result: commandResult,
});

export const agentCommandProgressMessage = z.object({
  kind: z.literal('agent.command-progress'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  progress: commandProgress,
});

/** Agent -> cloud: something happened on the PC that was not the result of a command. */
export const agentEventMessage = z.object({
  kind: z.literal('agent.event'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  event: z.object({
    at: isoDateTime,
    type: z.enum([
      'session-state-changed',
      'process-started',
      'process-exited',
      'process-crashed',
      'power-action-scheduled',
      'power-action-cancelled',
      'kill-switch-changed',
      'agent-started',
      'agent-stopping',
      'capability-changed',
    ]),
    /** Structured, already-redacted detail. Never carries content, only metadata. */
    detail: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  }),
});

/**
 * Agent -> cloud: a WebRTC signaling message for a client.
 *
 * Signaling rides the link that is already authenticated rather than opening a second one.
 * The relay validates the envelope and checks the session before forwarding, so this is a
 * routed message, not a tunnel.
 */
export const agentSignalMessage = z.object({
  kind: z.literal('agent.signal'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: signalEnvelope,
});

export const agentMessage = z.discriminatedUnion('kind', [
  agentAuthMessage,
  agentHelloMessage,
  agentHeartbeatMessage,
  agentTelemetryMessage,
  agentCommandResultMessage,
  agentCommandProgressMessage,
  agentEventMessage,
  agentSignalMessage,
]);
export type AgentMessage = z.infer<typeof agentMessage>;

/** Cloud -> agent: dispatch a command. */
export const cloudCommandMessage = z.object({
  kind: z.literal('cloud.command'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: commandEnvelope,
});

/** Cloud -> agent: withdraw a command that has not reached a terminal state. */
export const cloudCancelMessage = z.object({
  kind: z.literal('cloud.cancel'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: wolfId,
  reason: z.enum(['operator-cancelled', 'expired', 'superseded', 'kill-switch']),
});

/** Cloud -> agent: remote kill switch state changed. */
export const cloudKillSwitchMessage = z.object({
  kind: z.literal('cloud.kill-switch'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  remoteAccessEnabled: z.boolean(),
  /**
   * Re-enabling after a remote kill switch requires local authentication on the PC, so the
   * cloud can only ever turn access off; a `true` here is a reconciliation signal, and the
   * agent still refuses it unless a local operator released the switch.
   */
  changedAt: isoDateTime,
});

/** Cloud -> agent: a WebRTC signaling message from a client. */
export const cloudSignalMessage = z.object({
  kind: z.literal('cloud.signal'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: signalEnvelope,
  /** Device the signaling came from, recorded by the agent for its local audit trail. */
  deviceId: wolfId,
  /**
   * ICE servers for the agent's side of this connection.
   *
   * Attached by the relay, never by the client, and never carried inside the signaling
   * payload: TURN credentials are minted server-side from a secret the agent does not hold
   * and the client must not choose. They ride with the request that needs them rather than
   * being handed out at connect, because they are short-lived and an agent link outlives
   * them by days.
   *
   * Empty when no STUN or TURN server is configured, which is the shipped default and means
   * the stream connects on the local network only.
   */
  iceServers: z.array(iceServer).max(8).default([]),
  /**
   * Whether this session may hear the PC.
   *
   * Decided by the relay from the session's capabilities, and attached rather than left to
   * the request, because a client asking for audio is not the same as a client being
   * allowed it. `screen` and `audio` are granted separately: watching a machine and
   * listening to it are different intrusions, and somebody may reasonably be given one and
   * not the other.
   */
  audioAllowed: z.boolean().default(false),
  /**
   * Whether this session may exchange clipboard content with the PC.
   *
   * Separate from `audio` and `screen` for the same reason they are separate from each
   * other: reading what somebody copied is its own intrusion, and a session granted a view
   * of a screen has not thereby been given the contents of their clipboard.
   */
  clipboardAllowed: z.boolean().default(false),
  /**
   * Whether this session may run commands on the PC.
   *
   * Separate again, and the one where the separation matters most: a terminal is arbitrary
   * command execution, and nothing else WOLF grants implies it. Defaulted false, so a
   * message that lost the field produces a stream with no terminal rather than a shell
   * nobody authorised.
   */
  terminalAllowed: z.boolean().default(false),
  /**
   * Whether this session may browse and move this PC's files.
   *
   * Separate again. Watching a screen is not being handed the disks behind it, and the two
   * are asked for and granted independently. Defaulted false, so a message that lost the
   * field produces a stream that cannot read a directory rather than one that can read
   * everything the signed-in user can.
   */
  filesAllowed: z.boolean().default(false),
});

export const cloudPingMessage = z.object({
  kind: z.literal('cloud.ping'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  at: isoDateTime,
});

export const cloudMessage = z.discriminatedUnion('kind', [
  challengeMessage,
  authAcceptedMessage,
  authRejectedMessage,
  cloudCommandMessage,
  cloudCancelMessage,
  cloudKillSwitchMessage,
  cloudSignalMessage,
  cloudPingMessage,
]);
export type CloudMessage = z.infer<typeof cloudMessage>;

/**
 * Canonical string an agent signs to prove PC identity. Binding the pcId and version into
 * the signed material stops a signature captured for one PC from being replayed for another.
 */
export function challengeSigningPayload(pcId: string, nonce: string): string {
  return `wolf-agent-auth v${PROTOCOL_VERSION} ${pcId} ${nonce}`;
}

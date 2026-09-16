import { z } from 'zod';
import { isoDateTime, wolfId } from '@wolf/validation';
import {
  streamNegotiation,
  streamRequest,
  streamState,
  streamStats,
  streamSurface,
  streamUnavailableReason,
} from './remote-desktop.js';
import { PROTOCOL_VERSION } from './envelope.js';

/**
 * WebRTC signaling.
 *
 * SDP and ICE candidates ride links that already exist and are already authenticated: the
 * browser's WebSocket to the realtime service, and the realtime service's existing link to
 * the agent. Nothing here is a tunnel — every message is validated and bound to a session,
 * and the relaying service checks that the session is live, belongs to the caller, and
 * holds the `screen` capability before passing a single byte along.
 *
 * The agent is the offerer. It is the side that knows which encoders the machine actually
 * has, so having it offer means the SDP describes reality instead of a request the client
 * hopes can be met.
 */

/** SDP bodies are a few kilobytes; the cap is a sanity bound, not a tuning knob. */
const sdpBody = z.string().min(1).max(32_768);

export const signalStreamRequest = z.object({
  type: z.literal('stream.request'),
  request: streamRequest,
});

/** The agent settled the negotiation and is about to offer. */
export const signalStreamReady = z.object({
  type: z.literal('stream.ready'),
  negotiation: streamNegotiation,
});

export const signalOffer = z.object({
  type: z.literal('sdp.offer'),
  sdp: sdpBody,
});

export const signalAnswer = z.object({
  type: z.literal('sdp.answer'),
  sdp: sdpBody,
});

export const signalCandidate = z.object({
  type: z.literal('ice.candidate'),
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable(),
  sdpMLineIndex: z.number().int().min(0).max(32).nullable(),
  usernameFragment: z.string().max(256).nullable().default(null),
});

/** Sent by either side once it has no more candidates to offer. */
export const signalCandidatesDone = z.object({
  type: z.literal('ice.complete'),
});

export const signalStreamState = z.object({
  type: z.literal('stream.state'),
  state: streamState,
  /** Present whenever the stream is not running, so the UI never has to guess why. */
  unavailableReason: streamUnavailableReason.nullable().default(null),
  detail: z.string().max(200).nullable().default(null),
  /**
   * Which desktop the frames are coming from.
   *
   * Defaults to the ordinary one, so an agent that predates this field is read as showing
   * the desktop rather than as showing nothing in particular.
   */
  showing: streamSurface.default('desktop'),
});

export const signalStreamStats = z.object({
  type: z.literal('stream.stats'),
  stats: streamStats,
});

export const signalStreamStop = z.object({
  type: z.literal('stream.stop'),
  reason: z.enum([
    'client-closed',
    'session-ended',
    'control-transferred',
    'kill-switch',
    'agent-shutdown',
    'superseded',
    'error',
  ]),
  detail: z.string().max(200).nullable().default(null),
});

/**
 * A profile change on a live stream.
 *
 * Applied without renegotiating where possible — bitrate and frame rate are encoder
 * settings, not SDP. A resolution change may force a key frame, which the agent reports in
 * the stats rather than hiding.
 */
export const signalSetProfile = z.object({
  type: z.literal('stream.set-profile'),
  profile: streamRequest.shape.profile,
});

/**
 * Ask to control the PC's keyboard and mouse.
 *
 * Sent repeatedly while control is held, not once: the lease it produces expires, so an
 * operator who walks away stops holding the keyboard, and a cloud that becomes unreachable
 * cannot leave a PC permanently controllable. The relay answers with `input.control`.
 */
/**
 * Look at a different display on the same PC.
 *
 * Applied in place rather than by restarting the stream: tearing down and renegotiating
 * costs a fresh ICE exchange and several seconds of black screen, which is a lot to pay for
 * looking at the other monitor. The agent answers with a new `stream.ready` describing what
 * it switched to, because the resolution usually changes with it.
 */
export const signalSetDisplay = z.object({
  type: z.literal('stream.set-display'),
  /** Null means the primary display. */
  displayId: z.string().max(256).nullable(),
});

export const signalInputRequest = z.object({
  type: z.literal('input.request'),
});

export const signalInputRelease = z.object({
  type: z.literal('input.release'),
});

/**
 * Who holds input, decided by the cloud and told to both ends.
 *
 * Deliberately in neither direction list. A client cannot send it, so it cannot claim
 * control it was not granted; an agent cannot send it, so a compromised agent cannot
 * convince a dashboard that somebody else is driving. The relay is the only author,
 * because the relay is the only party that can arbitrate between two sessions.
 *
 * `expiresAt` is what the session host enforces. It stops injecting when the lease lapses
 * whether or not anything arrives to tell it to, which is the property that survives the
 * cloud going away mid-session.
 */
export const signalInputControl = z.object({
  type: z.literal('input.control'),
  granted: z.boolean(),
  /** The session that holds input, which may be another one. */
  holderSessionId: wolfId.nullable().default(null),
  expiresAt: isoDateTime.nullable().default(null),
  reason: z
    .enum([
      'granted',
      'capability-missing',
      'held-by-another-session',
      'released',
      'session-ended',
      'kill-switch',
      'unsupported',
    ])
    .nullable()
    .default(null),
});

export const signalTerminalRequest = z.object({
  type: z.literal('terminal.request'),
});

export const signalTerminalRelease = z.object({
  type: z.literal('terminal.release'),
});

/**
 * Who holds the terminal, decided by the cloud and told to both ends.
 *
 * The same shape and the same rules as `input.control`, and in neither direction list for
 * the same reasons — but the stakes are higher, so it is worth saying plainly what this
 * gates. A session holding this lease can run commands on somebody's PC. Two sessions
 * holding it at once would produce a command line neither operator typed.
 *
 * `expiresAt` is enforced on the PC as well as here. When it lapses the session host closes
 * every shell that stream had open, because a command prompt left running on a machine
 * nobody is watching is exactly what a lease exists to prevent.
 */
export const signalTerminalControl = z.object({
  type: z.literal('terminal.control'),
  granted: z.boolean(),
  holderSessionId: wolfId.nullable().default(null),
  expiresAt: isoDateTime.nullable().default(null),
  reason: z
    .enum([
      'granted',
      'capability-missing',
      'held-by-another-session',
      'released',
      'session-ended',
      'kill-switch',
      'unsupported',
    ])
    .nullable()
    .default(null),
});

export const signalFileRequest = z.object({
  type: z.literal('file.request'),
});

export const signalFileRelease = z.object({
  type: z.literal('file.release'),
});

/**
 * Who may browse and move this PC's files, decided by the cloud.
 *
 * The third of these, with the same shape and the same rules — relay-authored, expiry
 * enforced on the PC as well as here. What it gates is different in kind from the other two:
 * input and a terminal act on a machine, and this one takes things off it. A session holding
 * this lease can read anything the signed-in user can read, so it is granted separately and
 * lapses on its own.
 */
export const signalFileControl = z.object({
  type: z.literal('file.control'),
  granted: z.boolean(),
  holderSessionId: wolfId.nullable().default(null),
  expiresAt: isoDateTime.nullable().default(null),
  reason: z
    .enum([
      'granted',
      'capability-missing',
      'held-by-another-session',
      'released',
      'session-ended',
      'kill-switch',
      'unsupported',
    ])
    .nullable()
    .default(null),
});

/**
 * A file operation happened on the PC, for the audit trail: which, how it ended, and never a path.
 *
 * Agent to relay only. The relay records it and forwards it nowhere.
 */
export const signalFileActivity = z.object({
  type: z.literal('file.activity'),
  operation: z.enum(['delete', 'rename', 'move', 'create-folder', 'upload', 'download']),
  outcome: z.enum(['completed', 'refused']),
  /** The refusal's code (`access-denied`, `exists`, …) — never its detail, which can name a path. */
  reason: z.string().max(32).nullable().default(null),
  /** For a transfer, its size. */
  bytes: z.number().int().min(0).nullable().default(null),
});

export const signalError = z.object({
  type: z.literal('stream.error'),
  code: z.string().max(64),
  message: z.string().max(300),
  /** True when Windows itself prevents this, rather than WOLF failing. */
  limitation: z.boolean().default(false),
  recommendedAction: z.string().max(300).nullable().default(null),
});

export const signalPayload = z.discriminatedUnion('type', [
  signalStreamRequest,
  signalStreamReady,
  signalOffer,
  signalAnswer,
  signalCandidate,
  signalCandidatesDone,
  signalStreamState,
  signalFileActivity,
  signalStreamStats,
  signalStreamStop,
  signalSetProfile,
  signalSetDisplay,
  signalInputRequest,
  signalInputRelease,
  signalInputControl,
  signalTerminalRequest,
  signalTerminalRelease,
  signalTerminalControl,
  signalFileRequest,
  signalFileRelease,
  signalFileControl,
  signalError,
]);
export type SignalPayload = z.infer<typeof signalPayload>;
export type SignalPayloadType = SignalPayload['type'];

/**
 * Envelope carried between client and agent.
 *
 * `sessionId` is what the relay authorizes against; `streamId` distinguishes streams
 * within one session, so a second display can be opened without tearing down the first.
 */
export const signalEnvelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: wolfId,
  streamId: wolfId,
  sentAt: isoDateTime,
  payload: signalPayload,
});
export type SignalEnvelope = z.infer<typeof signalEnvelope>;

/**
 * Which direction each payload may travel.
 *
 * The relay enforces this: a client cannot inject a `stream.stats` message that would make
 * the dashboard believe a stream is healthy, and an agent cannot send itself a
 * `stream.request`. Direction is part of the contract, not a convention.
 *
 * A payload in neither list is one only the relay may author. `input.control` is the
 * example: it decides who is allowed to drive a PC, so neither end gets to assert it.
 */
export const CLIENT_TO_AGENT_PAYLOADS: readonly SignalPayloadType[] = [
  'stream.request',
  'sdp.answer',
  'ice.candidate',
  'ice.complete',
  'stream.stop',
  'stream.set-profile',
  'stream.set-display',
  'input.request',
  'input.release',
  'terminal.request',
  'terminal.release',
  'file.request',
  'file.release',
];

/**
 * Sent by an agent for the relay alone, and forwarded to nobody.
 *
 * `file.activity` is how the audit trail learns that a file was changed or moved without learning which: the
 * operation and its outcome, never a path.
 */
export const AGENT_TO_RELAY_PAYLOADS: readonly SignalPayloadType[] = ['file.activity'];

export function isAgentToRelay(type: SignalPayloadType): boolean {
  return AGENT_TO_RELAY_PAYLOADS.includes(type);
}

export const AGENT_TO_CLIENT_PAYLOADS: readonly SignalPayloadType[] = [
  'stream.ready',
  'sdp.offer',
  'ice.candidate',
  'ice.complete',
  'stream.state',
  'stream.stats',
  'stream.stop',
  'stream.error',
];

export function isClientToAgent(type: SignalPayloadType): boolean {
  return CLIENT_TO_AGENT_PAYLOADS.includes(type);
}

export function isAgentToClient(type: SignalPayloadType): boolean {
  return AGENT_TO_CLIENT_PAYLOADS.includes(type);
}

// ---------------------------------------------------------------------------
// Client link (browser or Android <-> realtime service)
// ---------------------------------------------------------------------------

/**
 * First message on a client socket. Nothing else is accepted until it succeeds.
 *
 * The token is a session token: scoped to one PC, one session, and the capabilities that
 * session was granted. An account token cannot open a stream.
 */
export const clientAuthMessage = z.object({
  kind: z.literal('client.auth'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /**
   * Only an upper bound here. A token that is too short to be real is still handed to the
   * verifier, so the client gets a stated reason instead of an unexplained socket close —
   * a browser holding a corrupted token needs to know it should sign in again.
   */
  sessionToken: z.string().min(1).max(4096),
});

export const clientSignalMessage = z.object({
  kind: z.literal('client.signal'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: signalEnvelope,
});

export const clientPingMessage = z.object({
  kind: z.literal('client.ping'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  at: isoDateTime,
});

export const clientMessage = z.discriminatedUnion('kind', [
  clientAuthMessage,
  clientSignalMessage,
  clientPingMessage,
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export const clientAuthAcceptedMessage = z.object({
  kind: z.literal('cloud.client-auth-accepted'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: wolfId,
  pcId: wolfId,
  capabilities: z.array(z.string().max(32)).max(32),
  /** False when the PC's agent is not connected; the client should not offer to stream. */
  agentConnected: z.boolean(),
  serverTime: isoDateTime,
});

export const clientAuthRejectedMessage = z.object({
  kind: z.literal('cloud.client-auth-rejected'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reason: z.enum([
    'bad-token',
    'expired-token',
    'session-ended',
    'capability-missing',
    'kill-switch',
    'protocol-version',
    'rate-limited',
  ]),
  detail: z.string().max(200),
});

export const cloudClientSignalMessage = z.object({
  kind: z.literal('cloud.signal'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  envelope: signalEnvelope,
});

/** Sent when the far side goes away, so a client stops waiting for an answer. */
export const cloudPeerGoneMessage = z.object({
  kind: z.literal('cloud.peer-gone'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reason: z.enum(['agent-disconnected', 'session-ended', 'kill-switch']),
  detail: z.string().max(200),
});

export const cloudClientMessage = z.discriminatedUnion('kind', [
  clientAuthAcceptedMessage,
  clientAuthRejectedMessage,
  cloudClientSignalMessage,
  cloudPeerGoneMessage,
]);
export type CloudClientMessage = z.infer<typeof cloudClientMessage>;

// ---------------------------------------------------------------------------
// ICE configuration
// ---------------------------------------------------------------------------

/**
 * ICE servers handed to a peer.
 *
 * TURN credentials are short-lived and derived from a shared secret, so they can be issued
 * without storing anything per session and stop working on their own. The relay only ever
 * sees encrypted media it cannot read.
 */
export const iceServer = z.object({
  urls: z.array(z.string().max(300)).min(1).max(8),
  username: z.string().max(200).nullable().default(null),
  credential: z.string().max(300).nullable().default(null),
});
export type IceServer = z.infer<typeof iceServer>;

export const iceConfiguration = z.object({
  iceServers: z.array(iceServer).max(8),
  expiresAt: isoDateTime,
  /**
   * "all" gathers host, reflexive, and relay candidates so LAN and P2P can win.
   * "relay" forces TURN, which is only useful for diagnosing a broken direct path.
   */
  iceTransportPolicy: z.enum(['all', 'relay']).default('all'),
});
export type IceConfiguration = z.infer<typeof iceConfiguration>;

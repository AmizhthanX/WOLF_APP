import { z } from 'zod';
import { isoDateTime, wolfId } from '@wolf/validation';
import { WINDOWS_SESSION_STATES } from '@wolf/shared-types';
import { telemetrySample } from '@wolf/telemetry-schema';
import { powerAction, processPriority } from './commands/index.js';
import { displayInfo, streamState, streamUnavailableReason } from './remote-desktop.js';
import type { AgentCommandType } from './commands/index.js';

/** Digital signature state of a process image. `unknown` is a real answer, not a default. */
export const signatureStatus = z.enum(['signed-valid', 'signed-invalid', 'unsigned', 'unknown']);

export const processInfo = z.object({
  pid: z.number().int().nonnegative(),
  parentPid: z.number().int().nonnegative().nullable(),
  name: z.string().max(260),
  /** Full image path; null when the agent lacks rights to read it for that process. */
  path: z.string().max(4096).nullable(),
  /** Command-line arguments, only populated when the agent could read them. */
  commandLine: z.string().max(8192).nullable(),
  userName: z.string().max(256).nullable(),
  sessionId: z.number().int().nonnegative().nullable(),
  status: z.enum(['running', 'suspended', 'not-responding', 'unknown']).default('unknown'),
  startedAt: isoDateTime.nullable(),
  cpuPercent: z.number().min(0).nullable(),
  cpuTimeSeconds: z.number().nonnegative().nullable(),
  workingSetBytes: z.number().nonnegative().nullable(),
  privateBytes: z.number().nonnegative().nullable(),
  gpuPercent: z.number().min(0).max(100).nullable(),
  gpuMemoryBytes: z.number().nonnegative().nullable(),
  threadCount: z.number().int().nonnegative().nullable(),
  handleCount: z.number().int().nonnegative().nullable(),
  diskReadBytesPerSecond: z.number().nonnegative().nullable(),
  diskWriteBytesPerSecond: z.number().nonnegative().nullable(),
  networkBytesPerSecond: z.number().nonnegative().nullable(),
  priority: processPriority.nullable(),
  publisher: z.string().max(256).nullable(),
  signature: signatureStatus.default('unknown'),
  /** Windows service names hosted by this process, for svchost and similar hosts. */
  serviceNames: z.array(z.string().max(256)).max(64).default([]),
  /** True when WOLF will refuse or escalate termination of this process. */
  protectedProcess: z.boolean().default(false),
});
export type ProcessInfo = z.infer<typeof processInfo>;

export const processListResult = z.object({
  sampledAt: isoDateTime,
  processes: z.array(processInfo),
  /** True when `limit` cut the list short, so the UI can say so instead of implying totality. */
  truncated: z.boolean().default(false),
  totalCount: z.number().int().nonnegative(),
});

export const processTreeNode = z.object({
  pid: z.number().int().nonnegative(),
  parentPid: z.number().int().nonnegative().nullable(),
  name: z.string().max(260),
  cpuPercent: z.number().min(0).nullable(),
  workingSetBytes: z.number().nonnegative().nullable(),
});

export const processTreeResult = z.object({
  sampledAt: isoDateTime,
  nodes: z.array(processTreeNode),
});

export const processDetailsResult = z.object({
  sampledAt: isoDateTime,
  process: processInfo,
});

export const processTerminateResult = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string().max(260),
  /** How the process actually ended, which is not always how it was asked to end. */
  method: z.enum(['graceful-close', 'terminated', 'tree-terminated']),
  childrenTerminated: z.number().int().nonnegative().default(0),
  endedAt: isoDateTime,
});

export const processSetPriorityResult = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string().max(260),
  previousPriority: processPriority.nullable(),
  priority: processPriority,
});

export const processStartResult = z.object({
  applicationId: wolfId,
  pid: z.number().int().nonnegative(),
  startedAt: isoDateTime,
});

export const systemInfoResult = z.object({
  hostname: z.string().max(256),
  osName: z.string().max(200),
  osVersion: z.string().max(64),
  osBuild: z.string().max(64),
  architecture: z.string().max(32),
  cpuModel: z.string().max(200).nullable(),
  cpuCores: z.number().int().positive().nullable(),
  cpuThreads: z.number().int().positive().nullable(),
  totalMemoryBytes: z.number().nonnegative().nullable(),
  gpus: z.array(z.string().max(200)).max(8).default([]),
  bootedAt: isoDateTime.nullable(),
  agentVersion: z.string().max(64),
});

export const systemCapabilitiesResult = z.object({
  hardwareVideoEncoders: z.array(z.string().max(64)).max(16).default([]),
  preferredVideoCodec: z.string().max(32).nullable(),
  displayCount: z.number().int().nonnegative(),
  audioCaptureAvailable: z.boolean(),
  wakeOnLanCapable: z.boolean(),
  privilegedHelperAvailable: z.boolean(),
  /**
   * Whether this PC can capture the Windows secure desktop (lock and login screens).
   * Reported honestly: when false, WOLF shows the LOCKED or LOGIN state instead of a
   * stream, rather than presenting a blank frame as if it were the desktop.
   */
  secureDesktopCaptureAvailable: z.boolean(),
  remoteUnlockProvisioned: z.boolean(),
  gpuVendors: z.array(z.string().max(64)).max(8).default([]),
  windowsBuild: z.string().max(64).nullable(),
  /** Command types this agent build can actually execute. */
  supportedCommands: z.array(z.string().max(64)).max(256).default([]),

  /**
   * Whether this PC can stream its screen right now.
   *
   * Reported directly rather than inferred from the encoder list, because having an
   * encoder and being able to capture are different questions: nobody may be signed in,
   * the workstation may be locked, or the agent build may not implement capture. A UI that
   * inferred availability from hardware would offer a stream that can never start.
   */
  remoteDesktopAvailable: z.boolean().default(false),
  /** Why not, when not. A code, so the UI can tell "wait" apart from "never". */
  remoteDesktopUnavailableReason: streamUnavailableReason.nullable().default(null),
  /** Every encoder detected, hardware and software, for diagnosing a soft stream. */
  videoEncoders: z.array(z.string().max(64)).max(32).default([]),
});

export const systemSessionStateResult = z.object({
  state: z.enum(WINDOWS_SESSION_STATES),
  /** Console session id, when one is attached. */
  sessionId: z.number().int().nonnegative().nullable(),
  userName: z.string().max(256).nullable(),
  observedAt: isoDateTime,
});

export const systemTelemetrySnapshotResult = z.object({
  sample: telemetrySample,
});

export const pendingPowerAction = z.object({
  pendingActionId: z.string().max(64),
  action: powerAction,
  runAt: isoDateTime,
  force: z.boolean(),
  requestedBy: wolfId.nullable(),
  cancellable: z.boolean(),
});

export const powerActionResult = z.object({
  action: powerAction,
  /** Present when the action was deferred by a countdown rather than run immediately. */
  pendingActionId: z.string().max(64).nullable(),
  runAt: isoDateTime,
  /** False when Windows accepted the request but the transition has not completed yet. */
  completed: z.boolean(),
});

export const powerScheduleResult = z.object({
  pendingActionId: z.string().max(64),
  action: powerAction,
  runAt: isoDateTime,
});

export const powerCancelResult = z.object({
  pendingActionId: z.string().max(64),
  cancelled: z.boolean(),
});

export const powerPendingResult = z.object({
  actions: z.array(pendingPowerAction).max(64),
});

export const powerWakeResult = z.object({
  targetPcId: wolfId,
  method: z.enum(['lan-broadcast', 'peer-agent', 'relay']),
  packetsSent: z.number().int().nonnegative(),
  sentAt: isoDateTime,
  /** Wake is fire-and-forget: whether the PC actually woke is confirmed by it reconnecting. */
  confirmationPending: z.literal(true),
});

export const powerUnlockResult = z.object({
  unlocked: z.boolean(),
  sessionState: z.enum(WINDOWS_SESSION_STATES),
  observedAt: isoDateTime,
});

export const remoteDesktopListDisplaysResult = z.object({
  displays: z.array(displayInfo).max(16),
  observedAt: isoDateTime,
});

/**
 * Whether this PC can stream right now.
 *
 * `available: false` with a transient reason (locked, login, signed-out) is a normal
 * answer, not a fault — the operator can wait it out. The UI distinguishes the two, which
 * is why the reason is a code rather than prose.
 */
export const remoteDesktopStatusResult = z.object({
  available: z.boolean(),
  unavailableReason: streamUnavailableReason.nullable(),
  /** The capture process running in the interactive session, if there is one. */
  sessionHostRunning: z.boolean(),
  sessionHostVersion: z.string().max(64).nullable(),
  windowsSessionState: z.enum(WINDOWS_SESSION_STATES),
  /** Encoders detected on this machine, e.g. ["h264-qsv", "h264-software"]. */
  availableEncoders: z.array(z.string().max(64)).max(16).default([]),
  displayCount: z.number().int().nonnegative(),
  activeStreams: z
    .array(
      z.object({
        streamId: wolfId,
        sessionId: wolfId,
        state: streamState,
        startedAt: isoDateTime,
      }),
    )
    .max(8)
    .default([]),
  observedAt: isoDateTime,
});

export const remoteDesktopStopResult = z.object({
  stopped: z.number().int().nonnegative(),
  observedAt: isoDateTime,
});

/** Result schema for every command type, so results are validated on both sides. */
export const RESULT_SCHEMAS = {
  'system.info': systemInfoResult,
  'system.capabilities': systemCapabilitiesResult,
  'system.telemetry-snapshot': systemTelemetrySnapshotResult,
  'system.session-state': systemSessionStateResult,
  'process.list': processListResult,
  'process.tree': processTreeResult,
  'process.details': processDetailsResult,
  'process.terminate': processTerminateResult,
  'process.set-priority': processSetPriorityResult,
  'process.start': processStartResult,
  'power.action': powerActionResult,
  'power.schedule': powerScheduleResult,
  'power.cancel': powerCancelResult,
  'power.pending': powerPendingResult,
  'power.wake': powerWakeResult,
  'power.unlock': powerUnlockResult,
  'remote-desktop.list-displays': remoteDesktopListDisplaysResult,
  'remote-desktop.status': remoteDesktopStatusResult,
  'remote-desktop.stop': remoteDesktopStopResult,
} as const satisfies Record<AgentCommandType, z.ZodTypeAny>;

export type ResultFor<T extends AgentCommandType> = z.infer<(typeof RESULT_SCHEMAS)[T]>;

export function resultSchemaFor<T extends AgentCommandType>(type: T): (typeof RESULT_SCHEMAS)[T] {
  return RESULT_SCHEMAS[type];
}

import type { PcId, UserId } from './ids.js';
import type { ConnectionRoute, WindowsSessionState } from './connection.js';

export const PC_STATUSES = ['online', 'offline', 'unreachable', 'sleeping'] as const;
export type PcStatus = (typeof PC_STATUSES)[number];

export const PC_REGISTRATION_STATES = ['pending', 'active', 'revoked'] as const;
export type PcRegistrationState = (typeof PC_REGISTRATION_STATES)[number];

/** What the agent has determined this PC can actually do. Never assumed, always probed. */
export interface PcCapabilities {
  readonly hardwareVideoEncoders: readonly string[];
  readonly preferredVideoCodec: string | null;
  readonly displayCount: number;
  readonly audioCaptureAvailable: boolean;
  readonly wakeOnLanCapable: boolean;
  readonly privilegedHelperAvailable: boolean;
  readonly secureDesktopCaptureAvailable: boolean;
  readonly remoteUnlockProvisioned: boolean;
  readonly gpuVendors: readonly string[];
  readonly windowsBuild: string | null;
  /** Whether the PC can stream right now, as opposed to having the hardware to. */
  readonly remoteDesktopAvailable: boolean;
  readonly remoteDesktopUnavailableReason: string | null;
  /** Every detected encoder, hardware and software. */
  readonly videoEncoders: readonly string[];
}

export interface PcHardwareSummary {
  readonly cpuModel: string | null;
  readonly cpuCores: number | null;
  readonly cpuThreads: number | null;
  readonly totalMemoryBytes: number | null;
  readonly gpus: readonly string[];
  readonly osName: string | null;
  readonly osVersion: string | null;
  readonly machineArchitecture: string | null;
}

/** Operational health indicator. Not a guaranteed diagnostic. */
export interface PcHealth {
  /** 0-100 operational indicator; null while insufficient data has been collected. */
  readonly score: number | null;
  readonly factors: readonly PcHealthFactor[];
  readonly evaluatedAt: string;
}

export interface PcHealthFactor {
  readonly key: string;
  readonly label: string;
  readonly status: 'ok' | 'warning' | 'critical' | 'unknown';
  readonly detail: string | null;
}

export interface Pc {
  readonly id: PcId;
  readonly userId: UserId;
  readonly name: string;
  readonly hostname: string | null;
  readonly status: PcStatus;
  readonly registrationState: PcRegistrationState;
  readonly agentVersion: string | null;
  readonly lastSeenAt: string | null;
  readonly connectionRoute: ConnectionRoute | null;
  readonly windowsSessionState: WindowsSessionState;
  /** Remote access disabled locally or remotely by the kill switch. */
  readonly remoteAccessEnabled: boolean;
  readonly tags: readonly string[];
  readonly groupIds: readonly string[];
  readonly favorite: boolean;
  readonly createdAt: string;
}

export interface PcSummary extends Pc {
  readonly capabilities: PcCapabilities | null;
  readonly hardware: PcHardwareSummary | null;
  readonly health: PcHealth | null;
  readonly activeSessionCount: number;
  readonly pendingCommandCount: number;
}

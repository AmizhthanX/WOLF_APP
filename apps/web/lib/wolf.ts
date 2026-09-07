'use client';

import { api } from './client';

/**
 * Typed calls against the WOLF API.
 *
 * These mirror the shapes the API returns. Where a value can genuinely be unknown — a
 * counter the agent could not read, a capability it has not detected — the type is
 * nullable, and the UI is expected to say so rather than substitute a zero.
 */

export type PcStatus = 'online' | 'offline' | 'unreachable' | 'sleeping';
export type ConnectionRoute = 'lan' | 'p2p' | 'relay';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PcCapabilities {
  hardwareVideoEncoders: string[];
  preferredVideoCodec: string | null;
  displayCount: number;
  audioCaptureAvailable: boolean;
  wakeOnLanCapable: boolean;
  privilegedHelperAvailable: boolean;
  secureDesktopCaptureAvailable: boolean;
  remoteUnlockProvisioned: boolean;
  gpuVendors: string[];
  windowsBuild: string | null;
  supportedCommands: string[];
  /**
   * Whether the PC can stream right now. Reported by the agent rather than inferred from
   * the encoder list, because owning an encoder and being able to capture are different
   * questions and only the agent can answer the second.
   */
  remoteDesktopAvailable: boolean;
  remoteDesktopUnavailableReason: string | null;
  /** Every detected encoder, hardware and software. */
  videoEncoders: string[];
}

export interface DisplayInfo {
  id: string;
  name: string;
  widthPixels: number;
  heightPixels: number;
  refreshHz: number | null;
  primary: boolean;
  scaleFactor: number | null;
  hdr: boolean;
  originX: number;
  originY: number;
}

export interface IceConfigurationResponse {
  configuration: {
    iceServers: { urls: string[]; username: string | null; credential: string | null }[];
    expiresAt: string;
    iceTransportPolicy: 'all' | 'relay';
  };
  reachability: 'lan-only' | 'lan-and-internet';
  note: string | null;
}

export const getIceServers = (pcId: string, bearer: string) =>
  api<IceConfigurationResponse>(`/api/v1/pcs/${pcId}/ice-servers`, { bearer });

export interface PcHardware {
  cpuModel: string | null;
  cpuCores: number | null;
  cpuThreads: number | null;
  totalMemoryBytes: number | null;
  gpus: string[];
  osName: string | null;
  osVersion: string | null;
  machineArchitecture: string | null;
}

export interface Pc {
  id: string;
  name: string;
  hostname: string | null;
  status: PcStatus;
  registrationState: 'pending' | 'active' | 'revoked';
  agentVersion: string | null;
  lastSeenAt: string | null;
  connectionRoute: ConnectionRoute | null;
  windowsSessionState: 'desktop' | 'locked' | 'login' | 'restarting' | 'offline' | 'unknown';
  remoteAccessEnabled: boolean;
  tags: string[];
  favorite: boolean;
  capabilities: PcCapabilities | null;
  hardware: PcHardware | null;
  activeSessionCount: number;
  pendingCommandCount: number;
}

export interface TelemetrySample {
  sampledAt: string;
  uptimeSeconds: number | null;
  cpu: {
    usagePercent: number | null;
    perCorePercent: number[];
    temperatureCelsius: number | null;
    queueLength: number | null;
  };
  memory: {
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
  };
  disks: {
    volume: string;
    label: string | null;
    totalBytes: number | null;
    freeBytes: number | null;
    activeTimePercent: number | null;
    healthStatus: string;
  }[];
  networks: {
    adapterId: string;
    name: string;
    kind: string;
    up: boolean;
    receiveBytesPerSecond: number | null;
    sendBytesPerSecond: number | null;
  }[];
  battery: { present: boolean; chargePercent: number | null; charging: boolean | null } | null;
  agent: { cpuPercent: number | null; memoryBytes: number | null } | null;
}

export interface CommandView {
  id: string;
  type: string;
  riskLevel: RiskLevel;
  status:
    | 'pending'
    | 'queued'
    | 'sent'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'rejected';
  createdAt: string;
  completedAt: string | null;
  failure: { code: string; message: string | null; limitation: boolean } | null;
  result: unknown;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  category: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'pending';
  riskLevel: RiskLevel;
  target: Record<string, string | number | boolean | null> | null;
  errorCode: string | null;
}

export interface SessionGrant {
  session: { id: string; capabilities: string[]; expiresAt: string };
  sessionToken: string;
  sessionTokenExpiresAt: string;
}

export const listPcs = () => api<{ pcs: Pc[] }>('/api/v1/pcs');

export const getPc = (pcId: string) =>
  api<{ pc: Pc; sessions: unknown[]; latestTelemetry: TelemetrySample | null }>(
    `/api/v1/pcs/${pcId}`,
  );

export const getLatestTelemetry = (pcId: string) =>
  api<{ sample: TelemetrySample | null; sampledAt: string | null; pcStatus: PcStatus }>(
    `/api/v1/pcs/${pcId}/telemetry/latest`,
  );

export const listAudit = (pcId: string, limit = 50) =>
  api<{ events: AuditEvent[]; nextCursor: string | null }>(
    `/api/v1/pcs/${pcId}/audit?limit=${limit}`,
  );

export const listCommands = (pcId: string, limit = 25) =>
  api<{ commands: CommandView[] }>(`/api/v1/pcs/${pcId}/commands?limit=${limit}`);

export const openSession = (pcId: string, capabilities: string[]) =>
  api<SessionGrant>(`/api/v1/pcs/${pcId}/sessions`, {
    method: 'POST',
    body: { mode: 'control', capabilities },
  });

export interface DispatchOptions {
  bearer: string;
  command: { type: string; payload: Record<string, unknown> };
  confirmedRiskLevel?: RiskLevel;
  privilegedGrantId?: string;
  waitSeconds?: number;
}

/**
 * Send a command and, by default, wait briefly for its result.
 *
 * Waiting makes read commands feel synchronous without holding a socket open: the API
 * polls the durable command row, so the answer arrives even if the result lands on a
 * different API instance.
 */
export const dispatch = (pcId: string, options: DispatchOptions) =>
  api<{ command: CommandView; deduplicated: boolean }>(`/api/v1/pcs/${pcId}/commands`, {
    method: 'POST',
    bearer: options.bearer,
    body: {
      command: options.command,
      confirmedRiskLevel: options.confirmedRiskLevel,
      privilegedGrantId: options.privilegedGrantId,
      waitSeconds: options.waitSeconds ?? 8,
    },
  });

export const refreshSessionToken = (pcId: string, sessionId: string) =>
  api<SessionGrant>(`/api/v1/pcs/${pcId}/sessions/${sessionId}/token`, { method: 'POST' });

export const requestPrivilegedGrant = (pcId: string, purpose: string, bearer: string) =>
  api<{ grant: { id: string; expiresAt: string } }>(`/api/v1/pcs/${pcId}/privileged-grants`, {
    method: 'POST',
    bearer,
    body: { purpose, expiresInSeconds: 120 },
  });

export const reauthenticate = (password: string) =>
  api<{ accessToken: string; accessTokenExpiresAt: string }>('/api/v1/auth/reauthenticate', {
    method: 'POST',
    body: { password },
  });

export const engageKillSwitch = (pcId: string, reason?: string) =>
  api<{ pc: Pc; note: string }>(`/api/v1/pcs/${pcId}/kill-switch`, {
    method: 'POST',
    body: { remoteAccessEnabled: false, reason },
  });

export const createEnrollmentToken = (label?: string) =>
  api<{ enrollmentToken: string; token: { id: string; expiresAt: string } }>(
    '/api/v1/pcs/enrollment-tokens',
    { method: 'POST', body: { label, expiresInMinutes: 60 } },
  );

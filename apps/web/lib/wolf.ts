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
  gpus: {
    adapterId: string;
    name: string;
    usagePercent: number | null;
    graphicsEnginePercent: number | null;
    computeEnginePercent: number | null;
    videoEncodeEnginePercent: number | null;
    videoDecodeEnginePercent: number | null;
    vramTotalBytes: number | null;
    vramUsedBytes: number | null;
    temperatureCelsius: number | null;
  }[];
  disks: {
    volume: string;
    label: string | null;
    totalBytes: number | null;
    freeBytes: number | null;
    activeTimePercent: number | null;
    temperatureCelsius: number | null;
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

/* ------------------------------------------------------------------------- */
/* Alerts and notifications                                                   */
/* ------------------------------------------------------------------------- */

export type AlertCondition = 'metric-above' | 'metric-below' | 'pc-offline';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  /** Null watches every PC on the account, including ones enrolled later. */
  pcId: string | null;
  name: string;
  condition: AlertCondition;
  metric: string | null;
  seriesKey: string | null;
  threshold: number | null;
  forMinutes: number;
  severity: AlertSeverity;
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AlertRuleInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>;

export interface WolfNotification {
  id: string;
  ruleId: string | null;
  pcId: string | null;
  kind: 'fired' | 'resolved' | 'automation';
  automationId: string | null;
  severity: AlertSeverity;
  title: string;
  detail: string;
  metric: string | null;
  seriesKey: string | null;
  value: number | null;
  threshold: number | null;
  occurredAt: string;
  readAt: string | null;
}

export const listAlertRules = () =>
  api<{ rules: AlertRule[]; limit: number }>('/api/v1/alert-rules');

export const createAlertRule = (rule: AlertRuleInput) =>
  api<{ rule: AlertRule }>('/api/v1/alert-rules', { method: 'POST', body: rule });

export const updateAlertRule = (ruleId: string, patch: Partial<AlertRuleInput>) =>
  api<{ rule: AlertRule }>(`/api/v1/alert-rules/${ruleId}`, { method: 'PATCH', body: patch });

export const deleteAlertRule = (ruleId: string) =>
  api<void>(`/api/v1/alert-rules/${ruleId}`, { method: 'DELETE' });

export const listNotifications = (options: { unreadOnly?: boolean; limit?: number } = {}) =>
  api<{ notifications: WolfNotification[]; unreadCount: number }>(
    `/api/v1/notifications?unread=${options.unreadOnly ? 'true' : 'false'}&limit=${options.limit ?? 50}`,
  );

export const markNotificationRead = (notificationId: string) =>
  api<void>(`/api/v1/notifications/${notificationId}/read`, { method: 'POST' });

export const markAllNotificationsRead = () =>
  api<{ marked: number }>('/api/v1/notifications/read-all', { method: 'POST' });

/* ------------------------------------------------------------------------- */
/* Insights                                                                   */
/* ------------------------------------------------------------------------- */

export interface StorageForecast {
  volume: string;
  label: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
  healthStatus: string;
  temperatureCelsius: number | null;
  trend: 'insufficient-history' | 'not-growing' | 'growing' | 'shrinking';
  growthBytesPerDay: number | null;
  daysUntilFull: number | null;
  fullAt: string | null;
  historyDays: number;
  fit: 'good' | 'poor' | null;
}

export interface GpuInsight {
  adapterId: string;
  name: string;
  windowHours: number;
  coverage: 'ok' | 'insufficient-history';
  averageUsagePercent: number | null;
  busiestFiveMinuteP95Percent: number | null;
  heavyLoadShare: number | null;
  peakTemperatureCelsius: number | null;
  peakVramUsedBytes: number | null;
  vramTotalBytes: number | null;
  peakVramShare: number | null;
}

export interface Finding {
  severity: 'info' | 'warning' | 'critical';
  subject: 'storage' | 'gpu';
  key: string;
  code: string;
  title: string;
  detail: string;
}

export interface PcInsights {
  generatedAt: string;
  sampledAt: string | null;
  storage: StorageForecast[];
  gpus: GpuInsight[];
  findings: Finding[];
}

export const getInsights = (pcId: string) => api<PcInsights>(`/api/v1/pcs/${pcId}/insights`);

/* ------------------------------------------------------------------------- */
/* Automations                                                                */
/* ------------------------------------------------------------------------- */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type AutomationTrigger =
  | { kind: 'schedule'; time: string; days: Weekday[]; timeZone: string }
  | { kind: 'alert'; ruleId: string | null; on: 'fired' | 'resolved' }
  | { kind: 'manual' };

export type AutomationCondition =
  | { kind: 'time-window'; start: string; end: string; days: Weekday[]; timeZone: string }
  | { kind: 'metric'; metric: string; seriesKey: string | null; comparison: 'above' | 'below'; threshold: number }
  | { kind: 'no-active-session' };

export type AutomationAction =
  | { kind: 'notify'; severity: AlertSeverity; message: string }
  | { kind: 'command'; command: { type: string; payload: Record<string, unknown> } };

export type AutomationTargets = { mode: 'pcs'; pcIds: string[] } | { mode: 'alert-pc' };

export interface AutomationDefinition {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  targets: AutomationTargets;
  cooldownMinutes: number;
  maxRunsPerDay: number;
}

export interface Automation extends AutomationDefinition {
  id: string;
  authorizedRiskLevel: RiskLevel;
  authorizedAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  pcId: string | null;
  triggerKind: 'schedule' | 'alert' | 'manual';
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';
  reason: string | null;
  steps: {
    index: number;
    kind: 'notify' | 'command';
    status: 'completed' | 'failed' | 'skipped';
    commandId: string | null;
    commandType: string | null;
    detail: string | null;
  }[];
  startedAt: string;
  finishedAt: string | null;
}

export const listAutomations = () =>
  api<{ automations: Automation[]; limit: number }>('/api/v1/automations');

export const createAutomation = (automation: AutomationDefinition, confirmedRiskLevel?: RiskLevel) =>
  api<{ automation: Automation }>('/api/v1/automations', {
    method: 'POST',
    body: { automation, confirmedRiskLevel },
  });

export const updateAutomation = (
  automationId: string,
  patch: Partial<AutomationDefinition>,
  confirmedRiskLevel?: RiskLevel,
) =>
  api<{ automation: Automation }>(`/api/v1/automations/${automationId}`, {
    method: 'PATCH',
    body: { automation: patch, confirmedRiskLevel },
  });

export const deleteAutomation = (automationId: string) =>
  api<void>(`/api/v1/automations/${automationId}`, { method: 'DELETE' });

export const runAutomation = (automationId: string) =>
  api<{ accepted: boolean; pcIds: string[] }>(`/api/v1/automations/${automationId}/run`, { method: 'POST' });

export const listAutomationRuns = (automationId: string, limit = 20) =>
  api<{ runs: AutomationRun[] }>(`/api/v1/automations/${automationId}/runs?limit=${limit}`);

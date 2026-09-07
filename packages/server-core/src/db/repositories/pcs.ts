import type {
  ConnectionRoute,
  Pc,
  PcCapabilities,
  PcHardwareSummary,
  PcStatus,
  WindowsSessionState,
} from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';

interface PcRow {
  id: string;
  user_id: string;
  name: string;
  hostname: string | null;
  status: PcStatus;
  registration_state: 'pending' | 'active' | 'revoked';
  agent_version: string | null;
  public_key: string | null;
  windows_session_state: WindowsSessionState;
  connection_route: ConnectionRoute | null;
  remote_access_enabled: boolean;
  local_kill_switch_engaged: boolean;
  favorite: boolean;
  tags: string[];
  created_at: Date;
  last_seen_at: Date | null;
}

const COLUMNS = `id, user_id, name, hostname, status, registration_state, agent_version,
                 public_key, windows_session_state, connection_route, remote_access_enabled,
                 local_kill_switch_engaged, favorite, tags, created_at, last_seen_at`;

function toPc(row: PcRow): Pc {
  return {
    id: row.id as Pc['id'],
    userId: row.user_id as Pc['userId'],
    name: row.name,
    hostname: row.hostname,
    status: row.status,
    registrationState: row.registration_state,
    agentVersion: row.agent_version,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    connectionRoute: row.connection_route,
    windowsSessionState: row.windows_session_state,
    remoteAccessEnabled: row.remote_access_enabled,
    tags: row.tags,
    groupIds: [],
    favorite: row.favorite,
    createdAt: row.created_at.toISOString(),
  };
}

export interface PcIdentity {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: string | null;
  readonly registrationState: 'pending' | 'active' | 'revoked';
  readonly remoteAccessEnabled: boolean;
}

export class PcRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string, userId: string): Promise<Pc | null> {
    const { rows } = await this.db.query<PcRow>(
      `SELECT ${COLUMNS} FROM pcs WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toPc(rows[0]) : null;
  }

  /** Identity lookup for the agent link, which authenticates before any user context exists. */
  async findIdentity(id: string): Promise<PcIdentity | null> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      public_key: string | null;
      registration_state: 'pending' | 'active' | 'revoked';
      remote_access_enabled: boolean;
    }>(
      `SELECT id, user_id, public_key, registration_state, remote_access_enabled
         FROM pcs WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          publicKey: row.public_key,
          registrationState: row.registration_state,
          remoteAccessEnabled: row.remote_access_enabled,
        }
      : null;
  }

  async listForUser(userId: string): Promise<Pc[]> {
    const { rows } = await this.db.query<PcRow>(
      `SELECT ${COLUMNS} FROM pcs
        WHERE user_id = $1 AND registration_state <> 'revoked'
        ORDER BY favorite DESC, name ASC`,
      [userId],
    );
    return rows.map(toPc);
  }

  async create(
    input: {
      id: string;
      userId: string;
      name: string;
      hostname: string | null;
      publicKey: string;
      agentVersion: string | null;
    },
    client?: DatabaseClient,
  ): Promise<Pc> {
    const executor = client ?? this.db;
    const { rows } = await executor.query<PcRow>(
      `INSERT INTO pcs (id, user_id, name, hostname, public_key, agent_version,
                        registration_state, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 'offline')
       RETURNING ${COLUMNS}`,
      [input.id, input.userId, input.name, input.hostname, input.publicKey, input.agentVersion],
    );
    return toPc(rows[0]!);
  }

  async rename(id: string, userId: string, name: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE pcs SET name = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
      [id, userId, name],
    );
    return (rowCount ?? 0) > 0;
  }

  async setPresence(
    id: string,
    presence: {
      status: PcStatus;
      sessionState?: WindowsSessionState;
      route?: ConnectionRoute | null;
      agentVersion?: string | null;
      localKillSwitchEngaged?: boolean;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE pcs
          SET status = $2,
              windows_session_state = COALESCE($3, windows_session_state),
              connection_route = $4,
              agent_version = COALESCE($5, agent_version),
              local_kill_switch_engaged = COALESCE($6, local_kill_switch_engaged),
              last_seen_at = COALESCE($7, last_seen_at),
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        presence.status,
        presence.sessionState ?? null,
        presence.route ?? null,
        presence.agentVersion ?? null,
        presence.localKillSwitchEngaged ?? null,
        presence.lastSeenAt ?? null,
      ],
    );
  }

  /**
   * Kill switch. A remote caller may only ever disable remote access; re-enabling requires
   * local authentication on the PC, which the agent performs and reports.
   */
  async setRemoteAccess(
    id: string,
    userId: string,
    enabled: boolean,
    source: 'remote' | 'local',
  ): Promise<boolean> {
    if (enabled && source === 'remote') {
      throw new Error('Remote callers cannot re-enable remote access.');
    }
    const { rowCount } = await this.db.query(
      'UPDATE pcs SET remote_access_enabled = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
      [id, userId, enabled],
    );
    return (rowCount ?? 0) > 0;
  }

  async revoke(id: string, userId: string, client?: DatabaseClient): Promise<boolean> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE pcs
          SET registration_state = 'revoked', revoked_at = now(), status = 'offline',
              remote_access_enabled = FALSE, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND registration_state <> 'revoked'`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async upsertCapabilities(
    pcId: string,
    capabilities: PcCapabilities & { supportedCommands: readonly string[] },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO pc_capabilities
         (pc_id, hardware_video_encoders, preferred_video_codec, display_count,
          audio_capture_available, wake_on_lan_capable, privileged_helper_available,
          secure_desktop_capture_available, remote_unlock_provisioned, gpu_vendors,
          windows_build, supported_commands, remote_desktop_available,
          remote_desktop_unavailable_reason, video_encoders, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       ON CONFLICT (pc_id) DO UPDATE SET
         hardware_video_encoders = EXCLUDED.hardware_video_encoders,
         preferred_video_codec = EXCLUDED.preferred_video_codec,
         display_count = EXCLUDED.display_count,
         audio_capture_available = EXCLUDED.audio_capture_available,
         wake_on_lan_capable = EXCLUDED.wake_on_lan_capable,
         privileged_helper_available = EXCLUDED.privileged_helper_available,
         secure_desktop_capture_available = EXCLUDED.secure_desktop_capture_available,
         remote_unlock_provisioned = EXCLUDED.remote_unlock_provisioned,
         gpu_vendors = EXCLUDED.gpu_vendors,
         windows_build = EXCLUDED.windows_build,
         supported_commands = EXCLUDED.supported_commands,
         remote_desktop_available = EXCLUDED.remote_desktop_available,
         remote_desktop_unavailable_reason = EXCLUDED.remote_desktop_unavailable_reason,
         video_encoders = EXCLUDED.video_encoders,
         updated_at = now()`,
      [
        pcId,
        capabilities.hardwareVideoEncoders,
        capabilities.preferredVideoCodec,
        capabilities.displayCount,
        capabilities.audioCaptureAvailable,
        capabilities.wakeOnLanCapable,
        capabilities.privilegedHelperAvailable,
        capabilities.secureDesktopCaptureAvailable,
        capabilities.remoteUnlockProvisioned,
        capabilities.gpuVendors,
        capabilities.windowsBuild,
        capabilities.supportedCommands,
        capabilities.remoteDesktopAvailable,
        capabilities.remoteDesktopUnavailableReason,
        capabilities.videoEncoders,
      ],
    );
  }

  async getCapabilities(
    pcId: string,
  ): Promise<(PcCapabilities & { supportedCommands: string[] }) | null> {
    const { rows } = await this.db.query<{
      hardware_video_encoders: string[];
      preferred_video_codec: string | null;
      display_count: number;
      audio_capture_available: boolean;
      wake_on_lan_capable: boolean;
      privileged_helper_available: boolean;
      secure_desktop_capture_available: boolean;
      remote_unlock_provisioned: boolean;
      gpu_vendors: string[];
      windows_build: string | null;
      supported_commands: string[];
      remote_desktop_available: boolean;
      remote_desktop_unavailable_reason: string | null;
      video_encoders: string[];
    }>('SELECT * FROM pc_capabilities WHERE pc_id = $1', [pcId]);
    const row = rows[0];
    if (!row) return null;
    return {
      hardwareVideoEncoders: row.hardware_video_encoders,
      preferredVideoCodec: row.preferred_video_codec,
      displayCount: row.display_count,
      audioCaptureAvailable: row.audio_capture_available,
      wakeOnLanCapable: row.wake_on_lan_capable,
      privilegedHelperAvailable: row.privileged_helper_available,
      secureDesktopCaptureAvailable: row.secure_desktop_capture_available,
      remoteUnlockProvisioned: row.remote_unlock_provisioned,
      gpuVendors: row.gpu_vendors,
      windowsBuild: row.windows_build,
      supportedCommands: row.supported_commands,
      remoteDesktopAvailable: row.remote_desktop_available,
      remoteDesktopUnavailableReason: row.remote_desktop_unavailable_reason,
      videoEncoders: row.video_encoders,
    };
  }

  async upsertHardware(
    pcId: string,
    hardware: PcHardwareSummary & { osBuild: string | null; bootedAt: string | null },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO pc_hardware
         (pc_id, cpu_model, cpu_cores, cpu_threads, total_memory_bytes, gpus,
          os_name, os_version, os_build, architecture, booted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (pc_id) DO UPDATE SET
         cpu_model = EXCLUDED.cpu_model,
         cpu_cores = EXCLUDED.cpu_cores,
         cpu_threads = EXCLUDED.cpu_threads,
         total_memory_bytes = EXCLUDED.total_memory_bytes,
         gpus = EXCLUDED.gpus,
         os_name = EXCLUDED.os_name,
         os_version = EXCLUDED.os_version,
         os_build = EXCLUDED.os_build,
         architecture = EXCLUDED.architecture,
         booted_at = EXCLUDED.booted_at,
         updated_at = now()`,
      [
        pcId,
        hardware.cpuModel,
        hardware.cpuCores,
        hardware.cpuThreads,
        hardware.totalMemoryBytes,
        hardware.gpus,
        hardware.osName,
        hardware.osVersion,
        hardware.osBuild,
        hardware.machineArchitecture,
        hardware.bootedAt,
      ],
    );
  }

  async getHardware(pcId: string): Promise<PcHardwareSummary | null> {
    const { rows } = await this.db.query<{
      cpu_model: string | null;
      cpu_cores: number | null;
      cpu_threads: number | null;
      total_memory_bytes: number | null;
      gpus: string[];
      os_name: string | null;
      os_version: string | null;
      architecture: string | null;
    }>('SELECT * FROM pc_hardware WHERE pc_id = $1', [pcId]);
    const row = rows[0];
    if (!row) return null;
    return {
      cpuModel: row.cpu_model,
      cpuCores: row.cpu_cores,
      cpuThreads: row.cpu_threads,
      totalMemoryBytes: row.total_memory_bytes,
      gpus: row.gpus,
      osName: row.os_name,
      osVersion: row.os_version,
      machineArchitecture: row.architecture,
    };
  }

  /** Mark every PC that has stopped heartbeating as offline. */
  async markStaleOffline(cutoff: Date): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE pcs
          SET status = 'offline', connection_route = NULL, updated_at = now()
        WHERE status <> 'offline' AND (last_seen_at IS NULL OR last_seen_at < $1)
        RETURNING id`,
      [cutoff],
    );
    return rows.map((row) => row.id);
  }
}

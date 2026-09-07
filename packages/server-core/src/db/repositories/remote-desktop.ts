import type { ConnectionRoute } from '@wolf/shared-types';
import type {
  RemoteDesktopProfile,
  StreamState,
  StreamStats,
  StreamUnavailableReason,
  VideoCodec,
} from '@wolf/protocol';
import type { Database, DatabaseClient } from '../pool.js';

export interface ProfileRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly settings: RemoteDesktopProfile;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  settings: RemoteDesktopProfile;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    settings: row.settings,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface StreamRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pcId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly displayId: string | null;
  readonly videoCodec: VideoCodec | null;
  readonly hardwareEncoded: boolean | null;
  readonly audioEnabled: boolean;
  readonly state: StreamState;
  readonly route: ConnectionRoute | null;
  readonly unavailableReason: StreamUnavailableReason | null;
  readonly lastStats: StreamStats | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
}

interface StreamRow {
  id: string;
  session_id: string;
  pc_id: string;
  user_id: string;
  device_id: string;
  display_id: string | null;
  video_codec: VideoCodec | null;
  hardware_encoded: boolean | null;
  audio_enabled: boolean;
  state: StreamState;
  route: ConnectionRoute | null;
  unavailable_reason: StreamUnavailableReason | null;
  last_stats: StreamStats | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

function toStream(row: StreamRow): StreamRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    pcId: row.pc_id,
    userId: row.user_id,
    deviceId: row.device_id,
    displayId: row.display_id,
    videoCodec: row.video_codec,
    hardwareEncoded: row.hardware_encoded,
    audioEnabled: row.audio_enabled,
    state: row.state,
    route: row.route,
    unavailableReason: row.unavailable_reason,
    lastStats: row.last_stats,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

const STREAM_COLUMNS = `id, session_id, pc_id, user_id, device_id, display_id, video_codec,
                        hardware_encoded, audio_enabled, state, route, unavailable_reason,
                        last_stats, started_at, ended_at, end_reason`;

/**
 * Remote desktop storage.
 *
 * Profiles are user preferences. Stream records are observability: what was negotiated,
 * how it performed, and why it stopped. No frame, no audio sample, and no input event is
 * ever written here — the point of keeping stats is to answer "why was it slow" without
 * retaining anything that would answer "what were you doing".
 */
export class RemoteDesktopRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  async listProfiles(userId: string): Promise<ProfileRecord[]> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT id, user_id, name, settings, is_default, created_at, updated_at
         FROM remote_desktop_profiles
        WHERE user_id = $1
        ORDER BY is_default DESC, name ASC`,
      [userId],
    );
    return rows.map(toProfile);
  }

  async findProfile(id: string, userId: string): Promise<ProfileRecord | null> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT id, user_id, name, settings, is_default, created_at, updated_at
         FROM remote_desktop_profiles WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async findDefaultProfile(userId: string): Promise<ProfileRecord | null> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT id, user_id, name, settings, is_default, created_at, updated_at
         FROM remote_desktop_profiles WHERE user_id = $1 AND is_default`,
      [userId],
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async createProfile(input: {
    id: string;
    userId: string;
    name: string;
    settings: RemoteDesktopProfile;
    isDefault: boolean;
  }): Promise<ProfileRecord> {
    return this.withDefaultCleared(input.userId, input.isDefault, async (client) => {
      const { rows } = await client.query<ProfileRow>(
        `INSERT INTO remote_desktop_profiles (id, user_id, name, settings, is_default)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, name, settings, is_default, created_at, updated_at`,
        [input.id, input.userId, input.name, JSON.stringify(input.settings), input.isDefault],
      );
      return toProfile(rows[0]!);
    });
  }

  async updateProfile(input: {
    id: string;
    userId: string;
    name: string;
    settings: RemoteDesktopProfile;
    isDefault: boolean;
  }): Promise<ProfileRecord | null> {
    return this.withDefaultCleared(input.userId, input.isDefault, async (client) => {
      const { rows } = await client.query<ProfileRow>(
        `UPDATE remote_desktop_profiles
            SET name = $3, settings = $4, is_default = $5, updated_at = now()
          WHERE id = $1 AND user_id = $2
          RETURNING id, user_id, name, settings, is_default, created_at, updated_at`,
        [input.id, input.userId, input.name, JSON.stringify(input.settings), input.isDefault],
      );
      return rows[0] ? toProfile(rows[0]) : null;
    });
  }

  async deleteProfile(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM remote_desktop_profiles WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Clear the existing default before setting a new one.
   *
   * The partial unique index would otherwise reject the write, and doing the clear inside
   * the same transaction means there is never a moment with two defaults or none.
   */
  private async withDefaultCleared<T>(
    userId: string,
    isDefault: boolean,
    work: (client: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      if (isDefault) {
        await client.query(
          'UPDATE remote_desktop_profiles SET is_default = FALSE WHERE user_id = $1 AND is_default',
          [userId],
        );
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  async createStream(
    input: {
      id: string;
      sessionId: string;
      pcId: string;
      userId: string;
      deviceId: string;
      displayId: string | null;
      audioEnabled: boolean;
      requestedProfile: RemoteDesktopProfile;
    },
    client?: DatabaseClient,
  ): Promise<StreamRecord> {
    const executor = client ?? this.db;
    const { rows } = await executor.query<StreamRow>(
      `INSERT INTO stream_sessions
         (id, session_id, pc_id, user_id, device_id, display_id, audio_enabled, requested_profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${STREAM_COLUMNS}`,
      [
        input.id,
        input.sessionId,
        input.pcId,
        input.userId,
        input.deviceId,
        input.displayId,
        input.audioEnabled,
        JSON.stringify(input.requestedProfile),
      ],
    );
    return toStream(rows[0]!);
  }

  async findStream(id: string): Promise<StreamRecord | null> {
    const { rows } = await this.db.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM stream_sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? toStream(rows[0]) : null;
  }

  async listActiveStreams(pcId: string): Promise<StreamRecord[]> {
    const { rows } = await this.db.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM stream_sessions
        WHERE pc_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC`,
      [pcId],
    );
    return rows.map(toStream);
  }

  /** Record what the agent settled on, which is not always what the client asked for. */
  async recordNegotiation(input: {
    id: string;
    displayId: string;
    videoCodec: VideoCodec;
    hardwareEncoded: boolean;
    effectiveProfile: RemoteDesktopProfile;
  }): Promise<void> {
    await this.db.query(
      `UPDATE stream_sessions
          SET display_id = $2, video_codec = $3, hardware_encoded = $4, effective_profile = $5
        WHERE id = $1 AND ended_at IS NULL`,
      [
        input.id,
        input.displayId,
        input.videoCodec,
        input.hardwareEncoded,
        JSON.stringify(input.effectiveProfile),
      ],
    );
  }

  async updateState(input: {
    id: string;
    state: StreamState;
    route?: ConnectionRoute | null;
    unavailableReason?: StreamUnavailableReason | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE stream_sessions
          SET state = $2,
              route = COALESCE($3, route),
              unavailable_reason = $4
        WHERE id = $1 AND ended_at IS NULL`,
      [input.id, input.state, input.route ?? null, input.unavailableReason ?? null],
    );
  }

  /** Store the latest stats sample. Metadata only — never content. */
  async recordStats(id: string, stats: StreamStats): Promise<void> {
    await this.db.query(
      `UPDATE stream_sessions
          SET last_stats = $2, state = $3, route = COALESCE($4, route)
        WHERE id = $1 AND ended_at IS NULL`,
      [id, JSON.stringify(stats), stats.state, stats.route],
    );
  }

  async endStream(id: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE stream_sessions
          SET ended_at = now(), end_reason = $2, state = 'OFFLINE'
        WHERE id = $1 AND ended_at IS NULL`,
      [id, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  async endStreamsForSession(sessionId: string, reason: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE stream_sessions
          SET ended_at = now(), end_reason = $2, state = 'OFFLINE'
        WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId, reason],
    );
    return rowCount ?? 0;
  }

  async endStreamsForPc(pcId: string, reason: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE stream_sessions
          SET ended_at = now(), end_reason = $2, state = 'OFFLINE'
        WHERE pc_id = $1 AND ended_at IS NULL`,
      [pcId, reason],
    );
    return rowCount ?? 0;
  }
}

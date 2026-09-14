import type {
  ConnectionRoute,
  ConnectionState,
  ExclusiveResource,
  Session,
  SessionCapability,
  SessionMode,
  SessionStatus,
} from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  pc_id: string;
  mode: SessionMode;
  status: SessionStatus;
  state: ConnectionState;
  route: ConnectionRoute | null;
  capabilities: SessionCapability[];
  started_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  ended_at: Date | null;
}

const COLUMNS = `id, user_id, device_id, pc_id, mode, status, state, route, capabilities,
                 started_at, last_activity_at, expires_at, ended_at`;

function toSession(row: SessionRow, heldResources: ExclusiveResource[] = []): Session {
  return {
    id: row.id as Session['id'],
    userId: row.user_id as Session['userId'],
    deviceId: row.device_id as Session['deviceId'],
    pcId: row.pc_id as Session['pcId'],
    mode: row.mode,
    status: row.status,
    state: row.state,
    route: row.route,
    capabilities: row.capabilities,
    startedAt: row.started_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    heldResources,
  };
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(
    input: {
      id: string;
      userId: string;
      deviceId: string;
      pcId: string;
      mode: SessionMode;
      capabilities: readonly SessionCapability[];
      route: ConnectionRoute | null;
      expiresAt: Date;
    },
    client?: DatabaseClient,
  ): Promise<Session> {
    const executor = client ?? this.db;
    const { rows } = await executor.query<SessionRow>(
      `INSERT INTO sessions (id, user_id, device_id, pc_id, mode, capabilities, route, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONNECTING', $8)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.userId,
        input.deviceId,
        input.pcId,
        input.mode,
        input.capabilities,
        input.route,
        input.expiresAt,
      ],
    );
    return toSession(rows[0]!);
  }

  async findById(id: string): Promise<Session | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return null;
    return toSession(rows[0], await this.heldResources(id));
  }

  /** A session that has ended or expired must never authorize anything. */
  async findActive(id: string, userId: string, now: Date = new Date()): Promise<Session | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND expires_at > $3`,
      [id, userId, now],
    );
    if (!rows[0]) return null;
    return toSession(rows[0], await this.heldResources(id));
  }

  async listActiveForPc(pcId: string): Promise<Session[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions
        WHERE pc_id = $1 AND ended_at IS NULL AND expires_at > now()
        ORDER BY started_at DESC`,
      [pcId],
    );
    return rows.map((row) => toSession(row));
  }

  /** The live session holding a resource on a PC, or null. Never takes the lease. */
  async activeResourceHolder(pcId: string, resource: ExclusiveResource): Promise<string | null> {
    const { rows } = await this.db.query<{ session_id: string }>(
      `SELECT l.session_id FROM session_resource_leases l
         JOIN sessions s ON s.id = l.session_id
        WHERE l.pc_id = $1 AND l.resource = $2 AND l.expires_at > now()
          AND s.ended_at IS NULL AND s.expires_at > now()`,
      [pcId, resource],
    );
    return rows[0]?.session_id ?? null;
  }

  async countActiveForPc(pcId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM sessions
        WHERE pc_id = $1 AND ended_at IS NULL AND expires_at > now()`,
      [pcId],
    );
    return rows[0]?.count ?? 0;
  }

  async touch(id: string, at: Date, state?: ConnectionState, route?: ConnectionRoute): Promise<void> {
    await this.db.query(
      `UPDATE sessions
          SET last_activity_at = $2,
              state = COALESCE($3, state),
              route = COALESCE($4, route),
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
        WHERE id = $1 AND ended_at IS NULL`,
      [id, at, state ?? null, route ?? null],
    );
  }

  async end(id: string, reason: string, client?: DatabaseClient): Promise<boolean> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE sessions
          SET status = 'ended', state = 'DISCONNECTED', ended_at = now(), end_reason = $2
        WHERE id = $1 AND ended_at IS NULL`,
      [id, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  async endAllForPc(pcId: string, reason: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE sessions
          SET status = 'ended', state = 'DISCONNECTED', ended_at = now(), end_reason = $2
        WHERE pc_id = $1 AND ended_at IS NULL`,
      [pcId, reason],
    );
    return rowCount ?? 0;
  }

  async endAllForDevice(deviceId: string, reason: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE sessions
          SET status = 'ended', state = 'DISCONNECTED', ended_at = now(), end_reason = $2
        WHERE device_id = $1 AND ended_at IS NULL`,
      [deviceId, reason],
    );
    return rowCount ?? 0;
  }

  // -------------------------------------------------------------------------
  // Exclusive resource arbitration
  // -------------------------------------------------------------------------

  async heldResources(sessionId: string): Promise<ExclusiveResource[]> {
    const { rows } = await this.db.query<{ resource: ExclusiveResource }>(
      'SELECT resource FROM session_resource_leases WHERE session_id = $1 AND expires_at > now()',
      [sessionId],
    );
    return rows.map((row) => row.resource);
  }

  /**
   * Take an exclusive resource for a session.
   *
   * Succeeds when the resource is free or already held by this session, or when the
   * current lease has expired — an idle operator must not hold input forever. It never
   * takes a live lease from another session; that requires an explicit control transfer.
   */
  async acquireResource(input: {
    pcId: string;
    resource: ExclusiveResource;
    sessionId: string;
    expiresAt: Date;
  }): Promise<{ acquired: boolean; heldBy: string | null }> {
    const { rows } = await this.db.query<{ session_id: string }>(
      `INSERT INTO session_resource_leases (pc_id, resource, session_id, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pc_id, resource) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             acquired_at = now(),
             expires_at = EXCLUDED.expires_at
       WHERE session_resource_leases.session_id = EXCLUDED.session_id
          OR session_resource_leases.expires_at <= now()
       RETURNING session_id`,
      [input.pcId, input.resource, input.sessionId, input.expiresAt],
    );

    if (rows[0]) return { acquired: true, heldBy: input.sessionId };

    const { rows: holder } = await this.db.query<{ session_id: string }>(
      'SELECT session_id FROM session_resource_leases WHERE pc_id = $1 AND resource = $2',
      [input.pcId, input.resource],
    );
    return { acquired: false, heldBy: holder[0]?.session_id ?? null };
  }

  async releaseResource(
    pcId: string,
    resource: ExclusiveResource,
    sessionId: string,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM session_resource_leases WHERE pc_id = $1 AND resource = $2 AND session_id = $3',
      [pcId, resource, sessionId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Transfer a live lease to another session. Used by an explicit control transfer. */
  async transferResource(input: {
    pcId: string;
    resource: ExclusiveResource;
    fromSessionId: string;
    toSessionId: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE session_resource_leases
          SET session_id = $4, acquired_at = now(), expires_at = $5
        WHERE pc_id = $1 AND resource = $2 AND session_id = $3`,
      [
        input.pcId,
        input.resource,
        input.fromSessionId,
        input.toSessionId,
        input.expiresAt,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordEvent(
    input: { id: string; sessionId: string; type: string; detail?: Record<string, unknown> },
    client?: DatabaseClient,
  ): Promise<void> {
    const executor = client ?? this.db;
    await executor.query(
      'INSERT INTO session_events (id, session_id, type, detail) VALUES ($1, $2, $3, $4)',
      [input.id, input.sessionId, input.type, JSON.stringify(input.detail ?? {})],
    );
  }

  /** Mark sessions past their expiry as expired. */
  async expireStale(now: Date = new Date()): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE sessions
          SET status = 'expired', state = 'DISCONNECTED', ended_at = now(), end_reason = 'expired'
        WHERE ended_at IS NULL AND expires_at <= $1`,
      [now],
    );
    return rowCount ?? 0;
  }
}

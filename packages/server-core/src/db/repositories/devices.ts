import type { DeviceKind, DeviceStatus, UserDevice } from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';

interface DeviceRow {
  id: string;
  user_id: string;
  kind: DeviceKind;
  name: string;
  status: DeviceStatus;
  public_key: string | null;
  platform: string | null;
  lan_authorized: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, user_id, kind, name, status, public_key, platform, lan_authorized,
                 created_at, last_seen_at, revoked_at`;

function toDevice(row: DeviceRow): UserDevice {
  return {
    id: row.id as UserDevice['id'],
    userId: row.user_id as UserDevice['userId'],
    kind: row.kind,
    name: row.name,
    status: row.status,
    publicKey: row.public_key ?? '',
    platform: row.platform,
    lanAuthorized: row.lan_authorized,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export class DeviceRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    userId: string;
    kind: DeviceKind;
    name: string;
    platform: string | null;
    publicKey: string | null;
  }): Promise<UserDevice> {
    const { rows } = await this.db.query<DeviceRow>(
      `INSERT INTO user_devices (id, user_id, kind, name, platform, public_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING ${COLUMNS}`,
      [input.id, input.userId, input.kind, input.name, input.platform, input.publicKey],
    );
    return toDevice(rows[0]!);
  }

  async findById(id: string): Promise<UserDevice | null> {
    const { rows } = await this.db.query<DeviceRow>(
      `SELECT ${COLUMNS} FROM user_devices WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }

  /** Active devices only; a revoked device must never resolve for an authorization check. */
  async findActive(id: string, userId: string): Promise<UserDevice | null> {
    const { rows } = await this.db.query<DeviceRow>(
      `SELECT ${COLUMNS} FROM user_devices
        WHERE id = $1 AND user_id = $2 AND status = 'active' AND revoked_at IS NULL`,
      [id, userId],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }

  async listForUser(userId: string): Promise<UserDevice[]> {
    const { rows } = await this.db.query<DeviceRow>(
      `SELECT ${COLUMNS} FROM user_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toDevice);
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.query('UPDATE user_devices SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  /**
   * Revoke a device. Its refresh tokens are killed in the same transaction, so revocation
   * takes effect within one access-token lifetime at worst rather than at the next login.
   */
  async revoke(id: string, userId: string, client?: DatabaseClient): Promise<boolean> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE user_devices
          SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND status <> 'revoked'`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async setLanAuthorized(id: string, userId: string, authorized: boolean): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE user_devices SET lan_authorized = $3
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId, authorized],
    );
    return (rowCount ?? 0) > 0;
  }
}

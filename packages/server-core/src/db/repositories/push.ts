import type { PushProvider } from '@wolf/protocol';
import type { Database, DatabaseClient } from '../pool.js';

export interface PushTargetRow {
  readonly userId: string;
  readonly deviceId: string;
  readonly provider: PushProvider;
  readonly token: string;
}

/**
 * Push registration tokens, one per device, and which notifications have been considered for a wake-up.
 *
 * A token is never returned to an API caller and never written to a log or the audit trail. It addresses
 * one device and nothing else, but anybody holding it and the project's sending credentials could wake that
 * phone, so it is kept like the credential-adjacent thing it is.
 */
export class PushRepository {
  constructor(private readonly db: Database) {}

  /** Register or replace this device's token. A device belonging to another user is never overwritten. */
  async setToken(
    input: { readonly deviceId: string; readonly userId: string; readonly provider: PushProvider; readonly token: string },
    client?: DatabaseClient,
  ): Promise<void> {
    await (client ?? this.db).query(
      `INSERT INTO device_push_tokens (device_id, user_id, provider, token, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (device_id) DO UPDATE
          SET provider = EXCLUDED.provider, token = EXCLUDED.token, updated_at = now()
        WHERE device_push_tokens.user_id = EXCLUDED.user_id`,
      [input.deviceId, input.userId, input.provider, input.token],
    );
  }

  async clearToken(deviceId: string, userId: string, client?: DatabaseClient): Promise<boolean> {
    const { rowCount } = await (client ?? this.db).query(
      'DELETE FROM device_push_tokens WHERE device_id = $1 AND user_id = $2',
      [deviceId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async hasToken(deviceId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM device_push_tokens WHERE device_id = $1) AS present',
      [deviceId],
    );
    return rows[0]?.present === true;
  }

  /**
   * Forget a token the provider says is dead — but only if it is still the one that was sent to. A phone that
   * registered a fresh token in the meantime keeps it.
   */
  async removeIfUnchanged(deviceId: string, token: string): Promise<void> {
    await this.db.query('DELETE FROM device_push_tokens WHERE device_id = $1 AND token = $2', [deviceId, token]);
  }

  /**
   * Claim notifications nobody has considered for a wake-up, and return the users with news among them.
   *
   * Each notification is claimed once, by whichever instance gets there first. Ones older than [maxAgeMs]
   * are claimed and dropped: a wake-up about an alert from an hour ago tells the owner nothing the inbox
   * does not, and a server that was down should not wake phones for its backlog.
   */
  async claimNews(now: Date, maxAgeMs: number, limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string; occurred_at: Date | string }>(
      `UPDATE notifications SET pushed_at = $1
        WHERE id IN (
          SELECT id FROM notifications
           WHERE pushed_at IS NULL
           ORDER BY occurred_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
       RETURNING user_id, occurred_at`,
      [now, limit],
    );

    const oldest = now.getTime() - maxAgeMs;
    return [...new Set(rows.filter((row) => new Date(row.occurred_at).getTime() >= oldest).map((row) => row.user_id))];
  }

  /** Tokens of these users' active devices. A revoked device is never woken. */
  async targetsFor(userIds: readonly string[]): Promise<PushTargetRow[]> {
    if (userIds.length === 0) return [];
    const { rows } = await this.db.query<{ user_id: string; device_id: string; provider: PushProvider; token: string }>(
      `SELECT t.user_id, t.device_id, t.provider, t.token
         FROM device_push_tokens t
         JOIN user_devices d ON d.id = t.device_id
        WHERE t.user_id = ANY($1::text[]) AND d.status = 'active' AND d.revoked_at IS NULL
        ORDER BY t.device_id`,
      [userIds],
    );
    return rows.map((row) => ({ userId: row.user_id, deviceId: row.device_id, provider: row.provider, token: row.token }));
  }
}

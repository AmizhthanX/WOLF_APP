import type { StoredRefreshToken } from '@wolf/auth';
import type { Database, DatabaseClient } from '../pool.js';

interface RefreshRow {
  token_id: string;
  family_id: string;
  user_id: string;
  device_id: string;
  secret_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

function toStored(row: RefreshRow): StoredRefreshToken {
  return {
    tokenId: row.token_id,
    familyId: row.family_id,
    userId: row.user_id,
    deviceId: row.device_id,
    secretHash: row.secret_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

export class RefreshTokenRepository {
  constructor(private readonly db: Database) {}

  async insert(
    input: {
      tokenId: string;
      familyId: string;
      userId: string;
      deviceId: string;
      secretHash: string;
      expiresAt: Date;
    },
    client?: DatabaseClient,
  ): Promise<void> {
    const executor = client ?? this.db;
    await executor.query(
      `INSERT INTO refresh_tokens
         (token_id, family_id, user_id, device_id, secret_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.tokenId,
        input.familyId,
        input.userId,
        input.deviceId,
        input.secretHash,
        input.expiresAt,
      ],
    );
  }

  async findByTokenId(tokenId: string): Promise<StoredRefreshToken | null> {
    const { rows } = await this.db.query<RefreshRow>(
      `SELECT token_id, family_id, user_id, device_id, secret_hash, expires_at,
              consumed_at, revoked_at
         FROM refresh_tokens WHERE token_id = $1`,
      [tokenId],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  /**
   * Mark a token consumed. The `consumed_at IS NULL` guard makes rotation atomic: two
   * concurrent refreshes with the same token cannot both succeed, so the loser is treated
   * as a replay on its next attempt.
   */
  async consume(tokenId: string, client?: DatabaseClient): Promise<boolean> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      'UPDATE refresh_tokens SET consumed_at = now() WHERE token_id = $1 AND consumed_at IS NULL',
      [tokenId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Revoke every token in a family. Used when a consumed token is presented again. */
  async revokeFamily(familyId: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
    return rowCount ?? 0;
  }

  async revokeForDevice(deviceId: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL',
      [deviceId],
    );
    return rowCount ?? 0;
  }

  async revokeForUser(userId: string, client?: DatabaseClient): Promise<number> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return rowCount ?? 0;
  }

  /** Housekeeping: drop rows that can no longer authenticate anything. */
  async deleteExpired(before: Date): Promise<number> {
    const { rowCount } = await this.db.query(
      'DELETE FROM refresh_tokens WHERE expires_at < $1',
      [before],
    );
    return rowCount ?? 0;
  }
}

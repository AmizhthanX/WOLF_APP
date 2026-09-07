import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database, DatabaseClient } from '../pool.js';

/**
 * PC enrollment.
 *
 * The owner creates a short-lived, single-use enrollment token in the dashboard and types
 * it into the installer. The token is stored only as a hash, so a database disclosure
 * cannot be used to enrol a rogue machine, and it is consumed inside the same transaction
 * that creates the PC, so it can never enrol two.
 */

export interface EnrollmentTokenMaterial {
  /** Value shown once to the owner. Never stored. */
  readonly token: string;
  readonly id: string;
  readonly tokenHash: string;
}

export interface EnrollmentTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

/** Grouped for legibility when the owner reads it aloud or types it. */
export function generateEnrollmentToken(id: string): EnrollmentTokenMaterial {
  const raw = randomBytes(24).toString('base64url').toUpperCase().replace(/[_-]/g, '');
  const grouped = (raw + randomBytes(8).toString('hex').toUpperCase())
    .slice(0, 24)
    .replace(/(.{6})(?=.)/g, '$1-');
  return { token: grouped, id, tokenHash: hashEnrollmentToken(grouped) };
}

export function hashEnrollmentToken(token: string): string {
  return createHash('sha256').update(token.trim().toUpperCase(), 'utf8').digest('base64url');
}

export class EnrollmentRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    label: string | null;
    expiresAt: Date;
  }): Promise<EnrollmentTokenRecord> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      label: string | null;
      created_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `INSERT INTO pc_enrollment_tokens (id, user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, label, created_at, expires_at, consumed_at`,
      [input.id, input.userId, input.tokenHash, input.label, input.expiresAt],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  async listOutstanding(userId: string): Promise<EnrollmentTokenRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      label: string | null;
      created_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, user_id, label, created_at, expires_at, consumed_at
         FROM pc_enrollment_tokens
        WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    }));
  }

  /**
   * Look up an unconsumed token by its hash. The comparison is done in Postgres on the
   * hash, so the raw token never appears in a query log.
   */
  async findUnconsumedByHash(tokenHash: string): Promise<EnrollmentTokenRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      token_hash: string;
      label: string | null;
      created_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, user_id, token_hash, label, created_at, expires_at, consumed_at
         FROM pc_enrollment_tokens
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;

    const provided = Buffer.from(tokenHash, 'base64url');
    const stored = Buffer.from(row.token_hash, 'base64url');
    if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return null;

    return {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  /** Consume a token. Returns false when another enrollment already claimed it. */
  async consume(id: string, pcId: string, client?: DatabaseClient): Promise<boolean> {
    const executor = client ?? this.db;
    const { rowCount } = await executor.query(
      `UPDATE pc_enrollment_tokens
          SET consumed_at = now(), consumed_by_pc = $2
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [id, pcId],
    );
    return (rowCount ?? 0) > 0;
  }

  async revoke(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM pc_enrollment_tokens
        WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}

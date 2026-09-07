import type { Database, DatabaseClient } from '../pool.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
  password_changed_at: Date;
  failed_login_count: number;
  last_failed_login_at: Date | null;
  last_login_at: Date | null;
}

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly passwordChangedAt: Date;
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lastLoginAt: Date | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
    failedLoginCount: row.failed_login_count,
    lastFailedLoginAt: row.last_failed_login_at,
    lastLoginAt: row.last_login_at,
  };
}

const COLUMNS = `id, email, password_hash, display_name, created_at, password_changed_at,
                 failed_login_count, last_failed_login_at, last_login_at`;

export class UserRepository {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** True when an owner account already exists. Guards the bootstrap path. */
  async ownerExists(): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users WHERE is_owner) AS exists',
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Create the single owner account. The unique partial index on `is_owner` means a
   * second call fails at the database level, not just in application logic.
   */
  async createOwner(input: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (id, email, password_hash, display_name, is_owner)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING ${COLUMNS}`,
      [input.id, input.email.toLowerCase(), input.passwordHash, input.displayName],
    );
    return toRecord(rows[0]!);
  }

  async recordLoginSuccess(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_count = 0,
              last_failed_login_at = NULL,
              last_login_at = $2,
              updated_at = now()
        WHERE id = $1`,
      [id, at],
    );
  }

  async recordLoginFailure(id: string, failureCount: number, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_count = $2,
              last_failed_login_at = $3,
              updated_at = now()
        WHERE id = $1`,
      [id, failureCount, at],
    );
  }

  async updatePasswordHash(id: string, passwordHash: string, client?: DatabaseClient): Promise<void> {
    const executor = client ?? this.db;
    await executor.query(
      `UPDATE users
          SET password_hash = $2, password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, passwordHash],
    );
  }
}

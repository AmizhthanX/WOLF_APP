import pg from 'pg';
import type { Config } from '../config.js';

const { Pool } = pg;

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

/** Postgres returns BIGINT as a string by default to avoid precision loss. Byte counts and
 * timestamps in WOLF stay well inside Number.MAX_SAFE_INTEGER, so parsing them as numbers
 * is safe and saves every call site a conversion. */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function createDatabase(config: Config): Database {
  return new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    ssl: config.database.ssl ? { rejectUnauthorized: true } : false,
    // Fail fast rather than letting a request hang on an exhausted pool.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'wolf-api',
  });
}

/**
 * Run a unit of work inside a transaction, rolling back on any throw.
 *
 * Used wherever a state change and its audit record must land together: an audit trail
 * that can be missing the row for an action that happened is not an audit trail.
 */
export async function withTransaction<T>(
  db: Database,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below discards it from the pool.
    }
    throw error;
  } finally {
    client.release();
  }
}

import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../db/pool.js';

/**
 * An in-process Postgres for tests.
 *
 * PGlite is the real Postgres engine compiled to WebAssembly, so migrations, partitioning,
 * constraints, and `ON CONFLICT` behave exactly as they will in production — which is the
 * whole point. A mocked query layer would happily accept SQL that Postgres rejects, and
 * the schema is where a lot of WOLF's safety actually lives (the single-owner index, the
 * idempotency constraint, the partitioned telemetry table).
 *
 * This is test infrastructure. It is never used by a running service.
 */
export interface TestDatabase extends Database {
  /** Close the underlying database. */
  end(): Promise<void>;
}

interface QueryResultLike {
  rows: unknown[];
  affectedRows?: number;
}

function toPgResult(result: QueryResultLike): { rows: never[]; rowCount: number } {
  return {
    rows: result.rows as never[],
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

/**
 * Create a database that satisfies the slice of `pg.Pool` the repositories use.
 *
 * PGlite is single-connection, so `connect()` hands back the same underlying database.
 * That is correct for tests: it means a transaction opened through `withTransaction`
 * really does wrap the statements that follow it.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = await PGlite.create();

  const query = async (text: string, params?: unknown[]): Promise<unknown> => {
    // PGlite's `query` handles a single parameterised statement; `exec` handles scripts
    // with several statements, which is what migration files are.
    if (params && params.length > 0) {
      return toPgResult((await pglite.query(text, params)) as QueryResultLike);
    }

    const trimmed = text.trim();
    const isMultiStatement = trimmed.slice(0, -1).includes(';');
    if (isMultiStatement) {
      const results = await pglite.exec(text);
      const last = results.at(-1);
      return toPgResult((last ?? { rows: [] }) as QueryResultLike);
    }

    return toPgResult((await pglite.query(text)) as QueryResultLike);
  };

  const client = {
    query,
    release: () => {},
  };

  const database = {
    query,
    connect: async () => client,
    end: async () => {
      await pglite.close();
    },
  };

  return database as unknown as TestDatabase;
}

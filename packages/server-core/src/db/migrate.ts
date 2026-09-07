import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './pool.js';

/**
 * Migration runner.
 *
 * Migrations are plain SQL, applied in filename order, each inside its own transaction and
 * recorded with a checksum. A file that changes after being applied is a hard error: the
 * database and the repository would otherwise silently disagree about the schema.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface MigrationFile {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const sql = await readFile(path.join(dir, filename), 'utf8');
    files.push({
      version: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return files;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum   TEXT NOT NULL
    )
  `);
}

export async function migrate(
  db: Database,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  await ensureMigrationsTable(db);

  const files = await loadMigrations(options.dir);
  const { rows } = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((row) => [row.version, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const existing = alreadyApplied.get(file.version);
    if (existing) {
      if (existing !== file.checksum) {
        throw new Error(
          `Migration ${file.filename} changed after it was applied. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      skipped.push(file.version);
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file.version, file.checksum],
      );
      await client.query('COMMIT');
      applied.push(file.version);
      log(`applied ${file.filename}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(
        `Migration ${file.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

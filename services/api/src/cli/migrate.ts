/** Apply pending database migrations. Safe to run repeatedly. */
import { loadConfig } from '@wolf/server-core';
import { createDatabase } from '@wolf/server-core';
import { migrate } from '@wolf/server-core';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config);

  try {
    const result = await migrate(db, { log: (message) => process.stdout.write(`${message}\n`) });
    if (result.applied.length === 0) {
      process.stdout.write(`Database is up to date (${result.skipped.length} migrations).\n`);
    } else {
      process.stdout.write(`Applied ${result.applied.length} migration(s).\n`);
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

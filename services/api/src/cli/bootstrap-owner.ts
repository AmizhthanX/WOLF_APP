/**
 * Create the single WOLF owner account.
 *
 * WOLF has no registration endpoint by design, so the owner account is created here,
 * against the database, by someone who already has deployment access. The password is read
 * from an environment variable rather than a command-line argument, because arguments show
 * up in process listings and shell history.
 *
 *   WOLF_OWNER_EMAIL=me@example.com WOLF_OWNER_PASSWORD='...' \
 *   WOLF_OWNER_NAME='Owner' npm run bootstrap:owner -w @wolf/api
 */
import { hashPassword } from '@wolf/auth';
import { newId } from '@wolf/shared-types';
import { email as emailSchema, password as passwordSchema } from '@wolf/validation';
import { loadConfig } from '@wolf/server-core';
import { createDatabase } from '@wolf/server-core';
import { UserRepository } from '@wolf/server-core';

async function main(): Promise<void> {
  const rawEmail = process.env['WOLF_OWNER_EMAIL'];
  const rawPassword = process.env['WOLF_OWNER_PASSWORD'];
  const displayName = process.env['WOLF_OWNER_NAME'] ?? 'Owner';

  if (!rawEmail || !rawPassword) {
    throw new Error(
      'Set WOLF_OWNER_EMAIL and WOLF_OWNER_PASSWORD in the environment before running this.',
    );
  }

  const parsedEmail = emailSchema.safeParse(rawEmail);
  if (!parsedEmail.success) throw new Error('WOLF_OWNER_EMAIL is not a valid email address.');

  const parsedPassword = passwordSchema.safeParse(rawPassword);
  if (!parsedPassword.success) {
    throw new Error(`WOLF_OWNER_PASSWORD is not acceptable: ${parsedPassword.error.issues[0]?.message}`);
  }

  const config = loadConfig();
  const db = createDatabase(config);
  const users = new UserRepository(db);

  try {
    if (await users.ownerExists()) {
      throw new Error(
        'An owner account already exists. WOLF is a single-owner product; to change the ' +
          'password, use the account settings rather than creating a second account.',
      );
    }

    const user = await users.createOwner({
      id: newId(),
      email: parsedEmail.data,
      passwordHash: await hashPassword(parsedPassword.data),
      displayName,
    });

    process.stdout.write(`Created WOLF owner account ${user.email} (${user.id}).\n`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

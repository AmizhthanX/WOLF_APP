import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './pglite.js';

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The local cloud delivers commands through this: the API's `pg_notify('wolf_command', …)` has to reach
 * a subscriber, as NOTIFY reaches the realtime service's listener in a deployment. Without it, a command
 * written by the local cloud's API is never handed to the agent.
 */
test('pg_notify reaches a listener, and stops reaching it once unsubscribed', async () => {
  const db = await createTestDatabase();
  try {
    const received: string[] = [];
    const unsubscribe = await db.listen('wolf_command', (payload) => received.push(payload));

    await db.query('SELECT pg_notify($1, $2)', ['wolf_command', JSON.stringify({ pcId: 'pc-1', commandId: 'command-1' })]);
    await waitFor(() => received.length === 1);
    assert.deepEqual(JSON.parse(received[0]!), { pcId: 'pc-1', commandId: 'command-1' });

    // Another channel is not this one.
    await db.query('SELECT pg_notify($1, $2)', ['wolf_kill_switch', JSON.stringify({ pcId: 'pc-1' })]);

    await unsubscribe();
    await db.query('SELECT pg_notify($1, $2)', ['wolf_command', JSON.stringify({ pcId: 'pc-2' })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.length, 1);
  } finally {
    await db.end();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every session broker route checks the CSRF header before it does anything else.
 *
 * The route handlers need Next to run, so this reads them. A new route under `app/api/auth` —
 * like the refresh binding — that forgets the guard fails here rather than in review.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authRoutes = path.join(webRoot, 'app', 'api', 'auth');

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === 'route.ts' ? [full] : [];
  });
}

test('every auth broker route rejects a request without the CSRF header first', () => {
  const files = routeFiles(authRoutes);
  const names = files.map((file) => path.relative(authRoutes, file).replaceAll('\\', '/')).sort();
  assert.deepEqual(names, ['login/route.ts', 'logout/route.ts', 'refresh/binding/route.ts', 'refresh/route.ts']);

  for (const file of files) {
    const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    assert.doesNotMatch(source, /export async function (GET|PUT|PATCH|DELETE)\b/, `${file} exposes only POST`);

    const handler = source.slice(source.indexOf('export async function POST'));
    const body = handler.slice(handler.indexOf('{') + 1).trimStart();
    assert.ok(
      body.startsWith('const rejected = csrfGuard(request);\n  if (rejected) return rejected;'),
      `${file} must check the CSRF header before anything else`,
    );
  }
});

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the browser loop test to a real browser.
 *
 * The page needs three things this provides: the compiled dashboard state machine, the
 * shared-types module it imports, and the session token — which is served from
 * `/config.json` rather than put in the URL, because a token in a query string ends up in
 * history, logs, and referrer headers.
 *
 * Development tooling. It binds to loopback, serves a fixed set of file types from the
 * repository, and refuses anything that resolves outside it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const pageRoot = path.resolve(here, '../browser');

const PORT = Number(process.env['WOLF_HARNESS_PORT'] ?? 3100);

const SESSION_TOKEN = process.env['WOLF_HARNESS_SESSION_TOKEN'] ?? '';
const REALTIME_URL = process.env['WOLF_HARNESS_REALTIME_URL'] ?? 'ws://127.0.0.1:8081';

if (!SESSION_TOKEN) {
  console.error('Set WOLF_HARNESS_SESSION_TOKEN to a session token from the API.');
  process.exit(1);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** The profile the page asks for. Deliberately modest, so a slow link still shows a picture. */
const PROFILE = {
  name: 'Browser loop test',
  maxWidthPixels: null,
  maxHeightPixels: null,
  targetFps: 30,
  minBitrateBps: 1_000_000,
  maxBitrateBps: 8_000_000,
  codecPreference: [],
  audioEnabled: false,
  qualityBias: 'balanced',
  adaptive: true,
  overrides: { bitrateBps: null, frameRate: null, resolutionScale: null },
};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/config.json') {
      response.writeHead(200, { 'content-type': TYPES['.json']! });
      response.end(
        JSON.stringify({
          sessionToken: SESSION_TOKEN,
          realtimeUrl: REALTIME_URL,
          iceServers: [],
          profile: PROFILE,
        }),
      );
      return;
    }

    // The page itself is served from its own directory; everything else is resolved inside
    // the repository, which is what lets the page import the compiled client.
    const target =
      url.pathname === '/' || url.pathname === '/index.html'
        ? path.join(pageRoot, 'index.html')
        : path.resolve(repoRoot, '.' + url.pathname);

    // Path traversal: resolve first, then check containment. Checking the raw path for
    // ".." would miss encodings and symlinks.
    if (!target.startsWith(repoRoot) && !target.startsWith(pageRoot)) {
      response.writeHead(403).end('outside the repository');
      return;
    }

    const extension = path.extname(target).toLowerCase();
    if (!TYPES[extension]) {
      response.writeHead(415).end('not a type this harness serves');
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');

      response.writeHead(200, { 'content-type': TYPES[extension]!, 'cache-control': 'no-store' });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end('not found');
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Browser loop test: http://127.0.0.1:${PORT}/`);
});

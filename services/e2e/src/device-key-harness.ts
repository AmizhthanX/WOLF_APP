import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIdentityPublicKey, verifySignature } from '@wolf/auth';
import { webRefreshProofPayload } from '@wolf/protocol';

/**
 * Serves the device-key browser test to a real browser.
 *
 * The page runs the dashboard's own device-key module — compiled by the web workspace's test build,
 * not a copy of it — against the browser's real WebCrypto, IndexedDB and Web Locks: it makes a
 * non-extractable key, reloads itself to prove the key survived, signs a web refresh proof, and clears
 * site storage to prove the loss is noticed. Signatures are checked here by the verifier the API uses,
 * so "the browser signed" means "the server would accept it".
 *
 * Development tooling. It binds to loopback, serves a fixed set of file types from the repository,
 * and refuses anything that resolves outside it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const page = path.resolve(here, '../browser/device-key.html');

const PORT = Number(process.env['WOLF_DEVICE_KEY_HARNESS_PORT'] ?? 3110);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (request.method === 'POST' && url.pathname === '/verify') {
      try {
        const body = await readJson(request);
        const publicKey = text(body['publicKey']);
        const payload = webRefreshProofPayload(text(body['deviceId']), text(body['binding']), text(body['signedAt']));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            validKey: isIdentityPublicKey(publicKey),
            verified: verifySignature(publicKey, payload, text(body['signature'])),
          }),
        );
      } catch (error) {
        response.writeHead(400).end(error instanceof Error ? error.message : 'bad request');
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/report') {
      try {
        const report = await readJson(request);
        const steps = (report['steps'] as { name: string; ok: boolean; detail: unknown }[] | undefined) ?? [];
        const run = typeof report['run'] === 'string' ? ` [${report['run']}]` : '';
        for (const step of steps) console.log(`${step.ok ? 'ok    ' : 'FAILED'} ${step.name}${step.detail ? ` — ${String(step.detail)}` : ''}`);
        console.log(
          report['passed']
            ? `All ${steps.length} steps passed${run} in ${String(report['userAgent'])}`
            : `The device-key browser test FAILED${run} in ${String(report['userAgent'])}`,
        );
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }

    const target =
      url.pathname === '/' || url.pathname === '/device-key.html' ? page : path.resolve(repoRoot, '.' + url.pathname);

    // Path traversal: resolve first, then check containment.
    if (!target.startsWith(repoRoot)) {
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
  console.log(`Device-key browser test: http://127.0.0.1:${PORT}/`);
});

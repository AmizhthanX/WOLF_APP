import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WEBHOOK_DELIVERY_HEADER, WEBHOOK_SIGNATURE_HEADER } from '@wolf/protocol';
import { checkEgress, isPublicAddress, type Resolver } from './egress.js';
import { signWebhook, verifyWebhook, WebhookSecrets } from './secrets.js';
import { WebhookSender } from './sender.js';

/**
 * The parts of a webhook that decide where a request goes and whether anybody can trust it: which addresses are
 * refused, how a name's answers are judged, how the URL and signing secret are kept, and a real TLS request to a
 * real server that proves the socket opens where the checked lookup says.
 */

const KEY = 'a-webhook-key-that-is-long-enough-for-hkdf-0123456789';
const PUBLIC = '93.184.215.14';

const resolving =
  (answers: Record<string, string[]>): Resolver =>
  async (hostname) => {
    const found = answers[hostname];
    if (!found) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

test('private, local, reserved and disguised addresses are refused; public ones are not', () => {
  const refused = [
    '127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '224.0.0.251', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '2002:7f00:1::', '2001:0:4136:e378::1', 'not-an-address',
  ];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);

  for (const address of [PUBLIC, '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('a URL is refused unless it is https to a name whose every answer is public', async () => {
  const resolve = resolving({
    'hooks.example.com': [PUBLIC],
    'metadata.example.com': ['169.254.169.254'],
    'split.example.com': [PUBLIC, '10.0.0.5'],
    'v6.example.com': ['2606:4700:4700::1111'],
  });

  assert.deepEqual(await checkEgress('https://hooks.example.com/in', resolve), {
    ok: true, hostname: 'hooks.example.com', address: PUBLIC, family: 4, port: 443,
  });
  assert.equal((await checkEgress('https://v6.example.com:8443/in', resolve)).ok, true);

  const reasons = async (url: string) => {
    const verdict = await checkEgress(url, resolve);
    return verdict.ok ? 'ok' : verdict.reason;
  };
  assert.equal(await reasons('http://hooks.example.com/in'), 'not-https');
  assert.equal(await reasons('https://user:pass@hooks.example.com/in'), 'not-https');
  assert.equal(await reasons('https://localhost/in'), 'local-name');
  assert.equal(await reasons('https://printer.local/in'), 'local-name');
  assert.equal(await reasons('https://intranet/in'), 'local-name');
  assert.equal(await reasons('https://metadata.example.com/computeMetadata'), 'not-public');
  assert.equal(await reasons('https://split.example.com/in'), 'not-public', 'one private answer among public ones is refused');
  assert.equal(await reasons('https://127.0.0.1/in'), 'not-public');
  assert.equal(await reasons('https://[::1]/in'), 'not-public');
  assert.equal(await reasons('https://nowhere.example.com/in'), 'not-resolved');
});

test('a URL is sealed to its webhook and a signing secret is derived, not stored', () => {
  const secrets = new WebhookSecrets(KEY);
  const url = 'https://discord.com/api/webhooks/123/very-secret-token';

  const sealed = secrets.encryptUrl('01J9ZQK7T0000000000000000A', url);
  assert.ok(!sealed.includes('very-secret-token'));
  assert.equal(secrets.decryptUrl('01J9ZQK7T0000000000000000A', sealed), url);
  assert.throws(() => secrets.decryptUrl('01J9ZQK7T0000000000000000B', sealed), 'a sealed URL cannot be moved to another webhook');
  assert.throws(() => new WebhookSecrets(KEY.replace('a', 'b')).decryptUrl('01J9ZQK7T0000000000000000A', sealed));

  const salt = secrets.newSalt();
  const secret = secrets.signingSecret('01J9ZQK7T0000000000000000A', salt);
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(secrets.signingSecret('01J9ZQK7T0000000000000000A', salt), secret, 'the same inputs give the same secret');
  assert.notEqual(secrets.signingSecret('01J9ZQK7T0000000000000000A', secrets.newSalt()), secret, 'rotating the salt rotates it');
  assert.notEqual(new WebhookSecrets(`${KEY}x`).signingSecret('01J9ZQK7T0000000000000000A', salt), secret);

  assert.throws(() => new WebhookSecrets('too-short'));
});

test('a signature verifies for the exact body, the right secret, and a recent time only', () => {
  const body = '{"type":"wolf.notification"}';
  const header = signWebhook('whsec_one', 1_800_000_000, body);

  assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
  assert.equal(verifyWebhook('whsec_one', header, body, 1_800_000_100), true);
  assert.equal(verifyWebhook('whsec_two', header, body, 1_800_000_100), false);
  assert.equal(verifyWebhook('whsec_one', header, `${body} `, 1_800_000_100), false);
  assert.equal(verifyWebhook('whsec_one', header, body, 1_800_000_000 + 301), false, 'a replay after five minutes is refused');
  assert.equal(verifyWebhook('whsec_one', 'garbage', body, 1_800_000_000), false);
});

/* ------------------------------------------------------------------------- */
/* A real TLS server                                                          */
/* ------------------------------------------------------------------------- */

let server: Server;
let port: number;
let ca: Buffer;
let workDir: string;
let answer = 204;
const received: { headers: Record<string, unknown>; body: string; path: string | undefined }[] = [];

before(async () => {
  // A throwaway certificate for a name that is not this machine's, made for this run and deleted after it.
  workDir = mkdtempSync(path.join(tmpdir(), 'wolf-webhook-tls-'));
  const key = path.join(workDir, 'key');
  const cert = path.join(workDir, 'cert');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=hooks.example.com', '-addext', 'subjectAltName=DNS:hooks.example.com'],
    { stdio: 'ignore' },
  );
  ca = readFileSync(cert);

  server = createServer({ key: readFileSync(key), cert: ca }, (request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ headers: request.headers, body, path: request.url });
      if (answer >= 300 && answer < 400) response.setHeader('location', 'https://169.254.169.254/');
      response.statusCode = answer;
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

function sender(options: { ca?: Buffer } = { ca }) {
  return new WebhookSender({
    resolve: resolving({ 'hooks.example.com': [PUBLIC] }),
    // The name passes the check on a public address; the socket is then opened where the pinned lookup says,
    // which for this test is the server on this machine.
    testConnectAddress: { address: '127.0.0.1', family: 4 },
    timeoutMs: 3_000,
    ...options,
  });
}

test('a delivery is a signed POST over verified TLS to the checked name, with no redirect followed', async () => {
  const body = JSON.stringify({ type: 'wolf.notification', version: 1 });
  const now = new Date('2026-09-16T10:00:00.000Z');

  answer = 204;
  const result = await sender().deliver({
    url: `https://hooks.example.com:${port}/in/abc?x=1`, secret: 'whsec_test', body, deliveryId: 'delivery-1', now,
  });
  assert.deepEqual(result.outcome, 'delivered');
  const got = received.at(-1)!;
  assert.equal(got.path, '/in/abc?x=1');
  assert.equal(got.body, body);
  assert.equal(got.headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()], 'delivery-1');
  assert.equal(verifyWebhook('whsec_test', String(got.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]), got.body, now.getTime() / 1000), true);

  answer = 302;
  const redirected = await sender().deliver({ url: `https://hooks.example.com:${port}/in`, secret: 's', body, deliveryId: 'd2', now });
  assert.equal(redirected.outcome, 'redirect');
  assert.equal(received.length, 2, 'the redirect was not followed');

  answer = 500;
  assert.equal((await sender().deliver({ url: `https://hooks.example.com:${port}/in`, secret: 's', body, deliveryId: 'd3', now })).outcome, 'http-error');
});

test('an unverifiable certificate is a failed delivery, and a refused address is never connected to', async () => {
  answer = 204;
  const before = received.length;

  const untrusted = await new WebhookSender({
    resolve: resolving({ 'hooks.example.com': [PUBLIC] }),
    testConnectAddress: { address: '127.0.0.1', family: 4 },
  }).deliver({ url: `https://hooks.example.com:${port}/in`, secret: 's', body: '{}', deliveryId: 'd4', now: new Date() });
  assert.equal(untrusted.outcome, 'tls');

  const refused = await new WebhookSender({
    resolve: resolving({ 'hooks.example.com': ['127.0.0.1'] }),
    ca,
  }).deliver({ url: `https://hooks.example.com:${port}/in`, secret: 's', body: '{}', deliveryId: 'd5', now: new Date() });
  assert.equal(refused.outcome, 'address-refused');

  assert.equal(received.length, before, 'neither reached the server');
});

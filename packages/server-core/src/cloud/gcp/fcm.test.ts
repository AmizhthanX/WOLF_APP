import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FCM_SCOPE, FcmPushSender, readFcmCredentials } from './fcm.js';
import { ConfigurationError } from '../../config.js';

/**
 * The FCM adapter against a local server that answers as Google's token endpoint and the FCM v1 API do. It
 * proves what the adapter sends and how it reads the answers; it cannot prove Google delivers, which needs a
 * real Firebase project.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Recorded {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server;
let base: string;
const recorded: Recorded[] = [];
let sendAnswers: Array<{ status: number; body: unknown }> = [];
let tokensIssued = 0;

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      recorded.push({ path: request.url ?? '', headers: request.headers, body });
      if (request.url === '/token') {
        tokensIssued += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: `access-${tokensIssued}`, expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      const answer = sendAnswers.shift() ?? { status: 200, body: { name: 'projects/wolf-test/messages/0:1' } };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sender(): FcmPushSender {
  recorded.length = 0;
  tokensIssued = 0;
  sendAnswers = [];
  return new FcmPushSender({
    projectId: 'wolf-test',
    credentials: { clientEmail: 'push@wolf-test.iam.gserviceaccount.com', privateKey, tokenUri: `${base}/token` },
    endpoint: base,
  });
}

const target = { deviceId: '01J9ZQK7T0000000000000000D', token: 'device-registration-token-0123456789' };

test('a wake-up is sent with a token from a signed assertion, and says nothing but that there is news', async () => {
  const fcm = sender();

  assert.equal(await fcm.wake(target), 'delivered');

  const [tokenRequest, send] = recorded;
  assert.equal(tokenRequest!.path, '/token');
  const form = new URLSearchParams(tokenRequest!.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

  const [header, claims, signature] = form.get('assertion')!.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
  const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(parsed['iss'], 'push@wolf-test.iam.gserviceaccount.com');
  assert.equal(parsed['scope'], FCM_SCOPE);
  assert.equal(parsed['aud'], `${base}/token`);
  assert.equal(Number(parsed['exp']) - Number(parsed['iat']), 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, 'base64url')), 'the assertion is signed with the service account key');

  assert.equal(send!.path, '/v1/projects/wolf-test/messages:send');
  assert.equal(send!.headers.authorization, 'Bearer access-1');
  // Exactly this and nothing else: no notification block, no title, no PC, no count.
  assert.deepEqual(JSON.parse(send!.body), {
    message: {
      token: target.token,
      data: { kind: 'wolf.wake', v: '1' },
      android: { priority: 'HIGH', ttl: '3600s', collapse_key: 'wolf-wake' },
    },
  });
});

test('the access token is reused until it nears expiry', async () => {
  const fcm = sender();
  await fcm.wake(target);
  await fcm.wake(target);
  assert.equal(tokensIssued, 1);
});

test('a token the provider rejects as unauthorized is fetched again, once', async () => {
  const fcm = sender();
  sendAnswers = [{ status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } }];

  assert.equal(await fcm.wake(target), 'delivered');
  assert.equal(tokensIssued, 2);

  sendAnswers = [
    { status: 401, body: {} },
    { status: 401, body: {} },
  ];
  assert.equal(await fcm.wake(target), 'failed', 'a second refusal is a failure, not a loop');
});

test('a dead token is told apart from a failure', async () => {
  const fcm = sender();
  sendAnswers = [
    {
      status: 404,
      body: { error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } },
    },
    {
      status: 403,
      body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } },
    },
    { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } },
    { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } } },
  ];

  assert.equal(await fcm.wake(target), 'token-invalid');
  assert.equal(await fcm.wake(target), 'token-invalid');
  assert.equal(await fcm.wake(target), 'failed');
  assert.equal(await fcm.wake(target), 'failed');
});

test('an unreachable service is a failure, never a throw', async () => {
  const fcm = new FcmPushSender({
    projectId: 'wolf-test',
    credentials: { clientEmail: 'push@wolf-test.iam.gserviceaccount.com', privateKey, tokenUri: 'http://127.0.0.1:1/token' },
    endpoint: 'http://127.0.0.1:1',
    timeoutMs: 2_000,
  });
  assert.equal(await fcm.wake(target), 'failed');
});

test('credentials come from a service-account file, and anything else refuses to start', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wolf-fcm-'));
  try {
    const good = path.join(dir, 'good.json');
    await writeFile(good, JSON.stringify({ type: 'service_account', client_email: 'push@wolf-test.iam.gserviceaccount.com', private_key: privateKey }));
    const credentials = await readFcmCredentials(good);
    assert.equal(credentials.tokenUri, 'https://oauth2.googleapis.com/token');

    const noKey = path.join(dir, 'no-key.json');
    await writeFile(noKey, JSON.stringify({ client_email: 'push@wolf-test.iam.gserviceaccount.com' }));
    await assert.rejects(readFcmCredentials(noKey), ConfigurationError);

    const plainHttp = path.join(dir, 'http.json');
    await writeFile(plainHttp, JSON.stringify({ client_email: 'a@b', private_key: privateKey, token_uri: 'http://tokens.example.com/token' }));
    await assert.rejects(readFcmCredentials(plainHttp), ConfigurationError);

    await assert.rejects(readFcmCredentials(path.join(dir, 'missing.json')), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes('PRIVATE KEY'));
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

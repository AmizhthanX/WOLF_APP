import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHmacSigner,
  issueAccessToken,
  reauthIsFresh,
  verifyAccessToken,
} from './tokens.js';

const SECRET = 'a'.repeat(48);
const signer = createHmacSigner(SECRET);
const base = {
  signer,
  issuer: 'https://api.amizhthan.app',
  audience: 'wolf-web',
};

function issue(overrides: Partial<Parameters<typeof issueAccessToken>[0]> = {}) {
  return issueAccessToken({
    ...base,
    subject: '01J9ZQK7T0000000000000000A',
    deviceId: '01J9ZQK7T0000000000000000B',
    authTime: Math.floor(Date.now() / 1000),
    ...overrides,
  });
}

test('a signing secret shorter than 32 bytes is refused outright', () => {
  assert.throws(() => createHmacSigner('too-short'), /at least 32 bytes/);
});

test('an issued token verifies and carries its claims', () => {
  const { token } = issue({ sessionId: '01J9ZQK7T0000000000000000C', capabilities: ['processes'] });
  const result = verifyAccessToken(token, base);
  assert.ok(result.ok);
  assert.equal(result.claims.sub, '01J9ZQK7T0000000000000000A');
  assert.equal(result.claims.did, '01J9ZQK7T0000000000000000B');
  assert.deepEqual(result.claims.cap, ['processes']);
});

test('a tampered payload is rejected', () => {
  const { token } = issue();
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.sub = 'attacker';
  const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

  const result = verifyAccessToken(`${header}.${forged}.${signature}`, base);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-signature');
});

test('the "none" algorithm and other algorithm swaps are refused', () => {
  const { token } = issue();
  const [, payload] = token.split('.') as [string, string, string];
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const result = verifyAccessToken(`${noneHeader}.${payload}.`, base);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unsupported-algorithm');
});

test('a token signed with a different secret is rejected', () => {
  const { token } = issueAccessToken({
    ...base,
    signer: createHmacSigner('b'.repeat(48)),
    subject: '01J9ZQK7T0000000000000000A',
    deviceId: '01J9ZQK7T0000000000000000B',
    authTime: Math.floor(Date.now() / 1000),
  });
  const result = verifyAccessToken(token, base);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-signature');
});

test('expired tokens are rejected once past the skew allowance', () => {
  const issuedAt = Date.now() - 3_600_000;
  const { token } = issue({ now: issuedAt, ttlSeconds: 60 });
  const result = verifyAccessToken(token, base);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'expired');
});

test('issuer and audience are both enforced', () => {
  const { token } = issue();
  const wrongIssuer = verifyAccessToken(token, { ...base, issuer: 'https://evil.example' });
  assert.equal(wrongIssuer.ok === false && wrongIssuer.reason, 'wrong-issuer');

  const wrongAudience = verifyAccessToken(token, { ...base, audience: 'wolf-android' });
  assert.equal(wrongAudience.ok === false && wrongAudience.reason, 'wrong-audience');
});

test('malformed tokens are rejected without throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', '...', 'not-base64.$$$.zzz']) {
    const result = verifyAccessToken(bad, base);
    assert.equal(result.ok, false, `${bad} should not verify`);
  }
});

test('access tokens are short lived by default', () => {
  const { expiresAt } = issue();
  const lifetimeSeconds = (expiresAt.getTime() - Date.now()) / 1000;
  assert.ok(lifetimeSeconds <= 900, 'default access token lifetime must stay short');
});

test('reauthIsFresh enforces the high-risk re-authentication window', () => {
  const now = Date.now();
  const authTime = Math.floor(now / 1000) - 200;
  const { token } = issue({ authTime, now });
  const result = verifyAccessToken(token, { ...base, now });
  assert.ok(result.ok);
  assert.equal(reauthIsFresh(result.claims, 300, now), true);
  assert.equal(reauthIsFresh(result.claims, 120, now), false, 'critical needs fresher proof');
});

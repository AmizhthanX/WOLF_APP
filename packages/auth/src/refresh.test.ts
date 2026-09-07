import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRefreshToken,
  evaluateRefresh,
  parseRefreshToken,
  refreshSecretHash,
  type StoredRefreshToken,
} from './refresh.js';

const USER = '01J9ZQK7T0000000000000000A';
const DEVICE = '01J9ZQK7T0000000000000000B';

function storedFor(
  material: ReturnType<typeof createRefreshToken>,
  overrides: Partial<StoredRefreshToken> = {},
): StoredRefreshToken {
  return {
    tokenId: material.tokenId,
    familyId: material.familyId,
    userId: USER,
    deviceId: DEVICE,
    secretHash: material.secretHash,
    expiresAt: new Date(Date.now() + 86_400_000),
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

test('a fresh token rotates', () => {
  const material = createRefreshToken();
  const decision = evaluateRefresh({
    token: material.token,
    stored: storedFor(material),
    deviceId: DEVICE,
  });
  assert.equal(decision.outcome, 'rotate');
});

test('the stored record holds only a hash, never the secret', () => {
  const material = createRefreshToken();
  const parsed = parseRefreshToken(material.token);
  assert.ok(parsed);
  assert.notEqual(material.secretHash, parsed.secret);
  assert.equal(material.secretHash, refreshSecretHash(parsed.secret));
});

test('replaying a consumed token revokes the whole family', () => {
  const material = createRefreshToken();
  const decision = evaluateRefresh({
    token: material.token,
    stored: storedFor(material, { consumedAt: new Date() }),
    deviceId: DEVICE,
  });
  assert.equal(decision.outcome, 'revoke-family');
  assert.equal(decision.outcome === 'revoke-family' && decision.familyId, material.familyId);
});

test('a rotated successor stays in the same family', () => {
  const first = createRefreshToken();
  const second = createRefreshToken(first.familyId);
  assert.equal(second.familyId, first.familyId);
  assert.notEqual(second.tokenId, first.tokenId);
});

test('a guessed secret is a rejection, not a family revocation', () => {
  const material = createRefreshToken();
  const forged = `${material.familyId}.${material.tokenId}.${'z'.repeat(43)}`;
  const decision = evaluateRefresh({
    token: forged,
    stored: storedFor(material),
    deviceId: DEVICE,
  });
  assert.equal(decision.outcome, 'reject');
  assert.equal(decision.outcome === 'reject' && decision.reason, 'bad-secret');
});

test('a token presented by another device is refused', () => {
  const material = createRefreshToken();
  const decision = evaluateRefresh({
    token: material.token,
    stored: storedFor(material),
    deviceId: '01J9ZQK7T0000000000000000Z',
  });
  assert.equal(decision.outcome === 'reject' && decision.reason, 'device-mismatch');
});

test('expired and revoked tokens are refused', () => {
  const material = createRefreshToken();

  const expired = evaluateRefresh({
    token: material.token,
    stored: storedFor(material, { expiresAt: new Date(Date.now() - 1000) }),
    deviceId: DEVICE,
  });
  assert.equal(expired.outcome === 'reject' && expired.reason, 'expired');

  const revoked = evaluateRefresh({
    token: material.token,
    stored: storedFor(material, { revokedAt: new Date() }),
    deviceId: DEVICE,
  });
  assert.equal(revoked.outcome === 'reject' && revoked.reason, 'revoked');
});

test('a token with no stored record, or a mismatched family, is unknown', () => {
  const material = createRefreshToken();

  const missing = evaluateRefresh({ token: material.token, stored: null, deviceId: DEVICE });
  assert.equal(missing.outcome === 'reject' && missing.reason, 'unknown');

  const otherFamily = evaluateRefresh({
    token: material.token,
    stored: storedFor(material, { familyId: 'another-family' }),
    deviceId: DEVICE,
  });
  assert.equal(otherFamily.outcome === 'reject' && otherFamily.reason, 'unknown');
});

test('malformed tokens are refused without throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', '..']) {
    const decision = evaluateRefresh({ token: bad, stored: null, deviceId: DEVICE });
    assert.equal(decision.outcome, 'reject');
  }
});

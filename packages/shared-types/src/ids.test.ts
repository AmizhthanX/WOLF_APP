import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idTimestamp, isWolfId, newId } from './ids.js';

test('newId produces a 26-character Crockford base32 identifier', () => {
  const id = newId();
  assert.equal(id.length, 26);
  assert.ok(isWolfId(id));
});

test('identifiers sort lexicographically by creation time', () => {
  const older = newId(1_700_000_000_000);
  const newer = newId(1_700_000_001_000);
  assert.ok(older < newer, `${older} should sort before ${newer}`);
});

test('idTimestamp round-trips the encoded creation time', () => {
  const now = 1_752_000_000_000;
  assert.equal(idTimestamp(newId(now)).getTime(), now);
});

test('isWolfId rejects malformed values', () => {
  assert.equal(isWolfId('too-short'), false);
  assert.equal(isWolfId('IL'.repeat(13)), false, 'I and L are excluded from Crockford base32');
  assert.equal(isWolfId(42), false);
});

test('identifiers are unique across a burst', () => {
  const ids = new Set(Array.from({ length: 5000 }, () => newId()));
  assert.equal(ids.size, 5000);
});

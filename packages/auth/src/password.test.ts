import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_PARAMETERS, hashPassword, needsRehash, verifyPassword } from './password.js';

/** Reduced cost so the suite stays fast; production parameters are asserted separately. */
const TEST_PARAMS = { cost: 2 ** 12, blockSize: 8, parallelization: 1, keyLength: 32 };

test('a hashed password verifies and a wrong one does not', async () => {
  const encoded = await hashPassword('correct horse battery staple', TEST_PARAMS);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('correct horse battery stapl', encoded), false);
  assert.equal(await verifyPassword('', encoded), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword('same password', TEST_PARAMS);
  const b = await hashPassword('same password', TEST_PARAMS);
  assert.notEqual(a, b, 'salts must differ');
  assert.equal(await verifyPassword('same password', a), true);
  assert.equal(await verifyPassword('same password', b), true);
});

test('the stored hash never contains the password', async () => {
  const encoded = await hashPassword('hunter2-hunter2-hunter2', TEST_PARAMS);
  assert.ok(!encoded.includes('hunter2'));
});

test('unicode passwords are normalized so equivalent input verifies', async () => {
  const composed = 'passwörd-with-accents';
  const decomposed = composed.normalize('NFD');
  assert.notEqual(composed, decomposed);
  const encoded = await hashPassword(composed, TEST_PARAMS);
  assert.equal(await verifyPassword(decomposed, encoded), true);
});

test('tampered or malformed stored hashes fail closed', async () => {
  const encoded = await hashPassword('a valid password', TEST_PARAMS);
  const parts = encoded.split('$');

  assert.equal(await verifyPassword('a valid password', 'garbage'), false);
  assert.equal(await verifyPassword('a valid password', ''), false);
  assert.equal(await verifyPassword('a valid password', parts.slice(0, 4).join('$')), false);
  assert.equal(
    await verifyPassword('a valid password', `argon2$${parts.slice(1).join('$')}`),
    false,
    'an unknown algorithm prefix must not be accepted',
  );
});

test('absurd cost parameters read from storage are refused, not honoured', async () => {
  const encoded = await hashPassword('a valid password', TEST_PARAMS);
  const parts = encoded.split('$');
  const inflated = ['scrypt', String(2 ** 30), parts[2], parts[3], parts[4], parts[5]].join('$');
  // A tampered row must not be able to make the verifier allocate gigabytes.
  assert.equal(await verifyPassword('a valid password', inflated), false);
});

test('needsRehash flags hashes weaker than current policy', async () => {
  const weak = await hashPassword('a valid password', TEST_PARAMS);
  assert.equal(needsRehash(weak), true);

  const current = await hashPassword('a valid password', {
    ...CURRENT_PARAMETERS,
    cost: CURRENT_PARAMETERS.cost,
  });
  assert.equal(needsRehash(current), false);
  assert.equal(needsRehash('not-a-hash'), true);
});

test('production parameters stay memory-hard', () => {
  assert.ok(CURRENT_PARAMETERS.cost >= 2 ** 15, 'cost must remain expensive');
  assert.equal(CURRENT_PARAMETERS.keyLength, 32);
});

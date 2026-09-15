import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChallenge,
  generateIdentityKeyPair,
  isIdentityPublicKey,
  signPayload,
  verifyChallengeResponse,
  verifySignature,
} from './identity.js';

const PC_A = '01J9ZQK7T0000000000000000A';
const PC_B = '01J9ZQK7T0000000000000000B';

function payloadFor(pcId: string, nonce: string): string {
  return `wolf-agent-auth v1 ${pcId} ${nonce}`;
}

test('a signature made with an identity key verifies against its public key', () => {
  const keys = generateIdentityKeyPair();
  const signature = signPayload(keys.privateKey, 'hello');
  assert.equal(verifySignature(keys.publicKey, 'hello', signature), true);
  assert.equal(verifySignature(keys.publicKey, 'hello!', signature), false);
});

test('another PC key cannot verify this PC signature', () => {
  const a = generateIdentityKeyPair();
  const b = generateIdentityKeyPair();
  const signature = signPayload(a.privateKey, 'hello');
  assert.equal(verifySignature(b.publicKey, 'hello', signature), false);
});

test('malformed keys and signatures fail closed instead of throwing', () => {
  const keys = generateIdentityKeyPair();
  assert.equal(verifySignature('not-a-key', 'hello', 'sig'), false);
  assert.equal(verifySignature(keys.publicKey, 'hello', 'not-a-signature'), false);
  assert.equal(verifySignature('', '', ''), false);
});

test('a correct challenge response is accepted', () => {
  const keys = generateIdentityKeyPair();
  const challenge = createChallenge();
  const signingPayload = payloadFor(PC_A, challenge.nonce);

  const result = verifyChallengeResponse({
    challenge,
    presentedNonce: challenge.nonce,
    signingPayload,
    signature: signPayload(keys.privateKey, signingPayload),
    publicKey: keys.publicKey,
  });
  assert.equal(result.ok, true);
});

test('a signature captured for one PC cannot authenticate another', () => {
  const keys = generateIdentityKeyPair();
  const challenge = createChallenge();
  const signature = signPayload(keys.privateKey, payloadFor(PC_A, challenge.nonce));

  const result = verifyChallengeResponse({
    challenge,
    presentedNonce: challenge.nonce,
    // The verifier builds the payload from the PC it thinks it is talking to.
    signingPayload: payloadFor(PC_B, challenge.nonce),
    signature,
    publicKey: keys.publicKey,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-signature');
});

test('a response bound to a different nonce is rejected', () => {
  const keys = generateIdentityKeyPair();
  const challenge = createChallenge();
  const stale = createChallenge();
  const signingPayload = payloadFor(PC_A, stale.nonce);

  const result = verifyChallengeResponse({
    challenge,
    presentedNonce: stale.nonce,
    signingPayload,
    signature: signPayload(keys.privateKey, signingPayload),
    publicKey: keys.publicKey,
  });
  assert.equal(result.ok === false && result.reason, 'nonce-mismatch');
});

test('an expired challenge is rejected even with a valid signature', () => {
  const keys = generateIdentityKeyPair();
  const issuedAt = new Date(Date.now() - 120_000);
  const challenge = createChallenge(issuedAt);
  const signingPayload = payloadFor(PC_A, challenge.nonce);

  const result = verifyChallengeResponse({
    challenge,
    presentedNonce: challenge.nonce,
    signingPayload,
    signature: signPayload(keys.privateKey, signingPayload),
    publicKey: keys.publicKey,
  });
  assert.equal(result.ok === false && result.reason, 'expired');
});

test('challenge nonces are unique per connection', () => {
  const nonces = new Set(Array.from({ length: 1000 }, () => createChallenge().nonce));
  assert.equal(nonces.size, 1000);
});

test('only a P-256 SPKI key is accepted for registration', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  assert.equal(isIdentityPublicKey(generateIdentityKeyPair().publicKey), true);

  const spki = (key: import('node:crypto').KeyObject) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
  assert.equal(isIdentityPublicKey(spki(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey)), false, 'another curve');
  assert.equal(isIdentityPublicKey(spki(generateKeyPairSync('ed25519').publicKey)), false, 'another algorithm');
  assert.equal(isIdentityPublicKey('cHVibGljLWtleQ'), false, 'not a key');
  assert.equal(isIdentityPublicKey(`${generateIdentityKeyPair().publicKey}==`), false, 'padded');
  assert.equal(isIdentityPublicKey(''), false);
});

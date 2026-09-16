import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeText, stateText } from './webhooks.js';

test('every delivery outcome has words, and a refused address is not called a network failure', () => {
  assert.equal(outcomeText('delivered', 204), 'Delivered (204)');
  assert.equal(outcomeText('http-error', 503), 'The receiver answered 503');
  assert.match(outcomeText('redirect', 302), /does not follow/);
  assert.match(outcomeText('address-refused', null), /private/);
  assert.match(outcomeText('tls', null), /certificate/);
});

test('a webhook WOLF turned off says why; one the owner turned off just says off', () => {
  const base = { enabled: true, disabledReason: null, consecutiveFailures: 0, lastOutcome: null, lastStatus: null } as const;

  assert.deepEqual(stateText(base), { tone: 'ok', text: 'On · nothing sent yet' });
  assert.equal(stateText({ ...base, lastOutcome: 'delivered', lastStatus: 200 }).tone, 'ok');
  assert.deepEqual(stateText({ ...base, enabled: false }), { tone: 'off', text: 'Off' });
  assert.match(stateText({ ...base, enabled: false, disabledReason: 'too-many-failures' }).text, /Turned off by WOLF/);

  const failing = stateText({ ...base, lastOutcome: 'timeout', consecutiveFailures: 4 });
  assert.equal(failing.tone, 'warn');
  assert.match(failing.text, /4 failures in a row/);
});

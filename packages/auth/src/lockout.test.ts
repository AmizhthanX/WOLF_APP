import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEARED_LOCKOUT,
  DEFAULT_LOCKOUT_POLICY,
  evaluateLockout,
  recordFailure,
} from './lockout.js';

test('the first few failures impose no delay', () => {
  let state = CLEARED_LOCKOUT;
  const now = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.freeAttempts; i++) {
    state = recordFailure(state, now);
    assert.equal(evaluateLockout(state, now).allowed, true);
  }
});

test('delays grow exponentially past the free attempts', () => {
  let state = CLEARED_LOCKOUT;
  const now = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.freeAttempts + 1; i++) {
    state = recordFailure(state, now);
  }
  const first = evaluateLockout(state, now);
  assert.equal(first.allowed, false);
  const firstDelay = first.allowed === false ? first.retryAfterSeconds : 0;

  state = recordFailure(state, now);
  const second = evaluateLockout(state, now);
  const secondDelay = second.allowed === false ? second.retryAfterSeconds : 0;
  assert.ok(secondDelay > firstDelay, 'each additional failure must cost more');
});

test('the delay is capped so the account is never permanently locked', () => {
  let state = CLEARED_LOCKOUT;
  const now = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < 50; i++) state = recordFailure(state, now);

  const decision = evaluateLockout(state, now);
  assert.equal(decision.allowed, false);
  assert.ok(
    decision.allowed === false &&
      decision.retryAfterSeconds <= DEFAULT_LOCKOUT_POLICY.maxDelaySeconds,
  );
});

test('waiting out the delay allows the next attempt', () => {
  let state = CLEARED_LOCKOUT;
  const start = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.freeAttempts + 1; i++) {
    state = recordFailure(state, start);
  }
  const blocked = evaluateLockout(state, start);
  assert.equal(blocked.allowed, false);

  const wait = blocked.allowed === false ? blocked.retryAfterSeconds : 0;
  const later = new Date(start.getTime() + (wait + 1) * 1000);
  assert.equal(evaluateLockout(state, later).allowed, true);
});

test('failures outside the window are forgotten', () => {
  let state = CLEARED_LOCKOUT;
  const start = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < 10; i++) state = recordFailure(state, start);

  const muchLater = new Date(start.getTime() + (DEFAULT_LOCKOUT_POLICY.windowSeconds + 60) * 1000);
  assert.equal(evaluateLockout(state, muchLater).allowed, true);
  assert.equal(recordFailure(state, muchLater).failureCount, 1, 'the counter restarts');
});

test('a cleared state always allows an attempt', () => {
  assert.equal(evaluateLockout(CLEARED_LOCKOUT).allowed, true);
});

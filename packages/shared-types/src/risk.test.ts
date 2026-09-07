import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxRisk, policyFor, riskAtLeast, RISK_LEVELS } from './risk.js';

test('every risk level has a policy', () => {
  for (const level of RISK_LEVELS) {
    assert.ok(policyFor(level), `missing policy for ${level}`);
  }
});

test('confirmation requirements are monotonic in severity', () => {
  assert.equal(policyFor('low').requiresConfirmation, false);
  assert.equal(policyFor('medium').requiresConfirmation, true);
  assert.equal(policyFor('high').requiresPasswordReauth, true);
  assert.equal(policyFor('critical').requiresPrivilegedGrant, true);
});

test('critical demands a fresher re-authentication than high', () => {
  assert.ok(policyFor('critical').reauthMaxAgeSeconds < policyFor('high').reauthMaxAgeSeconds);
});

test('riskAtLeast and maxRisk order levels correctly', () => {
  assert.ok(riskAtLeast('high', 'medium'));
  assert.ok(!riskAtLeast('low', 'medium'));
  assert.equal(maxRisk('medium', 'critical'), 'critical');
});

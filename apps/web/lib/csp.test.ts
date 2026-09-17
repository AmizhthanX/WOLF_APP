import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp } from './csp.js';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values];
    }),
  );
}

test('scripts run only with the request nonce, never inline in general, and eval only in development', () => {
  const production = directives(buildCsp({ nonce: 'abc123', development: false }));
  const scripts = production.get('script-src')!;
  assert.ok(scripts.includes("'nonce-abc123'"));
  assert.ok(scripts.includes("'strict-dynamic'"));
  assert.ok(!scripts.includes("'unsafe-inline'"), 'an inline script without the nonce must not run');
  assert.ok(!scripts.includes("'unsafe-eval'"));

  const development = directives(buildCsp({ nonce: 'abc123', development: true }));
  assert.ok(development.get('script-src')!.includes("'unsafe-eval'"));
});

test('the browser may reach the API and the signaling socket it is configured for, and those by default', () => {
  const byDefault = directives(buildCsp({ nonce: 'n', development: true })).get('connect-src')!;
  assert.deepEqual(byDefault, ["'self'", 'http://localhost:8080', 'ws://localhost:8081']);

  const deployed = directives(
    buildCsp({ nonce: 'n', development: false, apiUrl: 'https://api.amizhthan.app/', realtimeUrl: 'wss://relay.amizhthan.app/client' }),
  ).get('connect-src')!;
  assert.deepEqual(deployed, ["'self'", 'https://api.amizhthan.app', 'wss://relay.amizhthan.app']);
});

test('the page cannot be framed, post forms elsewhere, or load plugins', () => {
  const policy = directives(buildCsp({ nonce: 'n', development: false }));
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(policy.get('form-action'), ["'self'"]);
  assert.deepEqual(policy.get('object-src'), ["'none'"]);
  assert.deepEqual(policy.get('base-uri'), ["'self'"]);
});

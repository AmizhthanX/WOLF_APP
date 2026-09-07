import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskTail, redactRecord, REDACTED } from './redact.js';

test('redacts secret-bearing fields at any depth', () => {
  const result = redactRecord({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
    nested: { refreshToken: 'abc', deep: { apiKey: 'xyz', safe: 1 } },
  });
  assert.equal(result['email'], 'owner@example.com');
  assert.equal(result['password'], REDACTED);
  const nested = result['nested'] as Record<string, unknown>;
  assert.equal(nested['refreshToken'], REDACTED);
  const deep = nested['deep'] as Record<string, unknown>;
  assert.equal(deep['apiKey'], REDACTED);
  assert.equal(deep['safe'], 1);
});

test('never logs clipboard content, terminal output, or file content', () => {
  const result = redactRecord({
    clipboardText: 'bank password',
    stdout: 'C:\\> whoami',
    fileContent: 'binary',
    transferredBytes: 4096,
  });
  assert.equal(result['clipboardText'], REDACTED);
  assert.equal(result['stdout'], REDACTED);
  assert.equal(result['fileContent'], REDACTED);
  assert.equal(result['transferredBytes'], 4096, 'metadata is still logged');
});

test('truncates oversized strings instead of dropping them', () => {
  const result = redactRecord({ note: 'x'.repeat(1000) });
  const note = result['note'] as string;
  assert.ok(note.length < 1000);
  assert.ok(note.includes('truncated'));
});

test('caps arrays and recursion depth', () => {
  const result = redactRecord({ items: Array.from({ length: 150 }, (_, i) => i) });
  const items = result['items'] as unknown[];
  assert.equal(items.length, 101);
  assert.equal(items[100], '[50 more items]');

  let deep: Record<string, unknown> = { value: 'bottom' };
  for (let i = 0; i < 12; i++) deep = { child: deep };
  assert.ok(JSON.stringify(redactRecord(deep)).includes('max depth'));
});

test('errors are reduced to name and message', () => {
  const result = redactRecord({ failure: new Error('disk offline') });
  assert.deepEqual(result['failure'], { name: 'Error', message: 'disk offline' });
});

test('maskTail keeps only a short suffix', () => {
  assert.equal(maskTail('01HXYZABCDEF'), '********CDEF');
  assert.equal(maskTail('ab'), '**');
});

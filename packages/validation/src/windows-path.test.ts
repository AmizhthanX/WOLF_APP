import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProtectedPath,
  isWithin,
  validateFileName,
  validateWindowsPath,
} from './windows-path.js';

function reject(input: string): string {
  const result = validateWindowsPath(input);
  assert.equal(result.ok, false, `expected ${input} to be rejected`);
  return result.ok ? '' : result.reason;
}

function accept(input: string): string {
  const result = validateWindowsPath(input);
  assert.equal(result.ok, true, `expected ${input} to be accepted`);
  return result.ok ? result.normalized : '';
}

test('accepts ordinary drive and UNC paths', () => {
  assert.equal(accept('C:\\Users\\owner\\Documents'), 'C:\\Users\\owner\\Documents');
  assert.equal(accept('c:/users/owner'), 'C:\\users\\owner');
  assert.equal(accept('\\\\nas\\media\\movies'), '\\\\nas\\media\\movies');
});

test('normalizes redundant separators and current-directory segments', () => {
  assert.equal(accept('C:\\Users\\\\owner\\.\\Documents\\'), 'C:\\Users\\owner\\Documents');
});

test('rejects directory traversal in every encoding it can see', () => {
  assert.equal(reject('C:\\Users\\..\\Windows\\System32'), 'traversal');
  assert.equal(reject('C:/Users/../../Windows'), 'traversal');
  assert.equal(reject('C:\\Users\\owner\\..'), 'traversal');
});

test('rejects relative paths', () => {
  assert.equal(reject('Users\\owner'), 'not-absolute');
  assert.equal(reject('..\\owner'), 'not-absolute');
  assert.equal(reject('\\Users\\owner'), 'not-absolute');
});

test('rejects device namespace and extended-length prefixes', () => {
  assert.equal(reject('\\\\?\\C:\\Windows\\System32'), 'device-namespace');
  assert.equal(reject('\\\\.\\PhysicalDrive0'), 'device-namespace');
});

test('rejects reserved device names', () => {
  assert.equal(reject('C:\\Users\\owner\\NUL'), 'reserved-name');
  assert.equal(reject('C:\\Users\\owner\\con.txt'), 'reserved-name');
  assert.equal(reject('C:\\Users\\owner\\COM1'), 'reserved-name');
});

test('rejects alternate data streams', () => {
  assert.equal(reject('C:\\Users\\owner\\notes.txt:hidden'), 'alternate-data-stream');
});

test('rejects trailing dots and spaces that Windows would silently strip', () => {
  assert.equal(reject('C:\\Users\\owner\\payload.exe.'), 'trailing-dot-or-space');
  assert.equal(reject('C:\\Users\\owner \\file.txt'), 'trailing-dot-or-space');
});

test('rejects control characters, illegal characters, and wildcards', () => {
  assert.equal(reject('C:\\Users\\ow\u0000ner'), 'invalid-character');
  assert.equal(reject('C:\\Users\\<owner>'), 'invalid-character');
  assert.equal(reject('C:\\Users\\*'), 'wildcard');
});

test('allows wildcards only when the caller opts in', () => {
  const result = validateWindowsPath('C:\\Users\\owner\\*.log', { allowWildcards: true });
  assert.equal(result.ok, true);
});

test('rejects empty and oversized input', () => {
  assert.equal(reject('   '), 'empty');
  assert.equal(reject('C:\\' + 'a'.repeat(5000)), 'too-long');
});

test('rejects malformed UNC paths that name no share', () => {
  assert.equal(reject('\\\\nas'), 'not-absolute');
  assert.equal(reject('\\\\nas\\'), 'not-absolute');
});

test('flags Windows-owned locations as protected', () => {
  assert.ok(isProtectedPath('C:\\Windows\\System32'));
  assert.ok(isProtectedPath('C:\\Program Files\\WOLF'));
  assert.ok(isProtectedPath('C:\\PROGRAMDATA'));
  assert.ok(isProtectedPath('C:'), 'a drive root is protected');
  assert.ok(!isProtectedPath('C:\\Users\\owner'));
  assert.ok(
    !isProtectedPath('C:\\Windows Update Logs'),
    'a sibling with a shared prefix is not inside C:\\Windows',
  );
});

test('validated paths report their protected status', () => {
  const result = validateWindowsPath('C:\\Windows\\System32\\drivers\\etc\\hosts');
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.protectedLocation);
});

test('isWithin confines paths to their root without prefix confusion', () => {
  assert.ok(isWithin('C:\\Users\\owner', 'C:\\Users\\owner\\Documents\\a.txt'));
  assert.ok(isWithin('C:\\Users\\owner', 'c:\\users\\OWNER'));
  assert.ok(!isWithin('C:\\Users\\owner', 'C:\\Users\\owner2\\secret.txt'));
  assert.ok(!isWithin('C:\\Users\\owner', 'C:\\Users'));
});

test('validateFileName rejects separators and reserved names', () => {
  assert.equal(validateFileName('report.txt').ok, true);
  assert.equal(validateFileName('sub\\report.txt').ok, false);
  assert.equal(validateFileName('PRN').ok, false);
  assert.equal(validateFileName('').ok, false);
});

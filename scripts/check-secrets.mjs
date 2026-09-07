#!/usr/bin/env node
/**
 * Refuse to build if something that looks like a credential was committed.
 *
 * This is a blunt instrument on purpose. It will not catch a determined mistake, but it
 * does catch the common ones — a pasted private key, a real `.env`, a service-account JSON
 * — at the moment they enter the repository rather than after they have been published.
 */
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'bin',
  'obj',
  'coverage',
  'artifacts',
]);

/** Files whose whole purpose is to describe secrets without containing any. */
const ALLOWED_FILES = new Set([
  '.env.example',
  'scripts/check-secrets.mjs',
  'docs/security/security-model.md',
]);

const PATTERNS = [
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'private key JSON field', pattern: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'hard-coded connection password', pattern: /postgres(?:ql)?:\/\/[^\s:@]+:(?!wolf@|password@)[^\s:@]{8,}@/ },
];

/** Filenames that should never be in the repository at all. */
const FORBIDDEN_NAMES = [
  /^\.env$/,
  /^\.env\.(local|production|staging)$/,
  /\.pem$/,
  /\.pfx$/,
  /\.p12$/,
  /\.jks$/,
  /\.keystore$/,
  /^service-account.*\.json$/,
  /^gcp-credentials.*\.json$/,
];

function trackedFiles() {
  // Only files git knows about: an untracked scratch file is the developer's business.
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter((entry) => entry.length > 0);
}

const findings = [];

for (const file of trackedFiles()) {
  const normalized = file.split(path.sep).join('/');
  if (normalized.split('/').some((segment) => SKIP_DIRECTORIES.has(segment))) continue;

  const basename = path.basename(normalized);
  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(basename))) {
    findings.push(`${normalized}: this file must never be committed`);
    continue;
  }

  if (ALLOWED_FILES.has(normalized)) continue;

  let stats;
  try {
    stats = statSync(normalized);
  } catch {
    continue; // Deleted but still in the index.
  }
  if (!stats.isFile() || stats.size > 2_000_000) continue;

  let contents;
  try {
    contents = readFileSync(normalized, 'utf8');
  } catch {
    continue; // Binary.
  }

  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(contents)) {
      findings.push(`${normalized}: looks like a ${name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write('Possible secrets found in tracked files:\n');
  for (const finding of findings) {
    process.stderr.write(`  - ${finding}\n`);
  }
  process.stderr.write(
    '\nRemove the value, rotate it if it was ever real, and use environment variables ' +
      'or the secret manager instead.\n',
  );
  process.exit(1);
}

process.stdout.write('No committed secrets found.\n');

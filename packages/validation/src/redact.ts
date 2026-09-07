/**
 * Redaction for structured logs and audit records.
 *
 * WOLF logs command metadata, not command content. This module is the single chokepoint
 * that strips secrets before anything reaches a log sink or an audit row, so a new field
 * name added to a payload cannot leak by default.
 */

/** Field names whose values are never logged, matched case-insensitively as substrings. */
const SECRET_FIELD_PATTERNS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'private_key',
  'apikey',
  'api_key',
  'sessionkey',
  'session_key',
  'unlockcode',
  'unlock_code',
  'pin',
  'otp',
  'clipboard',
  'filecontent',
  'file_content',
  'stdout',
  'stderr',
  'output',
];

export const REDACTED = '[redacted]';

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((pattern) => normalized.includes(pattern));
}

const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 512;

/**
 * Recursively redact secret-bearing fields and truncate long strings.
 * Unknown object shapes are handled structurally, so this is safe for arbitrary payloads.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated: max depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, 100).map((item) => redact(item, depth + 1));
    return value.length > 100 ? [...capped, `[${value.length - 100} more items]`] : capped;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  // Functions, symbols, and anything else never belong in a log record.
  return `[unloggable: ${typeof value}]`;
}

/** Redact an object intended for a log line or audit record. */
export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redact(value) as Record<string, unknown>;
}

/** Mask all but the last `visible` characters, for identifiers safe to partially show. */
export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - visible)}${value.slice(-visible)}`;
}

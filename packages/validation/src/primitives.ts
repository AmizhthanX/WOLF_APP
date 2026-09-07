import { z } from 'zod';

/** WOLF sortable identifier (Crockford base32, 26 chars). */
export const wolfId = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a WOLF identifier');

/** UTC ISO-8601 timestamp. */
export const isoDateTime = z.string().datetime({ offset: true });

/** Human-facing name for a PC, device, profile, group, or automation rule. */
export const displayName = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(120, 'must be at most 120 characters')
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must not contain control characters');

/** Owner account email. */
export const email = z.string().trim().toLowerCase().email().max(254);

/**
 * Password policy for the single owner account. Length is the dominant factor; we do not
 * impose composition rules that push users toward predictable substitutions.
 */
export const password = z
  .string()
  .min(12, 'must be at least 12 characters')
  .max(1024, 'must be at most 1024 characters');

/** Base64url-encoded public key material. */
export const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/** Idempotency key supplied by clients so retries never double-execute a command. */
export const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/** Non-negative integer, e.g. a PID or byte count. */
export const nonNegativeInt = z.number().int().nonnegative();

/** Windows process id. PID 0 (System Idle) is never a valid command target. */
export const pid = z.number().int().min(1).max(0xffffffff);

/** Windows service name — the SCM key name, not the display name. */
export const serviceName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.\-]+$/, 'must be a Windows service key name');

export const tag = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'must be alphanumeric with spaces, dashes, or underscores');

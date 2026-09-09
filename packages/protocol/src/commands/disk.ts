import { z } from 'zod';

/**
 * Disk health, which is the first thing WOLF cannot do without elevation.
 *
 * Reading a drive's SMART attributes means opening `\\.\PhysicalDriveN` and issuing a
 * storage IOCTL, and Windows requires administrative rights for that however harmless the
 * read is. It is the reason the privileged helper exists, and a good first thing to put
 * through it: entirely read-only, so a mistake in the plumbing cannot damage anything.
 */

export const diskSmartHealthCommand = z.object({
  type: z.literal('disk.smart-health'),
  payload: z.object({
    /** One physical drive by its device id, or null for every drive on the PC. */
    deviceId: z.string().max(128).nullable().default(null),
  }),
});

export const diskCommand = z.discriminatedUnion('type', [diskSmartHealthCommand]);

export type DiskCommand = z.infer<typeof diskCommand>;

/**
 * What a drive says about its own health.
 *
 * `unknown` is a real answer and the most common one on hardware WOLF cannot ask: a USB
 * enclosure that does not pass SMART through, a RAID volume, a virtual disk. Reporting it
 * as healthy would be inventing reassurance.
 */
export const DISK_HEALTH_STATUSES = ['healthy', 'warning', 'failing', 'unknown'] as const;
export const diskHealthStatus = z.enum(DISK_HEALTH_STATUSES);
export type DiskHealthStatus = z.infer<typeof diskHealthStatus>;

/**
 * A SMART attribute, as the drive reports it.
 *
 * Both the raw value and the normalised one are carried because they answer different
 * questions: the normalised value against its threshold is what "failing" means, while the
 * raw value is the number a person recognises — hours powered on, sectors reallocated.
 */
export const smartAttribute = z.object({
  id: z.number().int().min(0).max(255),
  name: z.string().max(64),
  /** Vendor-normalised, 1..253, higher is better. */
  value: z.number().int().min(0).max(255),
  worst: z.number().int().min(0).max(255),
  /** The value below which the vendor considers the attribute failed. */
  threshold: z.number().int().min(0).max(255),
  /** Vendor-specific, and only meaningful for attributes with a known meaning. */
  raw: z.number().nonnegative(),
  /** True when the drive says this attribute predicts failure rather than logging wear. */
  prefail: z.boolean(),
  /** True when `value` has fallen to or below `threshold`. */
  failing: z.boolean(),
});
export type SmartAttribute = z.infer<typeof smartAttribute>;

export const diskHealth = z.object({
  /** Stable device id, e.g. the physical drive path. */
  deviceId: z.string().max(128),
  model: z.string().max(128).nullable(),
  serialNumber: z.string().max(128).nullable(),
  firmware: z.string().max(64).nullable(),
  sizeBytes: z.number().nonnegative().nullable(),
  busType: z.string().max(32).nullable(),
  /** True for solid state, false for rotating, null when the drive does not say. */
  solidState: z.boolean().nullable(),
  status: diskHealthStatus,
  /**
   * Why the status is what it is, in the operator's terms.
   *
   * Always present, including for `unknown` — "this enclosure does not pass SMART through"
   * is the answer somebody needs, and a blank field is not.
   */
  summary: z.string().max(300),
  temperatureCelsius: z.number().nullable(),
  powerOnHours: z.number().nonnegative().nullable(),
  /** Attributes the drive reported. Empty when SMART could not be read at all. */
  attributes: z.array(smartAttribute).max(64).default([]),
});
export type DiskHealth = z.infer<typeof diskHealth>;

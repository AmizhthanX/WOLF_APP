import type { DeviceId, UserId } from './ids.js';

/** Client device kinds that can hold their own cryptographic identity. */
export const DEVICE_KINDS = ['web', 'pwa', 'android', 'windows-control-panel'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_STATUSES = ['pending', 'active', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * An authorized client device. Each device holds its own identity and can be revoked
 * without destroying the account or any other device's trust.
 */
export interface UserDevice {
  readonly id: DeviceId;
  readonly userId: UserId;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly status: DeviceStatus;
  /** Base64url SPKI of the device's Ed25519 public key. Private key never leaves the device. */
  readonly publicKey: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  /** Coarse client description for the device list. Never a full user-agent fingerprint. */
  readonly platform: string | null;
  /** Authorized for direct LAN access to PCs without a cloud round trip. */
  readonly lanAuthorized: boolean;
}

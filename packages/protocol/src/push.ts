import { z } from 'zod';

/**
 * Push wake-ups for phones.
 *
 * ## A wake-up says nothing
 *
 * A push message goes through the platform's push service — Google's Firebase Cloud Messaging, for
 * Android — which is a third party WOLF does not control and whose logs WOLF cannot see. So what WOLF
 * sends through it is **content-free**: that there is something new, and nothing about what. No PC name,
 * no alert title, no severity, no count. The phone wakes and fetches its notifications from WOLF over its
 * own authenticated connection, exactly as it would with the app open.
 *
 * The cost is a round trip before anything is shown. The alternative — a notification body in the push
 * payload — would put "DESKTOP-50RGWF is offline" in a third party's hands for every alert, which is the
 * kind of fact about somebody this project keeps off servers it does not run.
 *
 * ## Not configured is a state, not a failure
 *
 * A WOLF server without push credentials sends no wake-ups and says so, and the phone tells its owner that
 * notifications arrive only while the app is open. Nothing pretends a wake-up was sent.
 */

export const PUSH_PROVIDERS = ['fcm'] as const;
export const pushProvider = z.enum(PUSH_PROVIDERS);
export type PushProvider = z.infer<typeof pushProvider>;

/** A provider's registration token. Opaque to WOLF, bounded, printable ASCII without spaces. */
export const pushToken = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/, 'A push token is printable ASCII without spaces.');

export const registerPushTokenBody = z.object({
  provider: pushProvider,
  token: pushToken,
});
export type RegisterPushTokenBody = z.infer<typeof registerPushTokenBody>;

/**
 * The whole of a wake-up's data. String keys and values, as FCM data messages require. The version lets a
 * later phone tell a newer message apart; there is nothing else to add.
 */
export const PUSH_WAKE = Object.freeze({ kind: 'wolf.wake', v: '1' } as const);
export type PushWake = typeof PUSH_WAKE;

export interface PushStatus {
  /** Whether this server has a push service configured at all. */
  readonly configured: boolean;
  readonly provider: PushProvider | null;
  /** Whether the device asking has a token registered. */
  readonly registered: boolean;
}

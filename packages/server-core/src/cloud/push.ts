import type { PushProvider } from '@wolf/protocol';

/**
 * Sending a wake-up to one device, whatever carries it.
 *
 * The cloud-provider seam for push: business logic knows a device id, a token and three outcomes, and
 * nothing about which company's service delivers the message. `gcp/fcm.ts` is the Firebase adapter.
 */

export interface PushTarget {
  readonly deviceId: string;
  readonly token: string;
}

/**
 * `token-invalid`: the provider says the token no longer reaches a device — the app was uninstalled, its
 * data cleared, or the token rotated — so it should be forgotten. `failed`: anything else; the notification
 * is still in the inbox, and the phone shows it the next time it looks.
 */
export type PushOutcome = 'delivered' | 'token-invalid' | 'failed';

export interface PushSender {
  readonly provider: PushProvider;
  /** Send the content-free wake-up. Never throws, and never logs the token. */
  wake(target: PushTarget): Promise<PushOutcome>;
}

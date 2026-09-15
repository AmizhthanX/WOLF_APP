import type { Config } from '../config.js';
import { FcmPushSender, readFcmCredentials } from './gcp/fcm.js';
import type { PushSender } from './push.js';

export * from './push.js';
export * from './gcp/fcm.js';

/**
 * The push sender this server is configured with, or null when it has none.
 *
 * Null is a real answer: the server sends no wake-ups and says so. A misconfigured provider — credentials
 * that cannot be read — refuses to start instead of starting without push and saying nothing.
 */
export async function createPushSender(config: Config): Promise<PushSender | null> {
  if (config.push.provider === 'none') return null;

  const credentials = await readFcmCredentials(config.push.fcmCredentialsFile ?? '');
  return new FcmPushSender({ projectId: config.push.fcmProjectId ?? '', credentials });
}

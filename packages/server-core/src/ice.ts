import { createHmac } from 'node:crypto';
import type { IceConfiguration, IceServer } from '@wolf/protocol';

/**
 * ICE configuration, built once and used by everything that needs it.
 *
 * Two components hand out these servers: the API, when a client asks before starting a
 * stream, and the realtime service, when it relays that request to the agent. Both ends of
 * one connection have to be given the same relay, so this lives in one place rather than
 * being implemented twice and drifting.
 */

/** The shape this needs from the service configuration. */
export interface IceSettings {
  readonly stunUrls: readonly string[];
  readonly turnUrls: readonly string[];
  readonly turnSecret: string;
  readonly turnCredentialTtlSeconds: number;
  readonly internetCapable: boolean;
}

/**
 * TURN REST credentials.
 *
 * The username encodes an expiry, and the credential is an HMAC of that username under a
 * secret the TURN server also holds (coturn's `static-auth-secret`). Nothing per-session is
 * stored anywhere, and a leaked credential stops working on its own when the expiry passes.
 */
export function mintTurnCredential(
  secret: string,
  userId: string,
  ttlSeconds: number,
  now: Date,
): { username: string; credential: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const username = `${Math.floor(expiresAt.getTime() / 1000)}:${userId}`;
  // HMAC-SHA1 is what the TURN REST API specifies and what coturn verifies. It is a
  // message authentication code over a short-lived public string, not a password hash.
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt };
}

/**
 * The ICE servers to hand one party of one connection.
 *
 * Returns an empty server list when nothing is configured, which is the shipped default:
 * WOLF does not route anybody's screen through a third party's STUN or TURN server unless
 * an operator has chosen one. Callers report that as `lan-only` rather than letting it be
 * discovered through a connection that never establishes.
 */
export function buildIceConfiguration(
  ice: IceSettings,
  userId: string,
  now: Date,
): IceConfiguration {
  const iceServers: IceServer[] = [];

  if (ice.stunUrls.length > 0) {
    iceServers.push({ urls: [...ice.stunUrls], username: null, credential: null });
  }

  let expiresAt = new Date(now.getTime() + 3_600_000);

  if (ice.turnUrls.length > 0 && ice.turnSecret) {
    const minted = mintTurnCredential(ice.turnSecret, userId, ice.turnCredentialTtlSeconds, now);
    iceServers.push({
      urls: [...ice.turnUrls],
      username: minted.username,
      credential: minted.credential,
    });
    expiresAt = minted.expiresAt;
  }

  return {
    iceServers,
    expiresAt: expiresAt.toISOString(),
    // "all" so host candidates can win on a LAN without ever touching a relay. Forcing
    // relay is a diagnostic, never a default.
    iceTransportPolicy: 'all',
  };
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, type AccessTokenClaims } from '@wolf/auth';
import type { SessionCapability } from '@wolf/shared-types';
import type { AppContext } from './context.js';
import { forbidden, missingCapability, unauthorized } from './errors.js';

/** Authenticated caller attached to a request after `authenticate` runs. */
export interface RequestAuth {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string | null;
  readonly pcId: string | null;
  readonly capabilities: readonly SessionCapability[];
  readonly claims: AccessTokenClaims;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * Authenticate a request.
 *
 * A valid signature is not sufficient: the device must still exist and be active. That
 * check is what makes device revocation take effect within one access-token lifetime
 * rather than at the next sign-in.
 */
export function createAuthenticate(context: AppContext) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = bearerToken(request);
    if (!token) {
      throw unauthorized('No bearer token was supplied.');
    }

    const result = verifyAccessToken(token, {
      signer: context.signer,
      issuer: context.config.tokens.issuer,
      audience: context.config.tokens.audience,
      now: context.now().getTime(),
    });

    if (!result.ok) {
      const causes: Record<typeof result.reason, string> = {
        malformed: 'The access token is malformed.',
        'bad-signature': 'The access token signature did not verify.',
        expired: 'The access token has expired.',
        'not-yet-valid': 'The access token is not valid yet.',
        'wrong-issuer': 'The access token was issued by a different service.',
        'wrong-audience': 'The access token was issued for a different audience.',
        'unsupported-algorithm': 'The access token uses an unsupported signing algorithm.',
      };
      throw unauthorized(causes[result.reason]);
    }

    const device = await context.repos.devices.findActive(result.claims.did, result.claims.sub);
    if (!device) {
      throw unauthorized('The device this token was issued to is no longer authorized.');
    }

    request.auth = {
      userId: result.claims.sub,
      deviceId: result.claims.did,
      sessionId: result.claims.sid ?? null,
      pcId: result.claims.pid ?? null,
      capabilities: result.claims.cap ?? [],
      claims: result.claims,
    };
  };
}

/** Read the authenticated caller, or fail closed. */
export function requireAuth(request: FastifyRequest): RequestAuth {
  if (!request.auth) {
    throw unauthorized('This endpoint requires authentication.');
  }
  return request.auth;
}

/**
 * Require a session capability.
 *
 * Account-level tokens carry no capabilities; capabilities are granted per PC session, so
 * an account token can browse but cannot act on a PC.
 */
export function requireCapability(
  request: FastifyRequest,
  capability: SessionCapability,
): RequestAuth {
  const auth = requireAuth(request);
  if (!auth.capabilities.includes(capability)) {
    throw missingCapability(capability);
  }
  return auth;
}

/** Require that the token is scoped to the PC being acted on. */
export function requirePcScope(request: FastifyRequest, pcId: string): RequestAuth {
  const auth = requireAuth(request);
  if (auth.pcId !== null && auth.pcId !== pcId) {
    throw forbidden(
      'The session token is scoped to a different PC.',
      'Start a session for this PC and retry.',
    );
  }
  return auth;
}

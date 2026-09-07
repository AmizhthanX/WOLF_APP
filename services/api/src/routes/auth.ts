import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_KINDS } from '@wolf/shared-types';
import { displayName, email, parseOrThrow, password } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { AuthService } from '../services/auth-service.js';
import { RATE_LIMITS } from '../http/rate-limit.js';
import { requireAuth } from '../http/auth.js';
import { tooManyRequests, unauthorized } from '../http/errors.js';

const deviceDescriptor = z.object({
  id: z.string().length(26).optional(),
  kind: z.enum(DEVICE_KINDS),
  name: displayName,
  platform: z.string().max(200).nullable().optional(),
  publicKey: z.string().max(512).nullable().optional(),
});

const loginBody = z.object({
  email,
  password,
  device: deviceDescriptor,
});

const refreshBody = z.object({
  refreshToken: z.string().min(16).max(512),
  deviceId: z.string().length(26),
});

const logoutBody = z.object({
  refreshToken: z.string().min(16).max(512),
});

const reauthBody = z.object({
  password,
});

export async function registerAuthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const auth = new AuthService(context);

  /**
   * Sign in. There is no registration endpoint: the single owner account is created by the
   * bootstrap script, which runs against the database and not over HTTP.
   */
  app.post('/auth/login', async (request, reply) => {
    const sourceIp = request.ip ?? null;
    const limit = context.rateLimiter.consume(
      `login:${sourceIp}`,
      RATE_LIMITS.login.limit,
      RATE_LIMITS.login.windowSeconds,
      context.now().getTime(),
    );
    if (!limit.allowed) {
      throw tooManyRequests(limit.retryAfterSeconds, 'Too many sign-in attempts from this address.');
    }

    const body = parseOrThrow(loginBody, request.body, { area: 'AUTH', what: 'The sign-in request' });
    const result = await auth.login({
      email: body.email,
      password: body.password,
      device: body.device,
      sourceIp,
    });

    context.rateLimiter.reset(`login:${sourceIp}`);
    return reply.status(200).send(result);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const sourceIp = request.ip ?? null;
    const limit = context.rateLimiter.consume(
      `refresh:${sourceIp}`,
      RATE_LIMITS.refresh.limit,
      RATE_LIMITS.refresh.windowSeconds,
      context.now().getTime(),
    );
    if (!limit.allowed) {
      throw tooManyRequests(limit.retryAfterSeconds, 'Too many refresh attempts from this address.');
    }

    const body = parseOrThrow(refreshBody, request.body, {
      area: 'AUTH',
      what: 'The refresh request',
    });
    const result = await auth.refresh({
      refreshToken: body.refreshToken,
      deviceId: body.deviceId,
      sourceIp,
    });
    return reply.status(200).send(result);
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = parseOrThrow(logoutBody, request.body, {
      area: 'AUTH',
      what: 'The sign-out request',
    });
    await auth.logout(body.refreshToken);
    // Always 204: whether the token existed is not information a caller needs.
    return reply.status(204).send();
  });

  /** Re-enter the password to unlock high and critical risk actions. */
  app.post(
    '/auth/reauthenticate',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const body = parseOrThrow(reauthBody, request.body, {
        area: 'AUTH',
        what: 'The re-authentication request',
      });

      const result = await auth.reauthenticate({
        userId: caller.userId,
        deviceId: caller.deviceId,
        password: body.password,
        sourceIp: request.ip ?? null,
      });
      return reply.status(200).send(result);
    },
  );

  app.get('/users/me', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const user = await context.repos.users.findById(caller.userId);
    if (!user) throw unauthorized('The account no longer exists.');

    const device = await context.repos.devices.findById(caller.deviceId);
    return reply.status(200).send({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      device: device
        ? { id: device.id, name: device.name, kind: device.kind, lanAuthorized: device.lanAuthorized }
        : null,
      // Seconds since the password was last proven; the UI uses this to decide whether a
      // high-risk action will prompt before the user commits to it.
      passwordVerifiedSecondsAgo:
        Math.floor(context.now().getTime() / 1000) - caller.claims.auth_time,
    });
  });
}

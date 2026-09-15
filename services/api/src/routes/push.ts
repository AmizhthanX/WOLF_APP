import type { FastifyInstance } from 'fastify';
import { registerPushTokenBody, type PushStatus } from '@wolf/protocol';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';

/**
 * Push registration for the device making the request.
 *
 * Only ever the caller's own device: a token is registered for, and cleared from, the device the access
 * token belongs to, so no device can point another's wake-ups anywhere. The audit trail records that a token
 * was registered or cleared — never the token.
 */
export async function registerPushRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/push', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const provider = context.config.push.provider;
    const status: PushStatus = {
      configured: provider !== 'none',
      provider: provider === 'none' ? null : provider,
      registered: await context.repos.push.hasToken(caller.deviceId),
    };
    return reply.header('cache-control', 'no-store').send(status);
  });

  app.put('/push/token', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const body = parseOrThrow(registerPushTokenBody, request.body, { what: 'The push registration' });

    await context.repos.push.setToken({ deviceId: caller.deviceId, userId: caller.userId, provider: body.provider, token: body.token });

    await context.repos.audit.record({
      category: 'device',
      action: 'device.push-token.register',
      outcome: 'success',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'device', deviceId: caller.deviceId, provider: body.provider },
    });

    return reply.status(204).send();
  });

  app.delete('/push/token', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const cleared = await context.repos.push.clearToken(caller.deviceId, caller.userId);

    if (cleared) {
      await context.repos.audit.record({
        category: 'device',
        action: 'device.push-token.clear',
        outcome: 'success',
        riskLevel: 'low',
        userId: caller.userId,
        deviceId: caller.deviceId,
        requestId: request.id,
        sourceIp: request.ip ?? null,
        target: { kind: 'device', deviceId: caller.deviceId },
      });
    }

    return reply.status(204).send();
  });
}

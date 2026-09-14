import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';
import { withTransaction } from '@wolf/server-core';
import { conflict, notFound } from '../http/errors.js';

const deviceIdParams = z.object({ deviceId: z.string().length(26) });
const patchBody = z.object({ lanAuthorized: z.boolean() });

export async function registerDeviceRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.get('/devices', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const devices = await context.repos.devices.listForUser(caller.userId);
    return reply.send({
      devices: devices.map((device) => ({
        ...device,
        // Never echo key material back to a client that did not supply it.
        publicKey: device.publicKey ? `${device.publicKey.slice(0, 12)}…` : null,
        current: device.id === caller.deviceId,
      })),
    });
  });

  /**
   * Revoke a device.
   *
   * Revocation ends the device's sessions and kills its refresh tokens in one transaction,
   * so the longest a revoked device can keep acting is one access-token lifetime.
   */
  app.delete('/devices/:deviceId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(deviceIdParams, request.params, { what: 'The device id' });

    if (params.deviceId === caller.deviceId) {
      throw conflict(
        'A device cannot revoke itself.',
        'Revoking the device you are signed in on would lock you out of this session.',
        'Sign out instead, or revoke this device from another device.',
      );
    }

    const device = await context.repos.devices.findById(params.deviceId);
    if (!device || device.userId !== caller.userId) throw notFound('That device');

    const revoked = await withTransaction(context.db, async (client) => {
      const ok = await context.repos.devices.revoke(params.deviceId, caller.userId, client);
      if (ok) {
        await context.repos.refreshTokens.revokeForDevice(params.deviceId, client);
        await context.repos.sessions.endAllForDevice(params.deviceId, 'device-revoked', client);

        // An automation acts on the authority of the device it was saved from. That authority ends
        // with the device, in the same transaction, rather than at each automation's next run.
        const disabled = await context.repos.automations.disableForDevice(params.deviceId, client);
        if (disabled.length > 0) {
          await context.repos.audit.record(
            {
              category: 'automation',
              action: 'automation.disable',
              outcome: 'success',
              riskLevel: 'low',
              userId: caller.userId,
              deviceId: caller.deviceId,
              requestId: request.id,
              target: { kind: 'device-revoked', deviceId: params.deviceId, automationIds: disabled.join(',') },
            },
            client,
          );
        }
      }
      return ok;
    });

    if (!revoked) throw notFound('That device');

    await context.repos.audit.record({
      category: 'device',
      action: 'device.revoke',
      outcome: 'success',
      riskLevel: 'high',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'device', deviceId: params.deviceId, name: device.name },
    });
    await context.repos.audit.recordSecurityEvent({
      type: 'device-revoked',
      userId: caller.userId,
      deviceId: params.deviceId,
      sourceIp: request.ip ?? null,
    });

    return reply.status(204).send();
  });

  /** Authorize a device for direct LAN access to PCs, bypassing the cloud round trip. */
  app.patch('/devices/:deviceId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(deviceIdParams, request.params, { what: 'The device id' });
    const body = parseOrThrow(patchBody, request.body, { what: 'The device update' });

    const updated = await context.repos.devices.setLanAuthorized(
      params.deviceId,
      caller.userId,
      body.lanAuthorized,
    );
    if (!updated) throw notFound('That device');

    await context.repos.audit.record({
      category: 'device',
      action: 'device.set-lan-authorization',
      outcome: 'success',
      riskLevel: 'high',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'device', deviceId: params.deviceId },
      afterValue: { lanAuthorized: body.lanAuthorized },
    });

    const device = await context.repos.devices.findById(params.deviceId);
    return reply.send({ device });
  });
}

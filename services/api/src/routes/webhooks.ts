import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_WEBHOOKS,
  webhookInput,
  webhookPatch,
  type Webhook,
  type WebhookBody,
} from '@wolf/protocol';
import { WolfError, newId, policyFor } from '@wolf/shared-types';
import { WebhookSecrets, WebhookSender, withTransaction, type StoredWebhook } from '@wolf/server-core';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth, type RequestAuth } from '../http/auth.js';
import { conflict, notFound, reauthenticationRequired, tooManyRequests } from '../http/errors.js';

/**
 * Webhooks: the owner's notifications sent to a URL they chose. See `packages/protocol/src/webhooks.ts` for what
 * WOLF refuses to send to, and why.
 *
 * Making a webhook, or seeing its signing secret again, needs the owner's password entered within the last five
 * minutes: from then on WOLF sends the account's notifications to a third party, unattended. Renaming one,
 * retuning its severity or turning it off needs nothing more than being signed in.
 *
 * The URL is never returned once saved, and never audited or logged — Slack's and Discord's carry their
 * credential in the path. Audit records name the host.
 */

const webhookParams = z.object({ webhookId: z.string().length(26) });
const createBody = z.object({ webhook: z.unknown() });
const TEST_LIMIT = { limit: 10, windowSeconds: 600 };

function publicWebhook(webhook: StoredWebhook): Webhook {
  return {
    id: webhook.id,
    name: webhook.name,
    host: webhook.host,
    minSeverity: webhook.minSeverity,
    enabled: webhook.enabled,
    disabledReason: webhook.disabledReason,
    consecutiveFailures: webhook.consecutiveFailures,
    lastDeliveryAt: webhook.lastDeliveryAt?.toISOString() ?? null,
    lastOutcome: webhook.lastOutcome,
    lastStatus: webhook.lastStatus,
    createdAt: webhook.createdAt.toISOString(),
  };
}

function notConfigured(): WolfError {
  return new WolfError({
    code: 'webhooks.not_configured',
    problem: 'Webhooks are not set up on this WOLF server.',
    cause: 'The server has no webhook key, which it needs to keep webhook URLs encrypted and to sign what it sends.',
    currentState: 'No webhook was saved. Notifications are still delivered in the app.',
    recommendedAction: 'Set WOLF_WEBHOOK_KEY from secret management on the server, then try again.',
    area: 'API',
    httpStatus: 409,
  });
}

function addressRefused(detail: string): WolfError {
  return new WolfError({
    code: 'webhooks.address_refused',
    problem: 'WOLF will not send webhooks to that URL.',
    cause: detail,
    currentState: 'No webhook was saved.',
    recommendedAction: 'Use a public https address, such as the one Slack, Discord or your own internet-facing service gives you.',
    area: 'API',
    httpStatus: 422,
  });
}

export async function registerWebhookRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const key = context.config.webhooks.key;
  const secrets = key ? new WebhookSecrets(key) : null;
  const sender = context.webhookSender ?? new WebhookSender();

  function requireSecrets(): WebhookSecrets {
    if (!secrets) throw notConfigured();
    return secrets;
  }

  /** The password, recently. The same window a high-risk command gets. */
  async function requireFreshPassword(request: FastifyRequest, caller: RequestAuth, action: string, what: string): Promise<void> {
    const maxAge = policyFor('high').reauthMaxAgeSeconds;
    const age = Math.floor(context.now().getTime() / 1000) - caller.claims.auth_time;
    if (age <= maxAge) return;

    await context.repos.audit.record({
      category: 'configuration',
      action,
      outcome: 'denied',
      riskLevel: 'high',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      errorCode: 'reauth-required',
    });
    throw reauthenticationRequired(what, maxAge);
  }

  app.get('/webhooks', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const webhooks = secrets ? await context.repos.webhooks.listForUser(caller.userId) : [];
    return reply
      .header('cache-control', 'no-store')
      .send({ configured: secrets !== null, webhooks: webhooks.map(publicWebhook), limit: MAX_WEBHOOKS });
  });

  app.post('/webhooks', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const seal = requireSecrets();
    const body = parseOrThrow(createBody, request.body, { what: 'The webhook' });
    const input = parseOrThrow(webhookInput, body.webhook, { what: 'The webhook' });
    const host = new URL(input.url).host;

    await requireFreshPassword(request, caller, 'webhook.create', 'Adding a webhook');

    const verdict = await sender.check(input.url);
    if (!verdict.ok) {
      await context.repos.audit.record({
        category: 'configuration',
        action: 'webhook.create',
        outcome: 'denied',
        riskLevel: 'high',
        userId: caller.userId,
        deviceId: caller.deviceId,
        requestId: request.id,
        sourceIp: request.ip ?? null,
        target: { kind: 'webhook', host },
        errorCode: `address-${verdict.reason}`,
      });
      throw addressRefused(verdict.detail);
    }

    const id = newId();
    const salt = seal.newSalt();

    const created = await withTransaction(context.db, async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      if ((await context.repos.webhooks.countForUser(caller.userId, client)) >= MAX_WEBHOOKS) {
        throw conflict(
          'This account already has the maximum number of webhooks.',
          `An account can hold at most ${MAX_WEBHOOKS} webhooks.`,
          'Delete a webhook you no longer use.',
        );
      }

      const webhook = await context.repos.webhooks.create(
        { id, userId: caller.userId, name: input.name, host, urlSealed: seal.encryptUrl(id, input.url), secretSalt: salt, minSeverity: input.minSeverity },
        client,
      );

      await context.repos.audit.record(
        {
          category: 'configuration',
          action: 'webhook.create',
          outcome: 'success',
          riskLevel: 'high',
          userId: caller.userId,
          deviceId: caller.deviceId,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          target: { kind: 'webhook', webhookId: id, host },
          afterValue: { name: input.name, minSeverity: input.minSeverity },
        },
        client,
      );
      return webhook;
    });

    // The secret is shown once, here. It is not stored, and is only shown again by rotating it.
    return reply
      .status(201)
      .header('cache-control', 'no-store')
      .send({ webhook: publicWebhook(created), secret: seal.signingSecret(id, salt) });
  });

  app.patch('/webhooks/:webhookId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    requireSecrets();
    const params = parseOrThrow(webhookParams, request.params, { what: 'The webhook id' });
    const patch = parseOrThrow(webhookPatch, request.body, { what: 'The change' });

    const before = await context.repos.webhooks.find(params.webhookId, caller.userId);
    if (!before) throw notFound('That webhook');

    const updated = await context.repos.webhooks.update(params.webhookId, caller.userId, patch);
    if (!updated) throw notFound('That webhook');

    await context.repos.audit.record({
      category: 'configuration',
      action: 'webhook.update',
      outcome: 'success',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'webhook', webhookId: updated.id, host: updated.host },
      beforeValue: { name: before.name, enabled: before.enabled, minSeverity: before.minSeverity },
      afterValue: { name: updated.name, enabled: updated.enabled, minSeverity: updated.minSeverity },
    });

    return reply.send({ webhook: publicWebhook(updated) });
  });

  app.post('/webhooks/:webhookId/rotate-secret', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const seal = requireSecrets();
    const params = parseOrThrow(webhookParams, request.params, { what: 'The webhook id' });

    const webhook = await context.repos.webhooks.find(params.webhookId, caller.userId);
    if (!webhook) throw notFound('That webhook');

    await requireFreshPassword(request, caller, 'webhook.rotate-secret', 'Replacing a webhook’s signing secret');

    const salt = seal.newSalt();
    await context.repos.webhooks.rotateSalt(webhook.id, caller.userId, salt);
    await context.repos.audit.record({
      category: 'configuration',
      action: 'webhook.rotate-secret',
      outcome: 'success',
      riskLevel: 'high',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'webhook', webhookId: webhook.id, host: webhook.host },
    });

    return reply.header('cache-control', 'no-store').send({ secret: seal.signingSecret(webhook.id, salt) });
  });

  /** Send a test delivery now and say how it went. Checked exactly like a real one. */
  app.post('/webhooks/:webhookId/test', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const seal = requireSecrets();
    const params = parseOrThrow(webhookParams, request.params, { what: 'The webhook id' });

    const limit = context.rateLimiter.consume(
      `webhook-test:${caller.userId}`,
      TEST_LIMIT.limit,
      TEST_LIMIT.windowSeconds,
      context.now().getTime(),
    );
    if (!limit.allowed) throw tooManyRequests(limit.retryAfterSeconds, 'Too many test deliveries.');

    const webhook = await context.repos.webhooks.find(params.webhookId, caller.userId);
    if (!webhook) throw notFound('That webhook');

    const now = context.now();
    const body: WebhookBody = {
      type: 'wolf.test',
      version: 1,
      id: newId(),
      occurredAt: now.toISOString(),
      notification: {
        kind: 'webhook',
        severity: 'info',
        title: 'A test from WOLF',
        detail: `Sent from WOLF to check the webhook “${webhook.name}” works.`,
        pc: null,
      },
    };

    const result = await sender.deliver({
      url: seal.decryptUrl(webhook.id, webhook.urlSealed),
      secret: seal.signingSecret(webhook.id, webhook.secretSalt),
      body: JSON.stringify(body),
      deliveryId: `${body.id}.${webhook.id}`,
      now,
    });

    await context.repos.audit.record({
      category: 'configuration',
      action: 'webhook.test',
      outcome: result.outcome === 'delivered' ? 'success' : 'failure',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'webhook', webhookId: webhook.id, host: webhook.host },
      errorCode: result.outcome === 'delivered' ? null : result.outcome,
    });

    return reply.send(result);
  });

  app.delete('/webhooks/:webhookId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(webhookParams, request.params, { what: 'The webhook id' });

    const webhook = await context.repos.webhooks.find(params.webhookId, caller.userId);
    if (!webhook || !(await context.repos.webhooks.delete(webhook.id, caller.userId))) throw notFound('That webhook');

    await context.repos.audit.record({
      category: 'configuration',
      action: 'webhook.delete',
      outcome: 'success',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'webhook', webhookId: webhook.id, host: webhook.host },
    });

    return reply.status(204).send();
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_ALERT_RULES,
  alertRuleInput,
  alertRulePatch,
  type AlertRule,
} from '@wolf/protocol';
import { withTransaction, type RuleWrite, type StoredRule } from '@wolf/server-core';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';
import { conflict, notFound } from '../http/errors.js';

/**
 * Alert rules and the in-app notification inbox.
 *
 * Rule changes are audited: a rule is a standing instruction about what the owner will and will
 * not be told, and quietly disabling one is exactly the kind of change somebody should be able
 * to find afterwards. Marking a notification read is not — it changes nothing about any PC and
 * nothing about what WOLF will do next.
 */

const ruleParams = z.object({ ruleId: z.string().length(26) });
const notificationParams = z.object({ notificationId: z.string().length(26) });

const inboxQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function publicRule(rule: StoredRule): AlertRule {
  return {
    id: rule.id,
    pcId: rule.pcId,
    name: rule.name,
    condition: rule.condition,
    metric: rule.metric,
    seriesKey: rule.seriesKey,
    threshold: rule.threshold,
    forMinutes: rule.forMinutes,
    severity: rule.severity,
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** What an audit record says about a rule. The definition, which holds nothing secret. */
function auditView(rule: RuleWrite): Record<string, unknown> {
  return {
    name: rule.name,
    pcId: rule.pcId,
    condition: rule.condition,
    metric: rule.metric,
    seriesKey: rule.seriesKey,
    threshold: rule.threshold,
    forMinutes: rule.forMinutes,
    severity: rule.severity,
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
  };
}

export async function registerAlertRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /** A rule may target only a PC its owner owns. Otherwise it is a probe for other accounts' ids. */
  async function assertOwnsPc(pcId: string | null, userId: string): Promise<void> {
    if (pcId === null) return;
    const pc = await context.repos.pcs.findById(pcId, userId);
    if (!pc || pc.registrationState === 'revoked') throw notFound('That PC');
  }

  app.get('/alert-rules', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const rules = await context.repos.alerts.listRules(caller.userId);
    return reply.send({ rules: rules.map(publicRule), limit: MAX_ALERT_RULES });
  });

  app.post('/alert-rules', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const body = parseOrThrow(alertRuleInput, request.body, { what: 'The alert rule' });
    await assertOwnsPc(body.pcId, caller.userId);

    const rule = await withTransaction(context.db, async (client) => {
      // Counted inside the transaction that inserts, so two requests at once cannot both be the
      // hundredth.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      if ((await context.repos.alerts.countRules(caller.userId, client)) >= MAX_ALERT_RULES) {
        throw conflict(
          'This account already has the maximum number of alert rules.',
          `An account can hold at most ${MAX_ALERT_RULES} alert rules.`,
          'Delete or combine rules you no longer need — a rule with no PC selected covers every PC.',
        );
      }

      const created = await context.repos.alerts.createRule(caller.userId, body, client);

      await context.repos.audit.record(
        {
          category: 'automation',
          action: 'alert-rule.create',
          outcome: 'success',
          riskLevel: 'low',
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: created.pcId,
          requestId: request.id,
          target: { ruleId: created.id },
          afterValue: auditView(created),
        },
        client,
      );

      return created;
    });

    return reply.status(201).send({ rule: publicRule(rule) });
  });

  app.patch('/alert-rules/:ruleId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(ruleParams, request.params, { what: 'The rule id' });
    const patch = parseOrThrow(alertRulePatch, request.body, { what: 'The rule update' });

    const existing = await context.repos.alerts.findRule(params.ruleId, caller.userId);
    if (!existing) throw notFound('That alert rule');

    // Coherence is a property of the whole rule, so it is checked on the merged result: turning a
    // metric rule into an offline rule is a single field, and the reverse needs a metric and a
    // threshold that may already be there.
    const merged = parseOrThrow(
      alertRuleInput,
      {
        ...auditView(existing),
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      },
      { what: 'The rule update' },
    );
    if (merged.pcId !== existing.pcId) await assertOwnsPc(merged.pcId, caller.userId);

    const updated = await withTransaction(context.db, async (client) => {
      const rule = await context.repos.alerts.updateRule(existing.id, caller.userId, merged, client);
      if (!rule) throw notFound('That alert rule');

      await context.repos.audit.record(
        {
          category: 'automation',
          action: 'alert-rule.update',
          outcome: 'success',
          riskLevel: 'low',
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: rule.pcId,
          requestId: request.id,
          target: { ruleId: rule.id },
          beforeValue: auditView(existing),
          afterValue: auditView(rule),
        },
        client,
      );

      return rule;
    });

    return reply.send({ rule: publicRule(updated) });
  });

  app.delete('/alert-rules/:ruleId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(ruleParams, request.params, { what: 'The rule id' });

    const existing = await context.repos.alerts.findRule(params.ruleId, caller.userId);
    if (!existing) throw notFound('That alert rule');

    await withTransaction(context.db, async (client) => {
      if (!(await context.repos.alerts.deleteRule(existing.id, caller.userId, client))) {
        throw notFound('That alert rule');
      }

      await context.repos.audit.record(
        {
          category: 'automation',
          action: 'alert-rule.delete',
          outcome: 'success',
          riskLevel: 'low',
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: existing.pcId,
          requestId: request.id,
          target: { ruleId: existing.id },
          beforeValue: auditView(existing),
        },
        client,
      );
    });

    return reply.status(204).send();
  });

  app.get('/notifications', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const query = parseOrThrow(inboxQuery, request.query, { what: 'The inbox query' });

    const [notifications, unreadCount] = await Promise.all([
      context.repos.alerts.listNotifications(caller.userId, {
        unreadOnly: query.unread === 'true',
        limit: query.limit,
      }),
      context.repos.alerts.unreadCount(caller.userId),
    ]);

    return reply.send({ notifications, unreadCount });
  });

  app.post(
    '/notifications/:notificationId/read',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(notificationParams, request.params, { what: 'The notification id' });

      if (!(await context.repos.alerts.markRead(params.notificationId, caller.userId, context.now()))) {
        throw notFound('That notification');
      }

      return reply.status(204).send();
    },
  );

  app.post('/notifications/read-all', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const marked = await context.repos.alerts.markAllRead(caller.userId, context.now());
    return reply.send({ marked });
  });
}

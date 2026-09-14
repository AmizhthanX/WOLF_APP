import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_AUTOMATIONS,
  automationInput,
  automationPatch,
  saveAutomationBody,
  type Automation,
  type AutomationInput,
} from '@wolf/protocol';
import { policyFor, type RiskLevel } from '@wolf/shared-types';
import {
  authorizeSave,
  withTransaction,
  type AutomationAuthority,
  type StoredAutomation,
} from '@wolf/server-core';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth, type RequestAuth } from '../http/auth.js';
import { confirmationRequired, conflict, forbidden, notFound, reauthenticationRequired } from '../http/errors.js';
import { AutomationExecutor } from '../automation/executor.js';

/**
 * Automations: define, authorize, run, and see what happened.
 *
 * Saving an automation is where its authority comes from, so saving is treated like sending the
 * most dangerous command in it: the confirmed risk level must equal the server's classification,
 * and a high-risk automation needs a freshly entered password. A change that cannot widen what the
 * automation does — renaming it, turning it off — needs neither. Everything else re-authorizes, and
 * the authority is re-recorded against the device making the change.
 */

const automationParams = z.object({ automationId: z.string().length(26) });
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

function publicAutomation(automation: StoredAutomation): Automation {
  return {
    id: automation.id,
    ...definitionOf(automation),
    authorizedRiskLevel: automation.authorizedRisk,
    authorizedAt: automation.authorizedAt.toISOString(),
    lastRunAt: automation.lastRunAt?.toISOString() ?? null,
    createdAt: automation.createdAt.toISOString(),
    updatedAt: automation.updatedAt.toISOString(),
  };
}

function definitionOf(automation: StoredAutomation): AutomationInput {
  return {
    name: automation.name,
    enabled: automation.enabled,
    trigger: automation.trigger,
    conditions: [...automation.conditions],
    actions: [...automation.actions],
    targets: automation.targets,
    cooldownMinutes: automation.cooldownMinutes,
    maxRunsPerDay: automation.maxRunsPerDay,
  };
}

/**
 * What an audit record says about an automation: its shape, not its content. Command types and
 * target counts; not the owner's notification text.
 */
function auditView(input: AutomationInput): Record<string, unknown> {
  return {
    name: input.name,
    enabled: input.enabled,
    trigger: input.trigger.kind,
    conditions: input.conditions.map((condition) => condition.kind),
    actions: input.actions.map((action) => (action.kind === 'command' ? action.command.type : 'notify')),
    targets: input.targets.mode === 'pcs' ? input.targets.pcIds : 'alert-pc',
    cooldownMinutes: input.cooldownMinutes,
    maxRunsPerDay: input.maxRunsPerDay,
  };
}

/** JSON with sorted keys. Stored JSONB does not keep key order, so a plain stringify would lie. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Whether a change could make the automation do more, or do it more often, than it was authorized for. */
function needsAuthority(existing: AutomationInput, next: AutomationInput): boolean {
  const scope = (input: AutomationInput) =>
    canonical({
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      targets: input.targets,
      cooldownMinutes: input.cooldownMinutes,
      maxRunsPerDay: input.maxRunsPerDay,
    });

  return scope(existing) !== scope(next) || (next.enabled && !existing.enabled);
}

export async function registerAutomationRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const executor = new AutomationExecutor(context);
  // Manual runs started by this app finish before it closes.
  app.addHook('onClose', async () => {
    await executor.drain();
  });

  async function assertOwnsReferences(input: AutomationInput, userId: string): Promise<void> {
    if (input.targets.mode === 'pcs') {
      for (const pcId of input.targets.pcIds) {
        const pc = await context.repos.pcs.findById(pcId, userId);
        if (!pc || pc.registrationState === 'revoked') throw notFound('A PC in this automation');
      }
    }

    if (input.trigger.kind === 'alert' && input.trigger.ruleId !== null) {
      const rule = await context.repos.alerts.findRule(input.trigger.ruleId, userId);
      if (!rule) throw notFound('That alert rule');
    }
  }

  async function authorize(
    request: FastifyRequest,
    caller: RequestAuth,
    input: AutomationInput,
    confirmedRiskLevel: RiskLevel | undefined,
  ): Promise<AutomationAuthority> {
    const now = context.now();
    const verdict = authorizeSave({
      actions: input.actions,
      confirmedRiskLevel,
      authTimeSeconds: caller.claims.auth_time,
      now,
    });

    if (verdict.ok) {
      return { risk: verdict.risk, deviceId: caller.deviceId, at: now };
    }

    await context.repos.audit.record({
      category: 'automation',
      action: 'automation.authorize',
      outcome: 'denied',
      riskLevel: verdict.risk,
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'automation', name: input.name },
      errorCode: verdict.problem,
    });

    switch (verdict.problem) {
      case 'critical':
        throw forbidden(
          'This automation includes a critical action, which can never be automated.',
          'Remove the critical action. Critical actions need a single-use privileged grant each time they run.',
        );
      case 'confirmation':
        throw confirmationRequired('Saving this automation', verdict.risk);
      case 'reauthentication':
        throw reauthenticationRequired('Saving this automation', policyFor(verdict.risk).reauthMaxAgeSeconds);
    }
  }

  app.get('/automations', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const automations = await context.repos.automations.listForUser(caller.userId);
    return reply.send({ automations: automations.map(publicAutomation), limit: MAX_AUTOMATIONS });
  });

  app.post('/automations', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const body = parseOrThrow(saveAutomationBody, request.body, { what: 'The automation' });
    const input = parseOrThrow(automationInput, body.automation, { what: 'The automation' });

    await assertOwnsReferences(input, caller.userId);
    const authority = await authorize(request, caller, input, body.confirmedRiskLevel);

    const created = await withTransaction(context.db, async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      if ((await context.repos.automations.countForUser(caller.userId, client)) >= MAX_AUTOMATIONS) {
        throw conflict(
          'This account already has the maximum number of automations.',
          `An account can hold at most ${MAX_AUTOMATIONS} automations.`,
          'Delete automations you no longer need.',
        );
      }

      const automation = await context.repos.automations.create(caller.userId, input, authority, client);

      await context.repos.audit.record(
        {
          category: 'automation',
          action: 'automation.create',
          outcome: 'success',
          riskLevel: authority.risk,
          userId: caller.userId,
          deviceId: caller.deviceId,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          target: { kind: 'automation', automationId: automation.id },
          afterValue: auditView(input),
        },
        client,
      );

      return automation;
    });

    return reply.status(201).send({ automation: publicAutomation(created) });
  });

  app.patch('/automations/:automationId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(automationParams, request.params, { what: 'The automation id' });
    const body = parseOrThrow(saveAutomationBody, request.body, { what: 'The automation update' });
    const patch = parseOrThrow(automationPatch, body.automation, { what: 'The automation update' });

    const existing = await context.repos.automations.findById(params.automationId, caller.userId);
    if (!existing) throw notFound('That automation');

    const before = definitionOf(existing);
    const next = parseOrThrow(
      automationInput,
      { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) },
      { what: 'The automation update' },
    );

    await assertOwnsReferences(next, caller.userId);
    const authority = needsAuthority(before, next) ? await authorize(request, caller, next, body.confirmedRiskLevel) : null;

    const updated = await withTransaction(context.db, async (client) => {
      const automation = await context.repos.automations.update(existing.id, caller.userId, next, authority, client);
      if (!automation) throw notFound('That automation');

      await context.repos.audit.record(
        {
          category: 'automation',
          action: authority ? 'automation.update' : next.enabled ? 'automation.rename' : 'automation.disable',
          outcome: 'success',
          riskLevel: automation.authorizedRisk,
          userId: caller.userId,
          deviceId: caller.deviceId,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          target: { kind: 'automation', automationId: automation.id, reauthorized: authority !== null },
          beforeValue: auditView(before),
          afterValue: auditView(next),
        },
        client,
      );

      return automation;
    });

    return reply.send({ automation: publicAutomation(updated) });
  });

  app.delete('/automations/:automationId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(automationParams, request.params, { what: 'The automation id' });

    const existing = await context.repos.automations.findById(params.automationId, caller.userId);
    if (!existing) throw notFound('That automation');

    await withTransaction(context.db, async (client) => {
      if (!(await context.repos.automations.delete(existing.id, caller.userId, client))) {
        throw notFound('That automation');
      }

      await context.repos.audit.record(
        {
          category: 'automation',
          action: 'automation.delete',
          outcome: 'success',
          riskLevel: 'low',
          userId: caller.userId,
          deviceId: caller.deviceId,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          target: { kind: 'automation', automationId: existing.id },
          beforeValue: auditView(definitionOf(existing)),
        },
        client,
      );
    });

    return reply.status(204).send();
  });

  /**
   * Run an automation now, on its listed PCs.
   *
   * On the authority it was saved with — the same as a scheduled run — so it needs no confirmation
   * here, and cannot do anything a scheduled run could not. Pressed by a person, so it skips the
   * cooldown; it still counts towards the day's limit.
   */
  app.post('/automations/:automationId/run', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(automationParams, request.params, { what: 'The automation id' });

    const automation = await context.repos.automations.findById(params.automationId, caller.userId);
    if (!automation) throw notFound('That automation');

    if (!automation.enabled) {
      throw conflict('That automation is turned off.', 'A turned-off automation does not run.', 'Turn it on first.');
    }

    if (automation.targets.mode !== 'pcs') {
      throw conflict(
        'That automation acts on the PC an alert fired for.',
        'Without an alert there is no PC to run it on.',
        'Change its targets to specific PCs to run it by hand.',
      );
    }

    await context.repos.audit.record({
      category: 'automation',
      action: 'automation.run-requested',
      outcome: 'success',
      riskLevel: automation.authorizedRisk,
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'automation', automationId: automation.id },
    });

    executor.start(automation, automation.targets.pcIds, 'manual', { ignoreCooldown: true });
    return reply.status(202).send({ accepted: true, pcIds: automation.targets.pcIds });
  });

  app.get('/automations/:automationId/runs', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(automationParams, request.params, { what: 'The automation id' });
    const query = parseOrThrow(runsQuery, request.query ?? {}, { what: 'The query' });

    const automation = await context.repos.automations.findById(params.automationId, caller.userId);
    if (!automation) throw notFound('That automation');

    return reply.send({ runs: await context.repos.automations.listRuns(automation.id, caller.userId, query.limit) });
  });
}

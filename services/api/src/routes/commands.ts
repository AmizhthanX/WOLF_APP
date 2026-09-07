import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTerminalStatus } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';
import { idempotencyKey, parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth, requirePcScope } from '../http/auth.js';
import { CommandService } from '../services/command-service.js';
import { RATE_LIMITS } from '../http/rate-limit.js';
import { forbidden, notFound, tooManyRequests, unauthorized } from '../http/errors.js';
import type { CommandRecord } from '@wolf/server-core';

const pcParams = z.object({ pcId: z.string().length(26) });

const dispatchBody = z.object({
  command: z.object({ type: z.string().max(64) }).passthrough(),
  idempotencyKey: idempotencyKey.optional(),
  /** Risk level shown to the operator when they confirmed. Must match the server's. */
  confirmedRiskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  privilegedGrantId: z.string().length(26).optional(),
  /**
   * Seconds to wait for a result before returning. Zero returns as soon as the command is
   * queued; the client then follows the command by id or over the realtime channel.
   */
  waitSeconds: z.number().int().min(0).max(30).default(0),
});

const grantBody = z.object({
  purpose: z.string().min(3).max(120),
  expiresInSeconds: z.number().int().min(30).max(600).default(120),
});

function serialize(command: CommandRecord) {
  return {
    id: command.id,
    pcId: command.pcId,
    sessionId: command.sessionId,
    type: command.type,
    riskLevel: command.riskLevel,
    status: command.status,
    createdAt: command.createdAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
    startedAt: command.startedAt?.toISOString() ?? null,
    completedAt: command.completedAt?.toISOString() ?? null,
    failure: command.errorCode
      ? {
          code: command.errorCode,
          message: command.errorMessage,
          limitation: command.errorIsLimitation,
        }
      : null,
    result: command.result,
  };
}

export async function registerCommandRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const commands = new CommandService(context);

  /**
   * Dispatch a typed command to a PC.
   *
   * One endpoint carries every command type because the payload is a discriminated union
   * validated against the shared protocol package. Adding a per-action HTTP endpoint for
   * each would duplicate the risk classification that lives in exactly one place today.
   */
  app.post('/pcs/:pcId/commands', { preHandler: app.authenticate }, async (request, reply) => {
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const caller = requirePcScope(request, params.pcId);
    const body = parseOrThrow(dispatchBody, request.body, { area: 'CMD', what: 'The command' });

    const limit = context.rateLimiter.consume(
      `command:${caller.userId}:${params.pcId}`,
      RATE_LIMITS.command.limit,
      RATE_LIMITS.command.windowSeconds,
      context.now().getTime(),
    );
    if (!limit.allowed) {
      throw tooManyRequests(limit.retryAfterSeconds, 'Too many commands for this PC.');
    }

    const headerKey = request.headers['x-wolf-idempotency-key'];
    const key =
      body.idempotencyKey ??
      (typeof headerKey === 'string' ? headerKey : undefined) ??
      newId();

    const outcome = await commands.dispatch({
      auth: caller,
      pcId: params.pcId,
      command: body.command,
      idempotencyKey: key,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      confirmedRiskLevel: body.confirmedRiskLevel,
      privilegedGrantId: body.privilegedGrantId,
    });

    const settled =
      body.waitSeconds > 0
        ? await waitForCommand(context, outcome.command, body.waitSeconds)
        : outcome.command;

    return reply.status(outcome.created ? 202 : 200).send({
      command: serialize(settled),
      deduplicated: !outcome.created,
    });
  });

  app.get('/pcs/:pcId/commands', { preHandler: app.authenticate }, async (request, reply) => {
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const caller = requireAuth(request);

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const query = parseOrThrow(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      request.query ?? {},
      { what: 'The query' },
    );

    const records = await context.repos.commands.listForPc(params.pcId, query.limit);
    return reply.send({ commands: records.map(serialize) });
  });

  app.get(
    '/pcs/:pcId/commands/:commandId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = parseOrThrow(
        pcParams.extend({ commandId: z.string().length(26) }),
        request.params,
        { what: 'The command id' },
      );
      const caller = requireAuth(request);

      const command = await context.repos.commands.findById(params.commandId);
      if (!command || command.pcId !== params.pcId || command.userId !== caller.userId) {
        throw notFound('That command');
      }
      return reply.send({ command: serialize(command) });
    },
  );

  /**
   * Request a privileged grant for a critical action.
   *
   * Requires a password re-entry within the critical window, is scoped to one PC and one
   * session, expires in minutes, and is consumed by the single command it authorizes.
   */
  app.post(
    '/pcs/:pcId/privileged-grants',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
      const caller = requirePcScope(request, params.pcId);
      const body = parseOrThrow(grantBody, request.body, { what: 'The grant request' });

      const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
      if (!pc) throw notFound('That PC');

      const now = context.now();
      const authAge = Math.floor(now.getTime() / 1000) - caller.claims.auth_time;
      if (authAge > 120) {
        throw unauthorized(
          'A privileged grant requires a password re-entry within the last 120 seconds.',
        );
      }
      if (!caller.sessionId) {
        throw forbidden(
          'A privileged grant must be requested from an active PC session.',
          'Open a session for this PC and retry.',
        );
      }

      const id = newId();
      const expiresAt = new Date(now.getTime() + body.expiresInSeconds * 1000);
      await context.db.query(
        `INSERT INTO privileged_grants
           (id, user_id, device_id, pc_id, session_id, purpose, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, caller.userId, caller.deviceId, params.pcId, caller.sessionId, body.purpose, expiresAt],
      );

      await context.repos.audit.record({
        category: 'privilege',
        action: 'privilege.grant',
        outcome: 'success',
        riskLevel: 'critical',
        userId: caller.userId,
        deviceId: caller.deviceId,
        pcId: params.pcId,
        sessionId: caller.sessionId,
        requestId: request.id,
        sourceIp: request.ip ?? null,
        target: { kind: 'privileged-grant', purpose: body.purpose },
      });

      return reply.status(201).send({
        grant: { id, purpose: body.purpose, expiresAt: expiresAt.toISOString(), singleUse: true },
      });
    },
  );
}

/**
 * Poll for a command to reach a terminal state.
 *
 * Polling the durable row rather than holding an in-memory promise means the wait works
 * even when the result arrives at a different API instance than the one holding the
 * request, which is exactly what happens behind a Cloud Run load balancer.
 */
async function waitForCommand(
  context: AppContext,
  command: CommandRecord,
  waitSeconds: number,
): Promise<CommandRecord> {
  const deadline = context.now().getTime() + waitSeconds * 1000;
  let current = command;

  while (!isTerminalStatus(current.status) && context.now().getTime() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const refreshed = await context.repos.commands.findById(command.id);
    if (!refreshed) break;
    current = refreshed;
  }

  return current;
}

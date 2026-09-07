import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES } from '@wolf/shared-types';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';
import { notFound } from '../http/errors.js';

const auditQuery = z.object({
  pcId: z.string().length(26).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().length(26).optional(),
});

export async function registerAuditRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.get('/audit', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const query = parseOrThrow(auditQuery, request.query ?? {}, { what: 'The audit query' });

    const events = await context.repos.audit.query({
      userId: caller.userId,
      pcId: query.pcId,
      category: query.category,
      outcome: query.outcome,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      before: query.before,
    });

    return reply.send({
      events,
      // Cursor for the next page; audit ids sort by time, so this is stable under writes.
      nextCursor: events.length === query.limit ? events[events.length - 1]?.id : null,
    });
  });

  app.get('/pcs/:pcId/audit', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(z.object({ pcId: z.string().length(26) }), request.params, {
      what: 'The PC id',
    });
    const query = parseOrThrow(auditQuery.omit({ pcId: true }), request.query ?? {}, {
      what: 'The audit query',
    });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const events = await context.repos.audit.query({
      userId: caller.userId,
      pcId: params.pcId,
      category: query.category,
      outcome: query.outcome,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      before: query.before,
    });

    return reply.send({
      events,
      nextCursor: events.length === query.limit ? events[events.length - 1]?.id : null,
    });
  });
}

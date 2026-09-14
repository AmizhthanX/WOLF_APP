import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CONFIGURATION_FORMAT,
  CONFIGURATION_VERSION,
  riskRank,
  restoreRequest,
  type ConfigurationContent,
} from '@wolf/protocol';
import { policyFor, WolfError } from '@wolf/shared-types';
import {
  RestoreConflictError,
  authorizeRestore,
  configurationChecksum,
  planRestore,
  verifyBackup,
  withTransaction,
} from '@wolf/server-core';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth, type RequestAuth } from '../http/auth.js';
import { confirmationRequired, conflict, reauthenticationRequired } from '../http/errors.js';

/**
 * Configuration backup and restore.
 *
 * A backup is built on request and returned to the caller; the cloud keeps no copy. A restore
 * replaces the chosen sections in one transaction, after the same confirmation a command of that
 * risk needs. See `packages/protocol/src/configuration.ts` for what is and is never in a backup.
 */

/** A restore body holds a whole backup, which can be larger than the API's default limit. */
const RESTORE_BODY_LIMIT = 4 * 1024 * 1024;

function invalidBackup(problem: string, cause: string): WolfError {
  return new WolfError({
    code: 'configuration.invalid_backup',
    problem,
    cause,
    currentState: 'Nothing was changed.',
    recommendedAction: 'Choose a backup file downloaded from WOLF, unchanged.',
    area: 'API',
    httpStatus: 422,
  });
}

function verified(file: unknown): ConfigurationContent {
  const verdict = verifyBackup(file);
  if (!verdict.ok) throw invalidBackup(verdict.problem, verdict.cause);
  return verdict.content;
}

export async function registerConfigurationRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/configuration/backup', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const now = context.now();
    const content = await context.repos.configuration.snapshot(caller.userId);

    const backup = {
      format: CONFIGURATION_FORMAT,
      version: CONFIGURATION_VERSION,
      createdAt: now.toISOString(),
      checksum: configurationChecksum(content),
      content,
    };

    // Taking a copy of the configuration is not a change, but it is a complete map of the owner's
    // machines and what WOLF does to them. Recorded, with counts and never content.
    await context.repos.audit.record({
      category: 'configuration',
      action: 'configuration.backup',
      outcome: 'success',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: {
        kind: 'configuration',
        pcs: content['pcs']!.length,
        remoteDesktopProfiles: content['remoteDesktopProfiles']!.length,
        alertRules: content['alertRules']!.length,
        automations: content['automations']!.length,
      },
    });

    return reply
      .header('content-disposition', `attachment; filename="wolf-configuration-${now.toISOString().slice(0, 10)}.json"`)
      .header('cache-control', 'no-store')
      .send(backup);
  });

  app.post(
    '/configuration/restore/preview',
    { preHandler: app.authenticate, bodyLimit: RESTORE_BODY_LIMIT },
    async (request, reply) => {
      const caller = requireAuth(request);
      const body = parseOrThrow(restoreRequest, request.body, { what: 'The restore request' });
      const content = verified(body.backup);

      const current = await context.repos.configuration.current(caller.userId);
      const work = planRestore(content, current, { sections: body.sections, enableAutomations: body.enableAutomations });

      return reply.send({ plan: work.plan });
    },
  );

  async function denied(request: FastifyRequest, caller: RequestAuth, riskLevel: 'medium' | 'high' | 'low' | 'critical', errorCode: string) {
    await context.repos.audit.record({
      category: 'configuration',
      action: 'configuration.restore',
      outcome: 'denied',
      riskLevel,
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      errorCode,
    });
  }

  app.post(
    '/configuration/restore',
    { preHandler: app.authenticate, bodyLimit: RESTORE_BODY_LIMIT },
    async (request, reply) => {
      const caller = requireAuth(request);
      const body = parseOrThrow(restoreRequest, request.body, { what: 'The restore request' });

      let content: ConfigurationContent;
      try {
        content = verified(body.backup);
      } catch (error) {
        await denied(request, caller, 'medium', 'invalid-backup');
        throw error;
      }

      const now = context.now();
      const options = { sections: body.sections, enableAutomations: body.enableAutomations };

      // Authorized against the plan as it stands now, outside the transaction so a refusal can be
      // audited. The plan is recomputed inside; if the account changed in between so that the restore
      // would need more than was confirmed, it stops rather than proceeding on a stale confirmation.
      const preview = planRestore(content, await context.repos.configuration.current(caller.userId), options);
      const authorization = authorizeRestore({
        riskLevel: preview.plan.riskLevel,
        confirmedRiskLevel: body.confirmedRiskLevel,
        authTimeSeconds: caller.claims.auth_time,
        now,
      });

      if (!authorization.ok) {
        await denied(request, caller, preview.plan.riskLevel, authorization.problem);
        throw authorization.problem === 'confirmation'
          ? confirmationRequired('Restoring configuration', preview.plan.riskLevel)
          : reauthenticationRequired('Restoring configuration', policyFor(preview.plan.riskLevel).reauthMaxAgeSeconds);
      }

      const sections = new Set(body.sections);

      try {
        const work = await withTransaction(context.db, async (client) => {
          await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);

          const inside = planRestore(content, await context.repos.configuration.current(caller.userId, client), options);
          if (riskRank(inside.plan.riskLevel) > riskRank(preview.plan.riskLevel)) {
            throw conflict(
              'The account changed while restoring.',
              'What the restore would do changed after it was confirmed.',
              'Review the restore again and confirm it.',
            );
          }

          await context.repos.configuration.apply(client, caller.userId, inside, sections, {
            deviceId: caller.deviceId,
            at: now,
          });

          await context.repos.audit.record(
            {
              category: 'configuration',
              action: 'configuration.restore',
              outcome: 'success',
              riskLevel: inside.plan.riskLevel,
              userId: caller.userId,
              deviceId: caller.deviceId,
              requestId: request.id,
              sourceIp: request.ip ?? null,
              target: { kind: 'configuration', sections: body.sections.join(','), automationsEnabled: inside.plan.automationsEnabled },
              // Counts and warning codes. Never names, rules or actions from the file.
              afterValue: {
                sections: inside.plan.sections,
                warnings: inside.plan.warnings.map((warning) => warning.code),
              },
            },
            client,
          );

          return inside;
        });

        return reply.send({ plan: work.plan, restoredAt: now.toISOString() });
      } catch (error) {
        if (error instanceof RestoreConflictError) {
          throw conflict(
            'The backup refers to configuration that belongs to another account.',
            error.message,
            'Restore a backup made from this account.',
          );
        }
        throw error;
      }
    },
  );
}

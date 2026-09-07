import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueAccessToken } from '@wolf/auth';
import {
  SESSION_CAPABILITIES,
  newId,
  type SessionCapability,
} from '@wolf/shared-types';
import { displayName, parseOrThrow, tag } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';
import { withTransaction } from '@wolf/server-core';
import { RATE_LIMITS } from '../http/rate-limit.js';
import {
  conflict,
  forbidden,
  killSwitchEngaged,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../http/errors.js';
import { generateEnrollmentToken, hashEnrollmentToken } from '@wolf/server-core';

const pcParams = z.object({ pcId: z.string().length(26) });

const patchPcBody = z.object({
  name: displayName.optional(),
  favorite: z.boolean().optional(),
  tags: z.array(tag).max(20).optional(),
});

const createSessionBody = z.object({
  mode: z.enum(['view-only', 'control']).default('control'),
  /**
   * Capabilities are requested explicitly and granted individually. A session that only
   * needs to read the process list must not be handed input, files, or a terminal.
   */
  capabilities: z.array(z.enum(SESSION_CAPABILITIES)).min(1).max(SESSION_CAPABILITIES.length),
});

const killSwitchBody = z.object({
  remoteAccessEnabled: z.literal(false),
  reason: z.string().max(200).optional(),
});

const createEnrollmentTokenBody = z.object({
  label: displayName.optional(),
  expiresInMinutes: z.number().int().min(5).max(1440).default(60),
});

const enrollBody = z.object({
  enrollmentToken: z.string().min(8).max(64),
  name: displayName,
  hostname: z.string().max(255).nullable().optional(),
  agentVersion: z.string().max(64),
  /** Ed25519 SPKI, base64url. Generated on the PC; the private key never leaves it. */
  publicKey: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
});

/** Capabilities a view-only session may hold. */
const VIEW_ONLY_CAPABILITIES: readonly SessionCapability[] = [
  'screen',
  'audio',
  'processes',
  'services',
];

export async function registerPcRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/pcs', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const pcs = await context.repos.pcs.listForUser(caller.userId);

    const summaries = await Promise.all(
      pcs.map(async (pc) => ({
        ...pc,
        capabilities: await context.repos.pcs.getCapabilities(pc.id),
        hardware: await context.repos.pcs.getHardware(pc.id),
        activeSessionCount: await context.repos.sessions.countActiveForPc(pc.id),
        pendingCommandCount: await context.repos.commands.countPending(pc.id),
      })),
    );

    return reply.send({ pcs: summaries });
  });

  app.get('/pcs/:pcId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const [capabilities, hardware, sessions, latestSample] = await Promise.all([
      context.repos.pcs.getCapabilities(pc.id),
      context.repos.pcs.getHardware(pc.id),
      context.repos.sessions.listActiveForPc(pc.id),
      context.repos.telemetry.latestSample(pc.id),
    ]);

    return reply.send({
      pc: {
        ...pc,
        capabilities,
        hardware,
        activeSessionCount: sessions.length,
        pendingCommandCount: await context.repos.commands.countPending(pc.id),
      },
      sessions,
      latestTelemetry: latestSample?.sample ?? null,
    });
  });

  app.patch('/pcs/:pcId', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const body = parseOrThrow(patchPcBody, request.body, { what: 'The PC update' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    if (body.name && body.name !== pc.name) {
      const renamed = await context.repos.pcs.rename(pc.id, caller.userId, body.name);
      if (!renamed) {
        throw conflict(
          'That name is already in use.',
          'Another PC on this account already has this name.',
          'Choose a different name.',
        );
      }
      await context.repos.audit.record({
        category: 'pc',
        action: 'pc.rename',
        outcome: 'success',
        riskLevel: 'low',
        userId: caller.userId,
        deviceId: caller.deviceId,
        pcId: pc.id,
        requestId: request.id,
        beforeValue: { name: pc.name },
        afterValue: { name: body.name },
      });
    }

    if (body.favorite !== undefined) {
      await context.db.query('UPDATE pcs SET favorite = $2 WHERE id = $1', [pc.id, body.favorite]);
    }
    if (body.tags) {
      await context.db.query('UPDATE pcs SET tags = $2 WHERE id = $1', [pc.id, body.tags]);
    }

    return reply.send({ pc: await context.repos.pcs.findById(pc.id, caller.userId) });
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Open a session against a PC and receive a session-scoped access token.
   *
   * The returned token carries the granted capabilities, the session id, and the PC id, so
   * every later command is bound to this exact session rather than to the account at large.
   */
  app.post('/pcs/:pcId/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const body = parseOrThrow(createSessionBody, request.body, { what: 'The session request' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');
    if (!pc.remoteAccessEnabled) throw killSwitchEngaged(pc.name);

    if (body.mode === 'view-only') {
      const disallowed = body.capabilities.filter(
        (capability) => !VIEW_ONLY_CAPABILITIES.includes(capability),
      );
      if (disallowed.length > 0) {
        throw forbidden(
          `A view-only session cannot hold: ${disallowed.join(', ')}.`,
          'Request a control session, or drop those capabilities.',
        );
      }
    }

    // Privileged capabilities are never granted implicitly at session creation; they are
    // obtained per action through a privileged grant.
    if (body.capabilities.includes('privileged') || body.capabilities.includes('terminal-admin')) {
      throw forbidden(
        'Privileged and administrative-terminal capabilities cannot be granted at session start.',
        'Request a privileged grant for the specific action instead.',
      );
    }

    const now = context.now();
    const expiresAt = new Date(now.getTime() + context.config.sessionTtlSeconds * 1000);
    const sessionId = newId();

    const session = await withTransaction(context.db, async (client) => {
      const created = await context.repos.sessions.create(
        {
          id: sessionId,
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: pc.id,
          mode: body.mode,
          capabilities: body.capabilities,
          route: null,
          expiresAt,
        },
        client,
      );
      await context.repos.sessions.recordEvent(
        {
          id: newId(),
          sessionId,
          type: 'session.created',
          detail: { mode: body.mode, capabilities: body.capabilities },
        },
        client,
      );
      await context.repos.audit.record(
        {
          category: 'session',
          action: 'session.create',
          outcome: 'success',
          riskLevel: 'medium',
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: pc.id,
          sessionId,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          target: { kind: 'session', mode: body.mode },
          afterValue: { capabilities: body.capabilities },
        },
        client,
      );
      return created;
    });

    const token = issueAccessToken({
      signer: context.signer,
      issuer: context.config.tokens.issuer,
      audience: context.config.tokens.audience,
      subject: caller.userId,
      deviceId: caller.deviceId,
      authTime: caller.claims.auth_time,
      sessionId,
      pcId: pc.id,
      capabilities: body.capabilities,
      now: now.getTime(),
    });

    return reply.status(201).send({
      session,
      sessionToken: token.token,
      sessionTokenExpiresAt: token.expiresAt.toISOString(),
    });
  });

  /**
   * Re-issue the access token for an existing session.
   *
   * A session token carries the `auth_time` it was minted with, so after a password
   * re-entry the client needs a fresh one before a high-risk command will be accepted.
   * Re-issuing beats opening a new session: the session keeps its identity, its audit
   * trail, and any exclusive resource leases it already holds.
   */
  app.post(
    '/pcs/:pcId/sessions/:sessionId/token',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(
        pcParams.extend({ sessionId: z.string().length(26) }),
        request.params,
        { what: 'The session id' },
      );

      const session = await context.repos.sessions.findActive(
        params.sessionId,
        caller.userId,
        context.now(),
      );
      if (!session || session.pcId !== params.pcId) throw notFound('That session');

      // The token must belong to the device that opened the session; otherwise a second
      // device could borrow the first one's capabilities.
      if (session.deviceId !== caller.deviceId) {
        throw forbidden(
          'The session belongs to a different device.',
          'Open your own session for this PC.',
        );
      }

      const issued = issueAccessToken({
        signer: context.signer,
        issuer: context.config.tokens.issuer,
        audience: context.config.tokens.audience,
        subject: caller.userId,
        deviceId: caller.deviceId,
        // Carries the caller's current authentication age, which is the whole point.
        authTime: caller.claims.auth_time,
        sessionId: session.id,
        pcId: session.pcId,
        capabilities: session.capabilities,
        now: context.now().getTime(),
      });

      return reply.send({
        session,
        sessionToken: issued.token,
        sessionTokenExpiresAt: issued.expiresAt.toISOString(),
      });
    },
  );

  app.delete(
    '/pcs/:pcId/sessions/:sessionId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(
        pcParams.extend({ sessionId: z.string().length(26) }),
        request.params,
        { what: 'The session id' },
      );

      const session = await context.repos.sessions.findById(params.sessionId);
      if (!session || session.userId !== caller.userId || session.pcId !== params.pcId) {
        throw notFound('That session');
      }

      await context.repos.sessions.end(session.id, 'ended-by-operator');
      await context.repos.audit.record({
        category: 'session',
        action: 'session.end',
        outcome: 'success',
        riskLevel: 'low',
        userId: caller.userId,
        deviceId: caller.deviceId,
        pcId: params.pcId,
        sessionId: session.id,
        requestId: request.id,
      });

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Kill switch
  // -------------------------------------------------------------------------

  /**
   * Remote kill switch.
   *
   * This endpoint can only disable remote access. Re-enabling requires local
   * authentication in the WOLF Control Panel on the PC, so an attacker who reaches the
   * cloud cannot undo an operator's shutdown of remote access.
   */
  app.post('/pcs/:pcId/kill-switch', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const body = parseOrThrow(killSwitchBody, request.body, { what: 'The kill switch request' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    await withTransaction(context.db, async (client) => {
      await context.repos.pcs.setRemoteAccess(pc.id, caller.userId, body.remoteAccessEnabled, 'remote');
      await context.repos.sessions.endAllForPc(pc.id, 'kill-switch', client);
      await context.repos.audit.record(
        {
          category: 'kill-switch',
          action: 'pc.kill-switch.engage',
          outcome: 'success',
          riskLevel: 'critical',
          userId: caller.userId,
          deviceId: caller.deviceId,
          pcId: pc.id,
          requestId: request.id,
          sourceIp: request.ip ?? null,
          beforeValue: { remoteAccessEnabled: pc.remoteAccessEnabled },
          afterValue: { remoteAccessEnabled: false, reason: body.reason ?? null },
        },
        client,
      );
    });

    await context.repos.audit.recordSecurityEvent({
      type: 'kill-switch-engaged',
      userId: caller.userId,
      deviceId: caller.deviceId,
      pcId: pc.id,
      sourceIp: request.ip ?? null,
    });

    await context.db.query('SELECT pg_notify($1, $2)', [
      'wolf_kill_switch',
      JSON.stringify({ pcId: pc.id, remoteAccessEnabled: false }),
    ]);

    return reply.send({
      pc: await context.repos.pcs.findById(pc.id, caller.userId),
      note:
        'Remote access is now disabled. Re-enabling it requires signing in to the WOLF ' +
        'Control Panel on the PC itself.',
    });
  });

  // -------------------------------------------------------------------------
  // Enrollment
  // -------------------------------------------------------------------------

  app.post('/pcs/enrollment-tokens', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const body = parseOrThrow(createEnrollmentTokenBody, request.body ?? {}, {
      what: 'The enrollment token request',
    });

    const id = newId();
    const material = generateEnrollmentToken(id);
    const expiresAt = new Date(context.now().getTime() + body.expiresInMinutes * 60_000);

    const record = await context.repos.enrollment.create({
      id,
      userId: caller.userId,
      tokenHash: material.tokenHash,
      label: body.label ?? null,
      expiresAt,
    });

    await context.repos.audit.record({
      category: 'pc',
      action: 'pc.enrollment-token.create',
      outcome: 'success',
      riskLevel: 'high',
      userId: caller.userId,
      deviceId: caller.deviceId,
      requestId: request.id,
      sourceIp: request.ip ?? null,
      target: { kind: 'enrollment-token', id, label: body.label ?? null },
    });

    // The token is returned exactly once and is never stored in readable form.
    return reply.status(201).send({ enrollmentToken: material.token, token: record });
  });

  app.get('/pcs/enrollment-tokens', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    return reply.send({ tokens: await context.repos.enrollment.listOutstanding(caller.userId) });
  });

  app.delete(
    '/pcs/enrollment-tokens/:tokenId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(z.object({ tokenId: z.string().length(26) }), request.params, {
        what: 'The token id',
      });
      const revoked = await context.repos.enrollment.revoke(params.tokenId, caller.userId);
      if (!revoked) throw notFound('That enrollment token');
      return reply.status(204).send();
    },
  );

  /**
   * Agent enrollment.
   *
   * Called by the installer with a single-use token the owner generated in the dashboard.
   * The PC generates its own key pair and sends only the public half, so the cloud never
   * holds anything that could impersonate the machine.
   */
  app.post('/agents/enroll', async (request, reply) => {
    const sourceIp = request.ip ?? null;
    const limit = context.rateLimiter.consume(
      `enroll:${sourceIp}`,
      RATE_LIMITS.enrollment.limit,
      RATE_LIMITS.enrollment.windowSeconds,
      context.now().getTime(),
    );
    if (!limit.allowed) {
      throw tooManyRequests(limit.retryAfterSeconds, 'Too many enrollment attempts.');
    }

    const body = parseOrThrow(enrollBody, request.body, {
      area: 'AGENT',
      what: 'The enrollment request',
    });

    const tokenRecord = await context.repos.enrollment.findUnconsumedByHash(
      hashEnrollmentToken(body.enrollmentToken),
    );
    if (!tokenRecord) {
      await context.repos.audit.recordSecurityEvent({
        type: 'unauthorized-command',
        sourceIp,
        detail: { action: 'agent.enroll', reason: 'invalid-or-expired-token' },
      });
      throw unauthorized('The enrollment token is invalid, expired, or already used.');
    }

    const pcId = newId();
    const pc = await withTransaction(context.db, async (client) => {
      const created = await context.repos.pcs.create(
        {
          id: pcId,
          userId: tokenRecord.userId,
          name: body.name,
          hostname: body.hostname ?? null,
          publicKey: body.publicKey,
          agentVersion: body.agentVersion,
        },
        client,
      );
      const consumed = await context.repos.enrollment.consume(tokenRecord.id, pcId, client);
      if (!consumed) {
        // Another enrollment claimed the token first; roll back rather than create a
        // second PC from one token.
        throw conflict(
          'That enrollment token was already used.',
          'The token was consumed by another enrollment while this one was in flight.',
          'Generate a new enrollment token and try again.',
        );
      }
      await context.repos.audit.record(
        {
          category: 'pc',
          action: 'pc.enroll',
          outcome: 'success',
          riskLevel: 'high',
          userId: tokenRecord.userId,
          pcId,
          requestId: request.id,
          sourceIp,
          target: { kind: 'pc', name: body.name, hostname: body.hostname ?? null },
        },
        client,
      );
      return created;
    });

    return reply.status(201).send({
      pcId: pc.id,
      name: pc.name,
      // The agent uses these to open its authenticated link.
      link: {
        heartbeatSeconds: 30,
        telemetryUploadSeconds: 15,
      },
    });
  });
}

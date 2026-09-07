import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUILT_IN_PROFILES, remoteDesktopProfile } from '@wolf/protocol';
import { buildIceConfiguration } from '@wolf/server-core';
import { newId } from '@wolf/shared-types';
import { displayName, parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth, requireCapability, requirePcScope } from '../http/auth.js';
import { conflict, notFound } from '../http/errors.js';

const pcParams = z.object({ pcId: z.string().length(26) });
const profileParams = z.object({ profileId: z.string().length(26) });

const profileBody = z.object({
  name: displayName,
  settings: remoteDesktopProfile,
  isDefault: z.boolean().default(false),
});

export async function registerRemoteDesktopRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  /**
   * ICE servers for a stream.
   *
   * Requires the `screen` capability, so ICE credentials are only ever minted for a session
   * that is actually authorized to view the PC — they are not a general-purpose relay
   * credential handed to anyone who is signed in.
   */
  app.get('/pcs/:pcId/ice-servers', { preHandler: app.authenticate }, async (request, reply) => {
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const caller = requireCapability(request, 'screen');
    requirePcScope(request, params.pcId);

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const now = context.now();
    const { ice } = context.config;

    // The same builder the realtime service uses when it hands ICE servers to the agent, so
    // both ends of one connection are pointed at the same relay.
    const configuration = buildIceConfiguration(ice, caller.userId, now);

    await context.repos.audit.record({
      category: 'session',
      action: 'remote-desktop.ice-servers',
      outcome: 'success',
      riskLevel: 'low',
      userId: caller.userId,
      deviceId: caller.deviceId,
      pcId: params.pcId,
      sessionId: caller.sessionId,
      requestId: request.id,
      // Records that credentials were issued, never the credentials themselves.
      afterValue: { stunConfigured: ice.stunUrls.length, turnConfigured: ice.turnUrls.length },
    });

    return reply.send({
      configuration,
      /**
       * Told plainly rather than discovered by a failed connection: with no STUN or TURN
       * configured, ICE has only host candidates, so a stream works on the same network
       * and nowhere else.
       */
      reachability: ice.internetCapable ? 'lan-and-internet' : 'lan-only',
      note: ice.internetCapable
        ? null
        : 'No STUN or TURN server is configured, so remote desktop will only connect on the ' +
          'same local network. Configure WOLF_STUN_URLS and WOLF_TURN_URLS to reach this PC ' +
          'over the internet.',
    });
  });

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  app.get('/remote-desktop/profiles', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const saved = await context.repos.remoteDesktop.listProfiles(caller.userId);

    return reply.send({
      // Built-ins are returned alongside saved profiles so a fresh account has something
      // usable without having to invent bitrates.
      builtIn: Object.entries(BUILT_IN_PROFILES).map(([id, settings]) => ({
        id,
        name: settings.name,
        settings,
        builtIn: true,
      })),
      profiles: saved.map((profile) => ({
        id: profile.id,
        name: profile.name,
        settings: profile.settings,
        isDefault: profile.isDefault,
        builtIn: false,
      })),
    });
  });

  app.post('/remote-desktop/profiles', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const body = parseOrThrow(profileBody, request.body, { what: 'The profile' });

    try {
      const profile = await context.repos.remoteDesktop.createProfile({
        id: newId(),
        userId: caller.userId,
        name: body.name,
        settings: body.settings,
        isDefault: body.isDefault,
      });

      await context.repos.audit.record({
        category: 'configuration',
        action: 'remote-desktop.profile.create',
        outcome: 'success',
        riskLevel: 'low',
        userId: caller.userId,
        deviceId: caller.deviceId,
        requestId: request.id,
        target: { kind: 'remote-desktop-profile', name: body.name },
      });

      return reply.status(201).send({ profile });
    } catch (error) {
      if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
        throw conflict(
          'A profile with that name already exists.',
          'Profile names are unique per account.',
          'Choose a different name, or edit the existing profile.',
        );
      }
      throw error;
    }
  });

  app.patch(
    '/remote-desktop/profiles/:profileId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(profileParams, request.params, { what: 'The profile id' });
      const body = parseOrThrow(profileBody, request.body, { what: 'The profile' });

      const profile = await context.repos.remoteDesktop.updateProfile({
        id: params.profileId,
        userId: caller.userId,
        name: body.name,
        settings: body.settings,
        isDefault: body.isDefault,
      });
      if (!profile) throw notFound('That profile');

      await context.repos.audit.record({
        category: 'configuration',
        action: 'remote-desktop.profile.update',
        outcome: 'success',
        riskLevel: 'low',
        userId: caller.userId,
        deviceId: caller.deviceId,
        requestId: request.id,
        target: { kind: 'remote-desktop-profile', name: body.name },
      });

      return reply.send({ profile });
    },
  );

  app.delete(
    '/remote-desktop/profiles/:profileId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(profileParams, request.params, { what: 'The profile id' });

      const deleted = await context.repos.remoteDesktop.deleteProfile(
        params.profileId,
        caller.userId,
      );
      if (!deleted) throw notFound('That profile');

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  /**
   * Streams currently running on a PC.
   *
   * Deliberately visible to any authorized caller, not only the session that started them:
   * knowing that someone else is watching a machine you administer is the point.
   */
  app.get('/pcs/:pcId/streams', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const streams = await context.repos.remoteDesktop.listActiveStreams(params.pcId);
    return reply.send({
      streams: streams.map((stream) => ({
        id: stream.id,
        sessionId: stream.sessionId,
        deviceId: stream.deviceId,
        state: stream.state,
        route: stream.route,
        videoCodec: stream.videoCodec,
        hardwareEncoded: stream.hardwareEncoded,
        unavailableReason: stream.unavailableReason,
        startedAt: stream.startedAt.toISOString(),
        stats: stream.lastStats,
        /** True when this is the caller's own stream. */
        own: stream.sessionId === caller.sessionId,
      })),
    });
  });
}

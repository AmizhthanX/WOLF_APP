import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { WolfError, isWolfError, newId } from '@wolf/shared-types';
import type { AppContext } from './context.js';
import { createAuthenticate } from './auth.js';
import { internalError } from './errors.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerDeviceRoutes } from '../routes/devices.js';
import { registerPcRoutes } from '../routes/pcs.js';
import { registerCommandRoutes } from '../routes/commands.js';
import { registerTelemetryRoutes } from '../routes/telemetry.js';
import { registerAuditRoutes } from '../routes/audit.js';
import { registerRemoteDesktopRoutes } from '../routes/remote-desktop.js';
import { registerAlertRoutes } from '../routes/alerts.js';
import { registerAutomationRoutes } from '../routes/automations.js';
import { registerConfigurationRoutes } from '../routes/configuration.js';

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Widened to Fastify's own logger interface so the instance keeps the default generics
    // and route modules can be typed with a plain FastifyInstance.
    loggerInstance: context.logger as FastifyBaseLogger,
    // Request ids are WOLF ids so they sort by time and can be pasted into an audit query.
    genReqId: () => newId(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // The API serves JSON only; the web app sets its own CSP.
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Non-browser callers (the agent, curl, native apps) send no Origin header.
      if (!origin) return callback(null, true);
      callback(null, context.config.allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Wolf-Device-Id', 'X-Wolf-Idempotency-Key'],
    maxAge: 600,
  });

  app.decorate('wolf', context);
  app.decorateRequest('auth', undefined);

  const authenticate = createAuthenticate(context);
  app.decorate('authenticate', authenticate);

  /**
   * Single error boundary. Everything the client sees is a WolfProblem carrying a
   * reference id that also appears in the structured log, so a user can quote
   * "WOLF-CMD-8F2C" and an operator can find the exact request.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const wolfError: WolfError = isWolfError(error)
      ? error
      : error.statusCode === 400 || error.validation
        ? new WolfError({
            code: 'validation.failed',
            problem: 'The request could not be accepted.',
            cause: error.message,
            currentState: 'Nothing was changed.',
            recommendedAction: 'Correct the request and try again.',
            area: 'API',
            httpStatus: 400,
          })
        : internalError(error.message, { stack: error.stack });

    const logPayload = {
      referenceId: wolfError.referenceId,
      code: wolfError.code,
      requestId: request.id,
      route: request.routeOptions?.url ?? request.url,
      userId: request.auth?.userId ?? null,
      pcId: request.auth?.pcId ?? null,
      detail: wolfError.detail,
    };

    if (wolfError.httpStatus >= 500) {
      request.log.error(logPayload, wolfError.problem);
    } else {
      request.log.warn(logPayload, wolfError.problem);
    }

    const retryAfter = (wolfError.detail as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      void reply.header('Retry-After', String(retryAfter));
    }

    void reply.status(wolfError.httpStatus).send({ error: wolfError.toProblem() });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'route.not_found',
        problem: 'That endpoint does not exist.',
        cause: `No route matches ${request.method} ${request.url}.`,
        currentState: 'Nothing was changed.',
        recommendedAction: 'Check the API version prefix and path.',
        referenceId: `WOLF-API-${request.id.slice(-4)}`,
        httpStatus: 404,
      },
    });
  });

  // Liveness and readiness. Deliberately unauthenticated and deliberately free of any
  // detail that would help an unauthenticated caller profile the deployment.
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await context.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not-ready' });
    }
  });

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, context);
      await registerDeviceRoutes(api, context);
      await registerPcRoutes(api, context);
      await registerCommandRoutes(api, context);
      await registerTelemetryRoutes(api, context);
      await registerAuditRoutes(api, context);
      await registerRemoteDesktopRoutes(api, context);
      await registerAlertRoutes(api, context);
      await registerAutomationRoutes(api, context);
      await registerConfigurationRoutes(api, context);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    wolf: AppContext;
    authenticate: ReturnType<typeof createAuthenticate>;
  }
}

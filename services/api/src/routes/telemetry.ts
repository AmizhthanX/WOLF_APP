import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGGREGATED_METRICS,
  findingsFor,
  forecastVolume,
  resolutionForWindow,
  summariseGpu,
  type GpuBucket,
} from '@wolf/telemetry-schema';
import { parseOrThrow } from '@wolf/validation';
import type { AppContext } from '../http/context.js';
import { requireAuth } from '../http/auth.js';
import { notFound } from '../http/errors.js';

const pcParams = z.object({ pcId: z.string().length(26) });

const rangeQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  metrics: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((metric) => metric.trim()) : undefined)),
  /** Omit to let the server pick the coarsest resolution that covers the window. */
  resolution: z.enum(['raw', '5m', '1h', '1d']).optional(),
});

export async function registerTelemetryRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.get(
    '/pcs/:pcId/telemetry/latest',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const caller = requireAuth(request);
      const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });

      const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
      if (!pc) throw notFound('That PC');

      const latest = await context.repos.telemetry.latestSample(params.pcId);
      return reply.send({
        sample: latest?.sample ?? null,
        sampledAt: latest?.sampledAt.toISOString() ?? null,
        // A null sample with an online PC means telemetry has not arrived yet, which the
        // UI must distinguish from "the machine reports zero usage".
        pcStatus: pc.status,
      });
    },
  );

  /**
   * Historical telemetry.
   *
   * The resolution is chosen from the requested window unless the caller pins one: asking
   * for a year of one-second samples would return nothing useful and cost a great deal, so
   * the server answers from the tier that actually retains that window.
   */
  app.get('/pcs/:pcId/telemetry', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });
    const query = parseOrThrow(rangeQuery, request.query ?? {}, { what: 'The query' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const to = query.to ? new Date(query.to) : context.now();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 3_600_000);
    const windowSeconds = Math.max(1, (to.getTime() - from.getTime()) / 1000);
    const resolution = query.resolution ?? resolutionForWindow(windowSeconds);

    if (resolution === 'raw') {
      const samples = await context.repos.telemetry.listSamples(params.pcId, from, to);
      return reply.send({
        resolution,
        from: from.toISOString(),
        to: to.toISOString(),
        samples: samples.map((entry) => entry.sample),
      });
    }

    const metrics = (query.metrics ?? [...AGGREGATED_METRICS]).filter((metric) =>
      (AGGREGATED_METRICS as readonly string[]).includes(metric),
    );

    const aggregates = await context.repos.telemetry.listAggregates({
      pcId: params.pcId,
      resolution,
      metrics,
      from,
      to,
    });

    return reply.send({
      resolution,
      from: from.toISOString(),
      to: to.toISOString(),
      metrics,
      aggregates: aggregates.map((row) => ({
        bucketStart: row.bucketStart.toISOString(),
        metric: row.metric,
        seriesKey: row.seriesKey || null,
        min: row.min,
        max: row.max,
        avg: row.avg,
        p95: row.p95,
        sampleCount: row.sampleCount,
      })),
    });
  });

  /**
   * What the history says: storage fill forecasts, a GPU load summary, and the findings worth
   * attention.
   *
   * Computed on every request from telemetry already held and never stored, so there is no second
   * copy of anything to keep in step or to delete with the PC. Nothing about processes is here: the
   * cloud holds no process data, and process-level insight lives in the live process list on the PC.
   */
  app.get('/pcs/:pcId/insights', { preHandler: app.authenticate }, async (request, reply) => {
    const caller = requireAuth(request);
    const params = parseOrThrow(pcParams, request.params, { what: 'The PC id' });

    const pc = await context.repos.pcs.findById(params.pcId, caller.userId);
    if (!pc) throw notFound('That PC');

    const now = context.now();
    const latest = await context.repos.telemetry.latestSample(params.pcId);

    if (!latest) {
      return reply.send({ generatedAt: now.toISOString(), sampledAt: null, storage: [], gpus: [], findings: [] });
    }

    // Storage trends are read from hourly buckets over a month: long enough to see past a week of
    // churn, and the hourly tier retains it. GPU load from five-minute buckets over a day.
    const [usage, gpuRows] = await Promise.all([
      context.repos.telemetry.listAggregates({
        pcId: params.pcId,
        resolution: '1h',
        metrics: ['disk.usedPercent'],
        from: new Date(now.getTime() - 30 * 86_400_000),
        to: now,
      }),
      context.repos.telemetry.listAggregates({
        pcId: params.pcId,
        resolution: '5m',
        metrics: ['gpu.usage', 'gpu.vramUsed', 'gpu.temperature'],
        from: new Date(now.getTime() - 24 * 3_600_000),
        to: now,
      }),
    ]);

    const storage = latest.sample.disks.map((disk) =>
      forecastVolume({
        disk,
        now,
        history: usage
          .filter((row) => row.seriesKey === disk.volume && row.avg !== null)
          .map((row) => ({ at: row.bucketStart, usedPercent: row.avg! })),
      }),
    );

    const gpus = latest.sample.gpus.map((gpu) =>
      summariseGpu({
        adapterId: gpu.adapterId,
        name: gpu.name,
        vramTotalBytes: gpu.vramTotalBytes,
        windowHours: 24,
        buckets: gpuRows
          .filter((row) => row.seriesKey === gpu.adapterId)
          .map((row) => ({
            metric: row.metric as GpuBucket['metric'],
            min: row.min,
            max: row.max,
            avg: row.avg,
            p95: row.p95,
            sampleCount: row.sampleCount,
          })),
      }),
    );

    return reply.send({
      generatedAt: now.toISOString(),
      // Insights about a PC that has been silent for a week describe that week-old PC; the caller is
      // told when the newest reading was taken rather than left to assume it is current.
      sampledAt: latest.sampledAt.toISOString(),
      storage,
      gpus,
      findings: findingsFor(storage, gpus),
    });
  });
}

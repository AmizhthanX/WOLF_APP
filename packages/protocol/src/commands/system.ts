import { z } from 'zod';

export const systemInfoCommand = z.object({
  type: z.literal('system.info'),
  payload: z.object({
    /** Re-probe hardware instead of returning the agent's cached inventory. */
    refresh: z.boolean().default(false),
  }),
});

export const systemCapabilitiesCommand = z.object({
  type: z.literal('system.capabilities'),
  payload: z.object({
    /** Re-run capability detection (encoders, capture, audio, WOL, helper availability). */
    redetect: z.boolean().default(false),
  }),
});

export const systemTelemetrySnapshotCommand = z.object({
  type: z.literal('system.telemetry-snapshot'),
  payload: z.object({
    /** Optional subsystem filter; omitted means every subsystem the agent can sample. */
    include: z
      .array(z.enum(['cpu', 'memory', 'gpu', 'disk', 'network', 'thermal', 'battery']))
      .max(8)
      .optional(),
  }),
});

export const systemSessionStateCommand = z.object({
  type: z.literal('system.session-state'),
  payload: z.object({}),
});

export const systemCommand = z.discriminatedUnion('type', [
  systemInfoCommand,
  systemCapabilitiesCommand,
  systemTelemetrySnapshotCommand,
  systemSessionStateCommand,
]);

export type SystemCommand = z.infer<typeof systemCommand>;

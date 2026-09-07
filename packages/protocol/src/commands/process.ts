import { z } from 'zod';
import { displayName, pid, wolfId } from '@wolf/validation';

/**
 * Windows processes that WOLF refuses to terminate outright, and processes whose
 * termination is escalated to a higher risk level. Killing any of these either bluescreens
 * the machine or destroys the session the operator is working in.
 */
export const CRITICAL_SYSTEM_PROCESSES: ReadonlySet<string> = new Set([
  'system',
  'system idle process',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'winlogon.exe',
  'memory compression',
]);

/** Processes that keep WOLF itself reachable; terminating them ends remote access. */
export const WOLF_OWN_PROCESSES: ReadonlySet<string> = new Set([
  'wolf.agent.exe',
  'wolf.privilegedhelper.exe',
  'wolf.controlpanel.exe',
]);

export const processPriority = z.enum([
  'idle',
  'below-normal',
  'normal',
  'above-normal',
  'high',
  'realtime',
]);
export type ProcessPriority = z.infer<typeof processPriority>;

export const processListCommand = z.object({
  type: z.literal('process.list'),
  payload: z.object({
    /** Include per-process disk and network I/O counters, which cost extra sampling time. */
    includeIo: z.boolean().default(false),
    /** Include publisher and signature status, which requires reading each image. */
    includeSignature: z.boolean().default(false),
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(2000).default(500),
  }),
});

export const processTreeCommand = z.object({
  type: z.literal('process.tree'),
  payload: z.object({
    rootPid: pid.optional(),
  }),
});

export const processDetailsCommand = z.object({
  type: z.literal('process.details'),
  payload: z.object({
    pid,
  }),
});

export const processTerminateCommand = z.object({
  type: z.literal('process.terminate'),
  payload: z.object({
    pid,
    /**
     * The name the operator believed they were terminating. The agent verifies it against
     * the live process before acting, so a recycled PID cannot kill the wrong process.
     */
    expectedName: z.string().min(1).max(260),
    /** Skip the graceful close-window request and terminate immediately. */
    force: z.boolean().default(false),
    /** Terminate the whole process tree rather than the single process. */
    includeChildren: z.boolean().default(false),
  }),
});

export const processSetPriorityCommand = z.object({
  type: z.literal('process.set-priority'),
  payload: z.object({
    pid,
    expectedName: z.string().min(1).max(260),
    priority: processPriority,
  }),
});

export const processStartCommand = z.object({
  type: z.literal('process.start'),
  payload: z.object({
    /** Reference to a registered application or launch profile, never a raw command line. */
    applicationId: wolfId,
    /** Arguments are passed as a vector, never a shell string, so nothing is re-parsed. */
    arguments: z.array(z.string().max(2048)).max(64).default([]),
    workingDirectory: z.string().max(4096).optional(),
    profileName: displayName.optional(),
  }),
});

export const processCommand = z.discriminatedUnion('type', [
  processListCommand,
  processTreeCommand,
  processDetailsCommand,
  processTerminateCommand,
  processSetPriorityCommand,
  processStartCommand,
]);

export type ProcessCommand = z.infer<typeof processCommand>;

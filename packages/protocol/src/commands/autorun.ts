import { z } from 'zod';

/**
 * Scheduled tasks and startup items — what a machine does on its own.
 *
 * With services, these are the three ways something runs without anybody asking, and the three
 * places anybody investigating a machine looks first. That is why the read commands exist, and
 * why they are audited despite changing nothing: "what runs on this machine when nobody is
 * watching" is a useful question and also exactly what somebody planning to abuse it wants to
 * know.
 *
 * ## WOLF creates neither
 *
 * There is no command here that registers a scheduled task, and none that adds a startup
 * entry — nor any that deletes one. A scheduled task and a `Run` key are the two mechanisms
 * every piece of Windows malware reaches for, and a remote-management tool that can install
 * either is a remote persistence tool whatever else it is.
 *
 * Disabling a startup entry writes the same approval flag Task Manager writes, so the entry
 * survives and can be put back. That is a smaller feature than deleting one and a much better
 * one: it is reversible from the same session, and it means a compromised WOLF session cannot
 * remove the evidence of what was there.
 */

/**
 * A scheduled task path: folder and name, as the scheduler stores it.
 *
 * Backslash-separated and rooted, which is the scheduler's own shape — `\Microsoft\Windows\
 * Defrag\ScheduledDefrag`. Rejects relative segments for the same reason file paths do: the
 * path that gets checked and the path that gets opened must be the same string.
 */
export const taskPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\\(?:[^\\/:*?"<>|]+\\?)*$/, 'A task path is rooted and backslash-separated.')
  .refine((value) => !value.split('\\').includes('..'), 'A task path must not climb out of itself.');

export const TASK_ACTIONS = ['enable', 'disable', 'run'] as const;
export const taskAction = z.enum(TASK_ACTIONS);
export type TaskAction = z.infer<typeof taskAction>;

/**
 * Task folders WOLF refuses to disable anything in.
 *
 * The cloud's copy of the agent's list, kept for the same reason the service one is: to tell an
 * operator what they are about to attempt rather than letting them discover it from a refusal.
 * The agent's copy is the one that actually stops it.
 *
 * Folders rather than task names, because the set inside them differs by Windows build and a
 * list of names would be quietly wrong on half the machines it ran on.
 */
export const PROTECTED_TASK_FOLDERS: readonly string[] = [
  '\\Microsoft\\Windows\\TaskScheduler',
  '\\Microsoft\\Windows\\Servicing',
  '\\Microsoft\\Windows\\WindowsUpdate',
  '\\Microsoft\\Windows\\UpdateOrchestrator',
  '\\Microsoft\\Windows\\SoftwareProtectionPlatform',
  '\\Microsoft\\Windows\\SystemRestore',
  '\\Microsoft\\Windows\\Chkdsk',
  '\\Microsoft\\Windows\\Time Synchronization',
  '\\Microsoft\\Windows\\Diagnosis',
  '\\Microsoft\\Windows\\ErrorDetails',
  '\\Microsoft\\Windows\\Maintenance',
  '\\Microsoft\\Windows\\Windows Defender',
  '\\Microsoft\\Windows\\ExploitGuard',
  '\\WOLF',
];

/** True when WOLF refuses to disable anything at this path, however it is confirmed. */
export function isProtectedTask(path: string): boolean {
  const rooted = path.startsWith('\\') ? path : `\\${path}`;

  return PROTECTED_TASK_FOLDERS.some(
    (folder) =>
      rooted.toLowerCase() === folder.toLowerCase() ||
      rooted.toLowerCase().startsWith(`${folder.toLowerCase()}\\`),
  );
}

export const taskListCommand = z.object({
  type: z.literal('task.list'),
  payload: z.object({
    /** Matches anywhere in the task's path. Absent lists everything, hidden tasks included. */
    search: z.string().max(200).optional(),
  }),
});

export const taskControlCommand = z.object({
  type: z.literal('task.control'),
  payload: z.object({
    path: taskPath,
    action: taskAction,
    /**
     * The name the operator believed they were acting on.
     *
     * Checked against the live task before anything happens, the same way a service's display
     * name is. A list read a minute ago can describe a machine that has changed since.
     */
    expectedName: z.string().min(1).max(512),
  }),
});

/** Which of Windows' four places a startup entry came from. */
export const STARTUP_SOURCES = ['run', 'run-once', 'startup-folder'] as const;
export const startupSource = z.enum(STARTUP_SOURCES);
export type StartupSource = z.infer<typeof startupSource>;

/** Whether an entry starts for everybody on the machine or for one person. */
export const STARTUP_SCOPES = ['machine', 'user'] as const;
export const startupScope = z.enum(STARTUP_SCOPES);
export type StartupScope = z.infer<typeof startupScope>;

export const startupListCommand = z.object({
  type: z.literal('startup.list'),
  payload: z.object({}),
});

export const startupSetEnabledCommand = z.object({
  type: z.literal('startup.set-enabled'),
  payload: z.object({
    name: z.string().min(1).max(512),
    scope: startupScope,
    source: startupSource,
    /**
     * On or off, and nothing else.
     *
     * There is deliberately no `command` field. A payload that could set what an entry runs
     * would be one that could install persistence under an existing name, which is the thing
     * this whole area is built not to allow.
     */
    enabled: z.boolean(),
  }),
});

export const autorunCommand = z.discriminatedUnion('type', [
  taskListCommand,
  taskControlCommand,
  startupListCommand,
  startupSetEnabledCommand,
]);

export type AutorunCommand = z.infer<typeof autorunCommand>;

import { z } from 'zod';
import { isoDateTime } from '@wolf/validation';

export const POWER_ACTIONS = [
  'lock',
  'sign-out',
  'sleep',
  'hibernate',
  'restart',
  'shutdown',
] as const;
export const powerAction = z.enum(POWER_ACTIONS);
export type PowerAction = z.infer<typeof powerAction>;

/** Delay before a power action runs, giving the operator a countdown they can cancel. */
const delaySeconds = z.number().int().min(0).max(86_400).default(0);

export const powerActionCommand = z.object({
  type: z.literal('power.action'),
  payload: z.object({
    action: powerAction,
    delaySeconds,
    /** Force applications to close instead of letting them block the transition. */
    force: z.boolean().default(false),
    /** Free-text note recorded in the audit trail, never shown to signed-in Windows users. */
    reason: z.string().max(200).optional(),
  }),
});

/**
 * A scheduled power action must name the exact instant it runs. A queued action that
 * simply fires when connectivity returns is never acceptable for shutdown or restart.
 */
export const powerScheduleCommand = z.object({
  type: z.literal('power.schedule'),
  payload: z.object({
    action: powerAction,
    runAt: isoDateTime,
    force: z.boolean().default(false),
    reason: z.string().max(200).optional(),
  }),
});

export const powerCancelCommand = z.object({
  type: z.literal('power.cancel'),
  payload: z.object({
    /** Identifier of the pending or scheduled action to cancel. */
    pendingActionId: z.string().min(1).max(64),
  }),
});

export const powerPendingCommand = z.object({
  type: z.literal('power.pending'),
  payload: z.object({}),
});

/**
 * Wake-on-LAN. Dispatched to a peer agent on the same LAN or to an always-on LAN relay,
 * never to the sleeping PC itself.
 */
export const powerWakeCommand = z.object({
  type: z.literal('power.wake'),
  payload: z.object({
    /** PC to wake. The MAC address is resolved on the sending side from stored PC config. */
    targetPcId: z.string().min(1).max(64),
  }),
});

/**
 * Remote unlock using the dedicated WOLF unlock credential provisioned on the PC.
 * The credential never travels with the command and is never returned to the cloud.
 */
export const powerUnlockCommand = z.object({
  type: z.literal('power.unlock'),
  payload: z.object({
    /** Which provisioned unlock credential to use, by its local identifier. */
    credentialId: z.string().min(1).max(64),
  }),
});

export const powerCommand = z.discriminatedUnion('type', [
  powerActionCommand,
  powerScheduleCommand,
  powerCancelCommand,
  powerPendingCommand,
  powerWakeCommand,
  powerUnlockCommand,
]);

export type PowerCommand = z.infer<typeof powerCommand>;

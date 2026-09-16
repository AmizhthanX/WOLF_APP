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
 * A network adapter's hardware address, as WOLF writes it: six lowercase hex pairs joined by colons.
 *
 * Only a unicast address is one: a group address (the low bit of the first octet set) names many
 * machines, and the all-zero address names none. A wake packet for either would be a broadcast
 * with extra steps.
 */
export const wakeMacAddress = z
  .string()
  .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, 'A MAC address is six lowercase hex pairs joined by colons.')
  .refine((mac) => (parseInt(mac.slice(0, 2), 16) & 1) === 0, 'A group address cannot be woken.')
  .refine((mac) => mac !== '00:00:00:00:00:00', 'The all-zero address is not an adapter.');

/**
 * Wake-on-LAN, sent to a PC that is **online** — never to the sleeping PC, which cannot hear a
 * command — so that it broadcasts a magic packet on its own local networks.
 *
 * A client names only the PC to wake. The address to wake it at is the one that PC reported for
 * its own wired adapter, and the API fills it in: a `macAddress` a client sends is replaced, never
 * used, so nobody can point a PC at a machine WOLF does not know.
 */
export const powerWakeCommand = z.object({
  type: z.literal('power.wake'),
  payload: z.object({
    /** PC to wake: one of the caller's own, offline, and not the PC sending the packet. */
    targetPcId: z.string().min(1).max(64),
    /** Filled in by the API from what the target reported. The agent refuses a wake without one. */
    macAddress: wakeMacAddress.optional(),
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

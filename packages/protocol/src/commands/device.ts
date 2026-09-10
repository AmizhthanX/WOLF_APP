import { z } from 'zod';

/**
 * Hardware devices: what is attached, and turning one off or on.
 *
 * Changing a device's state needs administrative rights, so it runs in the privileged
 * helper. But elevation is the least interesting thing about it. Disabling hardware on a PC
 * you are not sitting at is the most dangerous thing WOLF can do that is not destroying
 * data: disable the network adapter carrying this very connection and the machine is gone
 * until somebody walks to it.
 *
 * So the risk is asymmetric, and the schema says so. Enabling a device restores function and
 * is `medium`. Disabling one is `critical` — confirmation, re-authentication, and a
 * single-use privileged grant — and some devices are refused outright rather than
 * confirmed, because a confirmation dialog is not a substitute for not being able to undo it.
 */

export const deviceListCommand = z.object({
  type: z.literal('device.list'),
  payload: z.object({
    /** Windows device class to filter by, e.g. "Net". Null lists everything present. */
    deviceClass: z.string().max(64).nullable().default(null),
    /** Include devices Windows knows about but that are not attached right now. */
    includeAbsent: z.boolean().default(false),
  }),
});

export const deviceSetEnabledCommand = z.object({
  type: z.literal('device.set-enabled'),
  payload: z.object({
    /** The Windows instance id, which is what identifies a device uniquely. */
    instanceId: z.string().min(1).max(512),
    enabled: z.boolean(),
    /**
     * The device's name as the caller last saw it.
     *
     * Checked before acting, the same way terminating a process checks the name against the
     * pid: instance ids are stable but a dashboard can be minutes out of date, and
     * disabling the wrong device is not something an operator gets to take back.
     */
    expectedName: z.string().max(256),
  }),
});

export const deviceCommand = z.discriminatedUnion('type', [
  deviceListCommand,
  deviceSetEnabledCommand,
]);

export type DeviceCommand = z.infer<typeof deviceCommand>;

/**
 * What Windows says about a device right now.
 *
 * `error` is its own state rather than being folded into `disabled`: a device with a driver
 * problem and a device somebody switched off look the same in a list that only has two
 * states, and they call for completely different responses.
 */
export const DEVICE_STATES = ['working', 'disabled', 'error', 'unknown'] as const;
export const deviceState = z.enum(DEVICE_STATES);
export type DeviceState = z.infer<typeof deviceState>;

/**
 * Why WOLF will not disable a device, when it will not.
 *
 * These are refusals, not warnings. Each one is a device whose loss WOLF could not undo
 * remotely, which makes a confirmation prompt the wrong tool: the operator would be
 * confirming that they understand a risk they cannot actually recover from.
 */
export const DEVICE_PROTECTIONS = [
  /** The link this PC is managed over, or one that might be. */
  'network-connected',
  /** A disk or controller the machine boots from. */
  'storage-critical',
  /** The display adapter driving the session WOLF captures. */
  'display-adapter',
  /** Windows' own system devices: processors, buses, firmware. */
  'system-critical',
] as const;
export const deviceProtection = z.enum(DEVICE_PROTECTIONS);
export type DeviceProtection = z.infer<typeof deviceProtection>;

export const deviceInfo = z.object({
  instanceId: z.string().max(512),
  name: z.string().max(256),
  /** Windows device class, e.g. "Net", "Display", "AudioEndpoint". */
  deviceClass: z.string().max(64).nullable(),
  manufacturer: z.string().max(256).nullable(),
  state: deviceState,
  /** Windows' Configuration Manager error code, for a device in `error`. */
  problemCode: z.number().int().min(0).max(255).nullable(),
  /** What the problem code means, when there is one. */
  problem: z.string().max(200).nullable(),
  /** True when Windows knows this device but it is not attached right now. */
  present: z.boolean(),
  /**
   * Set when WOLF will refuse to disable this device, with which protection applies.
   *
   * Present on every device in the list rather than discovered on refusal, so a dashboard
   * can show the reason next to a control it has greyed out instead of offering an action
   * that will fail.
   */
  protectedBy: deviceProtection.nullable().default(null),
});
export type DeviceInfo = z.infer<typeof deviceInfo>;

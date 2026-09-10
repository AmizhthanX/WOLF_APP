import { z } from 'zod';

/**
 * Windows services.
 *
 * On the command path, not the data channel — deliberately, and opposite to the terminal and
 * the file manager. Those two carry content that must never be stored, so they go where no
 * server can see them. A service change carries no content at all: it is a name and a verb.
 * What matters about it is the reverse — that it is classified for risk, confirmed,
 * re-authenticated where the risk warrants, and written to an audit record somebody can read
 * afterwards. All of that lives in the cloud, and routing service control around it to save a
 * hop would trade the only property that makes it accountable for one it does not need.
 *
 * **WOLF never creates or deletes a service.** There is no command here that would, and there
 * is not going to be one. Installing a service is a persistence mechanism; a remote-management
 * tool that can do it is a remote-persistence tool, which is a different product with a
 * different threat model. What these commands do is manage services that already exist.
 */

/**
 * Services whose loss cannot be undone from the other end of a network.
 *
 * Listed here as well as in the agent because the two answer different questions at different
 * moments: the cloud uses this to classify risk *before* dispatching, so an operator is told
 * what they are about to attempt rather than discovering it from a refusal. The agent's copy
 * is the one that actually stops it, and it is the one that survives a tampered-with cloud.
 *
 * Duplication is a real cost. Getting it wrong in the direction of "the cloud thinks this is
 * safe" costs a confirmation prompt; getting it wrong in the other direction costs a machine.
 */
export const UNSTOPPABLE_SERVICES: ReadonlySet<string> = new Set([
  // WOLF's own. Stopping one ends the session that would report the result.
  'wolfagent',
  'wolfagenthelper',
  // The RPC and COM core. `RpcSs` famously cannot be stopped and cannot be started again.
  'rpcss',
  'dcomlaunch',
  'rpceptmapper',
  'lsm',
  'samss',
  'plugplay',
  'power',
  'profsvc',
  'eventlog',
  'cryptsvc',
  'gpsvc',
  'usermanager',
  'systemeventsbroker',
  'brokerinfrastructure',
  'coremessagingregistrar',
  'dsmsvc',
  'winmgmt',
  // Everything the way back in depends on. `BFE` is the one whose name does not tell you
  // that stopping it takes the firewall, IPsec and often the network stack with it.
  'dhcp',
  'dnscache',
  'nsi',
  'nlasvc',
  'netprofm',
  'bfe',
  'mpssvc',
  'netman',
  'winhttpautoproxysvc',
  'lanmanworkstation',
  'ncbservice',
  'wcmsvc',
  'wlansvc',
  'iphlpsvc',
]);

/** A Windows service name. Not a path, not a display name — what `sc` would take. */
export const serviceName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\\/\s]+$/, 'A service name has no spaces or path separators.');

export const SERVICE_ACTIONS = ['start', 'stop', 'restart'] as const;
export const serviceAction = z.enum(SERVICE_ACTIONS);
export type ServiceAction = z.infer<typeof serviceAction>;

/**
 * When a service starts.
 *
 * `boot` and `system` are readable but not settable. They belong to drivers that load before
 * the service control manager exists, and a remote tool that could put an ordinary service
 * there would be one that could make a machine unbootable in a way nothing on it could undo.
 */
export const SERVICE_START_TYPES = [
  'automatic',
  'automatic-delayed',
  'manual',
  'disabled',
] as const;
export const serviceStartType = z.enum(SERVICE_START_TYPES);
export type ServiceStartType = z.infer<typeof serviceStartType>;

export const serviceListCommand = z.object({
  type: z.literal('service.list'),
  payload: z.object({
    /** Matches the service name or its display name. Absent lists everything. */
    search: z.string().max(200).optional(),
  }),
});

export const serviceControlCommand = z.object({
  type: z.literal('service.control'),
  payload: z.object({
    name: serviceName,
    action: serviceAction,
    /**
     * The display name the operator believed they were acting on.
     *
     * Checked against the live service before anything happens, the same way terminating a
     * process checks the name against the pid. A service list read a minute ago can describe
     * a machine that has changed since.
     */
    expectedDisplayName: z.string().min(1).max(512),
  }),
});

export const serviceSetStartTypeCommand = z.object({
  type: z.literal('service.set-start-type'),
  payload: z.object({
    name: serviceName,
    startType: serviceStartType,
    expectedDisplayName: z.string().min(1).max(512),
  }),
});

export const serviceCommand = z.discriminatedUnion('type', [
  serviceListCommand,
  serviceControlCommand,
  serviceSetStartTypeCommand,
]);

export type ServiceCommand = z.infer<typeof serviceCommand>;

/** True when WOLF refuses to stop or disable this service however it is confirmed. */
export function isUnstoppableService(name: string): boolean {
  return UNSTOPPABLE_SERVICES.has(name.toLowerCase());
}

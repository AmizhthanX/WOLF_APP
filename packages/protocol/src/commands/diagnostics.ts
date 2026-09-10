import { z } from 'zod';

/**
 * The three questions an operator asks when something is wrong and nothing has crashed:
 * what is this machine's network doing, what has Windows been complaining about, and what is
 * actually inside it.
 *
 * All three are reads, all three are on the command path, and all three are audited despite
 * changing nothing. Two of them need that said out loud.
 *
 * ## Network tests make the PC emit traffic
 *
 * A ping is not a read. It is WOLF asking somebody else's machine to send packets to a
 * destination the operator chose — which is a small thing when the destination is the office
 * gateway and a different thing entirely when it is a host the operator has no business
 * touching. WOLF does not decide which of those it is, because it cannot: "can this PC reach
 * the file server" and "can this PC reach the internet" are the two most common diagnostics
 * there are, and a rule that blocked private ranges or public ones would break one of them.
 *
 * What it does instead is bound the *shape* and record the *target*: one host per command, a
 * handful of packets, a short timeout, no port ranges, no host lists — and an audit record
 * naming what was probed. That makes the PC a diagnostic tool rather than a scanner, and
 * leaves a trail if somebody tries to use it as one anyway.
 *
 * ## Event log text passes through the cloud
 *
 * The only diagnostic read that does. An event log message can contain an account name, a
 * command line, a file path, or — from software that should know better — a credential. That
 * is a real exposure and it is written down here rather than discovered later: it travels with
 * the command result and is retained with it.
 *
 * It is on the command path anyway, because the value of an event log is in reading it beside
 * everything else WOLF knows about the machine, and because the entries are already a record
 * the machine keeps on disk. What is bounded is how much of it moves: a count, a time window,
 * a level filter, and a cap on each message.
 */

/* --------------------------------------------------------------------------- */
/* Network                                                                      */
/* --------------------------------------------------------------------------- */

/**
 * A host to test against: a name or an address, and nothing that expands into many.
 *
 * No CIDR, no ranges, no comma-separated lists. Each of those turns one command into a sweep,
 * and a sweep is the thing this is built not to be.
 */
export const networkTarget = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:\-[\]]+$/, 'A target is one host name or address.')
  .refine((value) => !value.includes('/'), 'A target is one host, not a range.');

export const NETWORK_TESTS = ['ping', 'dns', 'tcp'] as const;
export const networkTest = z.enum(NETWORK_TESTS);
export type NetworkTest = z.infer<typeof networkTest>;

/** Echo requests per test. Four is what `ping` sends by default and is plenty to decide. */
export const MAX_PING_COUNT = 4;

/** Milliseconds any one probe waits. Long enough for a slow link, short enough to answer. */
export const MAX_PROBE_TIMEOUT_MS = 5000;

export const networkInfoCommand = z.object({
  type: z.literal('network.info'),
  payload: z.object({
    /** Include the machine's open connections, which is the expensive half. */
    includeConnections: z.boolean().default(false),
  }),
});

export const networkTestCommand = z.object({
  type: z.literal('network.test'),
  payload: z.object({
    test: networkTest,
    target: networkTarget,
    /**
     * One port, for a TCP test. Not a range — a range is a port scan with a different name.
     */
    port: z.number().int().min(1).max(65535).optional(),
    count: z.number().int().min(1).max(MAX_PING_COUNT).default(4),
    timeoutMs: z.number().int().min(100).max(MAX_PROBE_TIMEOUT_MS).default(2000),
  }),
});

/* --------------------------------------------------------------------------- */
/* Event log                                                                    */
/* --------------------------------------------------------------------------- */

/**
 * Which log to read.
 *
 * `Security` is included, and deliberately. It is the most sensitive of them and the one an
 * investigation actually needs — logon events, privilege use, account changes — and leaving it
 * out would mean WOLF can tell you a machine was compromised but not by whom. What it gets
 * instead is the same treatment as the rest: a bound on how much comes back, and an audit
 * record saying somebody read it.
 */
export const EVENT_LOGS = ['System', 'Application', 'Security', 'Setup'] as const;
export const eventLogName = z.enum(EVENT_LOGS);
export type EventLogName = z.infer<typeof eventLogName>;

export const EVENT_LEVELS = ['critical', 'error', 'warning', 'information', 'verbose'] as const;
export const eventLevel = z.enum(EVENT_LEVELS);
export type EventLevel = z.infer<typeof eventLevel>;

/** Events returned at once. Past this the answer says it was truncated. */
export const MAX_EVENTS = 200;

/** Characters of one event's message. Beyond this it is cut, and the answer says so. */
export const MAX_EVENT_MESSAGE = 4000;

export const eventLogQueryCommand = z.object({
  type: z.literal('eventlog.query'),
  payload: z.object({
    log: eventLogName,
    /**
     * The least severe level to include.
     *
     * Defaults to warnings and worse, because that is what somebody looking for a problem
     * wants and because `information` on a busy machine is thousands of rows of nothing.
     */
    minimumLevel: eventLevel.default('warning'),
    /** How far back to look. A day by default; a week is the most WOLF will scan. */
    withinHours: z.number().int().min(1).max(168).default(24),
    limit: z.number().int().min(1).max(MAX_EVENTS).default(100),
    /** Only events from this provider — `Microsoft-Windows-Kernel-Power`, say. */
    provider: z.string().max(256).optional(),
    /** Only this event id, for somebody who already knows what they are looking for. */
    eventId: z.number().int().min(0).max(65535).optional(),
  }),
});

/* --------------------------------------------------------------------------- */
/* Hardware                                                                     */
/* --------------------------------------------------------------------------- */

export const hardwareInventoryCommand = z.object({
  type: z.literal('hardware.inventory'),
  payload: z.object({
    /**
     * Include serial numbers of the machine and its parts.
     *
     * Off by default. They are what an inventory is *for* — matching a machine to a purchase
     * order, a warranty, an asset register — and they are also a stable identifier for a
     * physical object, so taking them is a deliberate act rather than a side effect of asking
     * what a PC is made of.
     */
    includeSerialNumbers: z.boolean().default(false),
  }),
});

export const diagnosticsCommand = z.discriminatedUnion('type', [
  networkInfoCommand,
  networkTestCommand,
  eventLogQueryCommand,
  hardwareInventoryCommand,
]);

export type DiagnosticsCommand = z.infer<typeof diagnosticsCommand>;

/**
 * Whether a target is one WOLF will probe at all.
 *
 * Almost everything is. What is refused is the small set that turns one probe into many —
 * broadcast and multicast — because those are the shapes that make a single command touch
 * every machine on a segment.
 */
export function isProbeableTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.length === 0) return false;

  // The all-ones broadcast, and the 255.255.255.255 form of it.
  if (trimmed === '255.255.255.255' || trimmed === '0.0.0.0') return false;

  const parts = trimmed.split('.');

  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255)) return false;

    // 224.0.0.0/4 is multicast: one packet, every listener on the segment.
    if (octets[0]! >= 224 && octets[0]! <= 239) return false;

    // A trailing .255 is the broadcast address of most ordinary /24s. WOLF cannot know the
    // mask from here, so it treats the common case as a broadcast rather than probing it.
    if (octets[3] === 255) return false;
  }

  // IPv6 multicast is anything in ff00::/8.
  if (/^ff[0-9a-f]{2}:/i.test(trimmed)) return false;

  return true;
}

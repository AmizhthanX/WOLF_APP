/**
 * Waking a PC from the dashboard: which of the owner's PCs can send the packet, and what to say about it.
 *
 * A sleeping PC cannot hear a command, so the wake is sent to another PC that is online and broadcasts a
 * magic packet on its own local networks. WOLF cannot tell which PCs share a network — it never learns
 * anybody's LAN layout — so the owner chooses the sender, and the page says that it has to be on the same
 * network as the one asleep.
 */

/** The parts of a PC this needs. Structural, so the dashboard's own PC type fits. */
export interface WakeablePc {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly remoteAccessEnabled: boolean;
  readonly capabilities: {
    readonly wakeOnLanCapable: boolean;
    readonly wakeAddressKnown?: boolean;
    readonly supportedCommands: readonly string[];
  } | null;
}

export type WakeReadiness =
  | { readonly kind: 'online' }
  | { readonly kind: 'switched-off' }
  | { readonly kind: 'no-address' }
  /** An address is known, but Windows on that PC had not armed the adapter the last time it connected. */
  | { readonly kind: 'not-armed' }
  | { readonly kind: 'ready' };

export function wakeReadiness(target: WakeablePc): WakeReadiness {
  if (target.status === 'online') return { kind: 'online' };
  if (!target.remoteAccessEnabled) return { kind: 'switched-off' };
  if (!target.capabilities?.wakeAddressKnown) return { kind: 'no-address' };
  if (!target.capabilities.wakeOnLanCapable) return { kind: 'not-armed' };
  return { kind: 'ready' };
}

/** The owner's other PCs that can send a wake packet right now, by name. */
export function wakeSenders<T extends WakeablePc>(target: WakeablePc, pcs: readonly T[]): T[] {
  return pcs
    .filter((pc) => pc.id !== target.id)
    .filter((pc) => pc.status === 'online' && pc.remoteAccessEnabled)
    .filter((pc) => pc.capabilities?.supportedCommands.includes('power.wake') === true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface WakeResult {
  readonly packetsSent: number;
  readonly networks: number;
}

/** What was done, and only that: a broadcast cannot know whether anything woke. */
export function wakeSentText(sender: string, target: string, result: WakeResult): string {
  const packets = `${result.packetsSent} wake packet${result.packetsSent === 1 ? '' : 's'}`;
  const networks = `${result.networks} local network${result.networks === 1 ? '' : 's'}`;
  return (
    `${sender} sent ${packets} for ${target} across ${networks}. ` +
    `WOLF shows ${target} online when its agent connects, usually within a minute of it waking. ` +
    `If it does not, it may be on a different network from ${sender}, or its firmware may not allow waking.`
  );
}

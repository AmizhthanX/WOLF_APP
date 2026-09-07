import type { SignalEnvelope } from '@wolf/protocol';

/**
 * Registry of live agent links held by this instance.
 *
 * A PC connects to exactly one realtime instance at a time, but nothing prevents a
 * reconnect from landing elsewhere, so the registry is authoritative only for "is this PC
 * connected *here*". Cross-instance delivery works because commands are durable rows and
 * every instance listens for the same notification; an instance that does not hold the PC
 * simply finds nothing to claim.
 */
export interface AgentLinkHandle {
  readonly pcId: string;
  readonly userId: string;
  readonly connectedAt: Date;
  /** Deliver any commands waiting for this PC. */
  deliverPending(): Promise<void>;
  /** Deliver a client signaling message to this agent. */
  sendSignal(envelope: SignalEnvelope, deviceId: string, capabilities?: readonly string[]): void;
  /** Tell the agent that remote access was disabled. */
  notifyKillSwitch(enabled: boolean): void;
  close(reason: string): void;
}

export class AgentRegistry {
  private readonly links = new Map<string, AgentLinkHandle>();

  /**
   * Register a link, displacing any existing one for the same PC.
   *
   * A second connection for one PC means the first is stale (a network drop the agent has
   * not noticed yet). Keeping both would double-deliver every command.
   */
  add(link: AgentLinkHandle): void {
    const existing = this.links.get(link.pcId);
    if (existing && existing !== link) {
      existing.close('replaced-by-new-connection');
    }
    this.links.set(link.pcId, link);
  }

  remove(link: AgentLinkHandle): void {
    if (this.links.get(link.pcId) === link) {
      this.links.delete(link.pcId);
    }
  }

  get(pcId: string): AgentLinkHandle | null {
    return this.links.get(pcId) ?? null;
  }

  get size(): number {
    return this.links.size;
  }

  connectedPcIds(): string[] {
    return [...this.links.keys()];
  }

  closeAll(reason: string): void {
    for (const link of this.links.values()) link.close(reason);
    this.links.clear();
  }
}

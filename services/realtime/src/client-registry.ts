import type { SignalEnvelope } from '@wolf/protocol';

/**
 * Client links held by this instance, indexed by session.
 *
 * Signaling is routed by session id rather than by user or PC, because that is the unit
 * authorization is granted against: two browsers watching the same PC are two sessions,
 * with two capability grants, and a message for one must never surface in the other.
 */
export interface ClientLinkHandle {
  readonly sessionId: string;
  readonly pcId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly connectedAt: Date;
  /** Deliver a signaling message that arrived from the agent. */
  deliverSignal(envelope: SignalEnvelope): void;
  /** Tell the client the far side went away, so it stops waiting for an answer. */
  notifyPeerGone(reason: 'agent-disconnected' | 'session-ended' | 'kill-switch', detail: string): void;
  close(reason: string): void;
}

export class ClientRegistry {
  private readonly bySession = new Map<string, ClientLinkHandle>();
  /** Secondary index so an agent disconnect can find every affected client at once. */
  private readonly byPc = new Map<string, Set<string>>();

  add(link: ClientLinkHandle): void {
    const existing = this.bySession.get(link.sessionId);
    if (existing && existing !== link) {
      // One session, one client socket. A second connection means the first is stale;
      // keeping both would fork the signaling exchange.
      existing.close('replaced-by-new-connection');
    }

    this.bySession.set(link.sessionId, link);

    let sessions = this.byPc.get(link.pcId);
    if (!sessions) {
      sessions = new Set();
      this.byPc.set(link.pcId, sessions);
    }
    sessions.add(link.sessionId);
  }

  remove(link: ClientLinkHandle): void {
    if (this.bySession.get(link.sessionId) === link) {
      this.bySession.delete(link.sessionId);
    }

    const sessions = this.byPc.get(link.pcId);
    if (sessions) {
      sessions.delete(link.sessionId);
      if (sessions.size === 0) this.byPc.delete(link.pcId);
    }
  }

  get(sessionId: string): ClientLinkHandle | null {
    return this.bySession.get(sessionId) ?? null;
  }

  forPc(pcId: string): ClientLinkHandle[] {
    const sessions = this.byPc.get(pcId);
    if (!sessions) return [];

    const links: ClientLinkHandle[] = [];
    for (const sessionId of sessions) {
      const link = this.bySession.get(sessionId);
      if (link) links.push(link);
    }
    return links;
  }

  get size(): number {
    return this.bySession.size;
  }

  /** Every client held here, for liveness pings and shutdown. */
  all(): ClientLinkHandle[] {
    return [...this.bySession.values()];
  }

  closeAll(reason: string): void {
    for (const link of this.bySession.values()) link.close(reason);
    this.bySession.clear();
    this.byPc.clear();
  }
}

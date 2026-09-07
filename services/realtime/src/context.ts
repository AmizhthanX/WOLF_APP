import type { TokenSigner } from '@wolf/auth';
import type { ServerContext } from '@wolf/server-core';
import type { AgentRegistry } from './registry.js';
import type { ClientRegistry } from './client-registry.js';

/**
 * The shared server context plus what only the realtime service needs.
 *
 * It verifies session tokens itself rather than asking the API, because a signaling
 * message must be authorized on the socket that carries it — a round trip per message
 * would be both slower and a second place for the check to be forgotten.
 */
export interface RealtimeContext extends ServerContext {
  readonly signer: TokenSigner;
  readonly agents: AgentRegistry;
  readonly clients: ClientRegistry;
}

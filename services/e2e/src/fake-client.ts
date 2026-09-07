import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type SignalEnvelope, type SignalPayload } from '@wolf/protocol';

/**
 * A stand-in browser, speaking the real client signaling protocol.
 *
 * It exists so the end-to-end suite can assert on what the relay accepts and refuses
 * without driving an actual browser. The browser's own WebRTC behaviour is not what these
 * tests are about — the authorization boundary between an authenticated user and a live
 * desktop is.
 */
export interface FakeClientOptions {
  readonly url: string;
  readonly sessionToken: string;
}

export interface AuthOutcome {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly detail?: string;
  readonly sessionId?: string;
  readonly pcId?: string;
  readonly agentConnected?: boolean;
}

export class FakeClient {
  private socket: WebSocket | null = null;

  /** Signaling messages the relay delivered to this client. */
  readonly received: SignalEnvelope[] = [];
  /** Peer-gone notices, so a test can assert the client was told rather than left waiting. */
  readonly peerGone: { reason: string; detail: string }[] = [];
  /** Set when the socket closes, with the code the relay used. */
  closedWith: number | null = null;

  constructor(private readonly options: FakeClientOptions) {}

  /** Connect and authenticate. Resolves with the outcome rather than throwing on refusal. */
  async connect(): Promise<AuthOutcome> {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    return new Promise<AuthOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client handshake timed out')), 8000);

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            kind: 'client.auth',
            protocolVersion: PROTOCOL_VERSION,
            sessionToken: this.options.sessionToken,
          }),
        );
      });

      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;

        switch (message['kind']) {
          case 'cloud.client-auth-accepted':
            clearTimeout(timer);
            resolve({
              accepted: true,
              sessionId: String(message['sessionId']),
              pcId: String(message['pcId']),
              agentConnected: message['agentConnected'] === true,
            });
            break;

          case 'cloud.client-auth-rejected':
            clearTimeout(timer);
            resolve({
              accepted: false,
              reason: String(message['reason']),
              detail: String(message['detail']),
            });
            break;

          case 'cloud.signal':
            this.received.push(message['envelope'] as SignalEnvelope);
            break;

          case 'cloud.peer-gone':
            this.peerGone.push({
              reason: String(message['reason']),
              detail: String(message['detail']),
            });
            break;

          default:
            break;
        }
      });

      socket.on('close', (code) => {
        this.closedWith = code;
        clearTimeout(timer);
        // A socket closed before any reply is itself the outcome.
        resolve({ accepted: false, reason: 'closed', detail: `socket closed with ${code}` });
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Send a signaling payload inside an envelope of the caller's choosing. */
  sendSignal(sessionId: string, streamId: string, payload: SignalPayload): void {
    this.socket?.send(
      JSON.stringify({
        kind: 'client.signal',
        protocolVersion: PROTOCOL_VERSION,
        envelope: {
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          streamId,
          sentAt: new Date().toISOString(),
          payload,
        },
      }),
    );
  }

  /** Send an arbitrary object, for testing what the relay refuses. */
  sendRaw(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** Wait for a signaling payload of a given type, or fail after `timeoutMs`. */
  async waitForSignal(type: string, timeoutMs = 4000): Promise<SignalEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find((envelope) => envelope.payload.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for a "${type}" signal`);
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

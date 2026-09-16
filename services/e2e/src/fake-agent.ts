import { WebSocket } from 'ws';
import { signPayload, type IdentityKeyPair } from '@wolf/auth';
import {
  PROTOCOL_VERSION,
  challengeSigningPayload,
  type SignalEnvelope,
  type SignalPayload,
} from '@wolf/protocol';

/**
 * A stand-in Windows agent.
 *
 * It speaks the real protocol — the same challenge/response, the same message shapes — but
 * runs in Node so the end-to-end test can assert on the whole path without a Windows host.
 * The Windows agent's own behaviour is covered by its .NET test suite; what this proves is
 * that the cloud accepts a correctly-behaving agent and rejects a misbehaving one.
 */
export interface FakeAgentOptions {
  readonly url: string;
  readonly pcId: string;
  readonly keys: IdentityKeyPair;
  readonly supportedCommands: readonly string[];
  /** Capability fields to report in place of the defaults. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Produce the result payload for a command, or throw to report a failure. */
  readonly onCommand?: (type: string, payload: unknown) => unknown;
  /** Called for every signaling envelope the cloud routes to this agent. */
  readonly onSignal?: (envelope: SignalEnvelope, agent: FakeAgent) => void;
}

export class FakeAgent {
  private socket: WebSocket | null = null;
  private authenticated = false;

  readonly received: { type: string; payload: unknown }[] = [];
  /** Signaling envelopes the cloud routed to this agent. */
  readonly signalsReceived: SignalEnvelope[] = [];
  readonly signalMessagesReceived: Record<string, unknown>[] = [];

  constructor(private readonly options: FakeAgentOptions) {}

  /** Connect and complete the handshake, resolving once the cloud has accepted the hello. */
  async connect(): Promise<void> {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent handshake timed out')), 8000);

      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;

        switch (message['kind']) {
          case 'cloud.challenge': {
            const nonce = String(message['nonce']);
            this.send({
              kind: 'agent.auth',
              protocolVersion: PROTOCOL_VERSION,
              pcId: this.options.pcId,
              agentVersion: '0.1.0-e2e',
              nonce,
              signature: signPayload(
                this.options.keys.privateKey,
                challengeSigningPayload(this.options.pcId, nonce),
              ),
            });
            break;
          }

          case 'cloud.auth-accepted': {
            this.authenticated = true;
            this.sendHello();
            clearTimeout(timer);
            // The hello is fire-and-forget; give the cloud a moment to persist it.
            setTimeout(resolve, 150);
            break;
          }

          case 'cloud.auth-rejected': {
            clearTimeout(timer);
            reject(new Error(`auth rejected: ${String(message['reason'])}`));
            break;
          }

          case 'cloud.command': {
            this.handleCommand(message['envelope'] as Record<string, unknown>);
            break;
          }

          case 'cloud.signal': {
            const envelope = message['envelope'] as SignalEnvelope;
            this.signalsReceived.push(envelope);
            // The whole message, not just the envelope: the relay attaches the ICE servers
            // beside it, and a test that only saw the envelope could not tell whether the
            // agent was given a relay or left to guess.
            this.signalMessagesReceived.push(message);
            this.options.onSignal?.(envelope, this);
            break;
          }

          default:
            break;
        }
      });
    });
  }

  private sendHello(): void {
    this.send({
      kind: 'agent.hello',
      protocolVersion: PROTOCOL_VERSION,
      sessionState: 'desktop',
      localKillSwitchEngaged: false,
      queuedResultCount: 0,
      info: {
        hostname: 'E2E-PC',
        osName: 'Windows 11 Pro',
        osVersion: '10.0.26100',
        osBuild: '26100.1',
        architecture: 'X64',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryBytes: 34_359_738_368,
        gpus: ['Test GPU'],
        bootedAt: new Date(Date.now() - 3_600_000).toISOString(),
        agentVersion: '0.1.0-e2e',
      },
      capabilities: {
        hardwareVideoEncoders: [],
        preferredVideoCodec: null,
        displayCount: 1,
        audioCaptureAvailable: false,
        wakeOnLanCapable: false,
        privilegedHelperAvailable: false,
        secureDesktopCaptureAvailable: false,
        remoteUnlockProvisioned: false,
        gpuVendors: ['Test'],
        windowsBuild: '26100.1',
        supportedCommands: [...this.options.supportedCommands],
        ...this.options.capabilities,
      },
    });
  }

  private handleCommand(envelope: Record<string, unknown>): void {
    const command = envelope['command'] as { type: string; payload: unknown };
    this.received.push({ type: command.type, payload: command.payload });

    const startedAt = new Date().toISOString();
    let result: unknown = null;
    let failure: unknown = null;

    try {
      result = this.options.onCommand?.(command.type, command.payload) ?? null;
    } catch (error) {
      failure = {
        code: 'agent-error',
        message: error instanceof Error ? error.message : 'unknown',
        limitation: false,
        recommendedAction: null,
      };
    }

    this.send({
      kind: 'agent.command-result',
      protocolVersion: PROTOCOL_VERSION,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        commandId: envelope['commandId'],
        status: failure ? 'failed' : 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
        failure,
        result,
        agentVersion: '0.1.0-e2e',
      },
    });
  }

  sendTelemetry(usagePercent: number): void {
    this.send({
      kind: 'agent.telemetry',
      protocolVersion: PROTOCOL_VERSION,
      batch: {
        backfill: false,
        samples: [
          {
            sampledAt: new Date().toISOString(),
            uptimeSeconds: 3600,
            cpu: {
              usagePercent,
              perCorePercent: [],
              frequencyMhz: null,
              temperatureCelsius: null,
              queueLength: null,
              packagePowerWatts: null,
            },
            memory: {
              totalBytes: 34_359_738_368,
              usedBytes: 8_589_934_592,
              availableBytes: 25_769_803_776,
              committedBytes: null,
              commitLimitBytes: null,
              cachedBytes: null,
            },
            gpus: [],
            disks: [],
            networks: [],
            thermal: [],
            battery: null,
            agent: null,
          },
        ],
      },
    });
  }

  /** Send a signaling payload back towards the client. */
  sendSignal(sessionId: string, streamId: string, payload: SignalPayload): void {
    this.send({
      kind: 'agent.signal',
      protocolVersion: PROTOCOL_VERSION,
      envelope: {
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        streamId,
        sentAt: new Date().toISOString(),
        payload,
      },
    });
  }

  /**
   * Wait for the whole relayed message, including what the relay attached to it.
   *
   * A stream id is worth passing whenever the assertion is about *this* request: one agent
   * serves every test in a file, so matching on type alone finds whichever request came
   * first and quietly asserts against the wrong one.
   */
  async waitForSignalMessage(
    type: string,
    streamId?: string,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.signalMessagesReceived.find((message) => {
        const envelope = message['envelope'] as SignalEnvelope | undefined;
        if (envelope?.payload.type !== type) return false;
        return streamId === undefined || envelope.streamId === streamId;
      });

      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`timed out waiting for a "${type}" message`);
  }

  /** Wait for a signaling payload of a given type, or fail after `timeoutMs`. */
  async waitForSignal(type: string, timeoutMs = 4000): Promise<SignalEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.signalsReceived.find((envelope) => envelope.payload.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for a "${type}" signal`);
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

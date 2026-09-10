import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

/**
 * The browser's half of the signaling exchange.
 *
 * WebSocket and RTCPeerConnection are replaced with recorders, not because the real ones
 * are hard to use but because what is worth checking here is the *conversation*: the exact
 * messages this client sends, in what order, and what it does with what comes back. A test
 * against a live peer would prove the browser's WebRTC stack works, which is not in doubt.
 *
 * These stand in for the cloud relay, so every message asserted here is one the relay
 * validates against the protocol schema in production. A shape this file gets wrong is a
 * stream that is refused at the relay.
 */

interface Sent {
  kind: string;
  [key: string]: unknown;
}

const sent: Sent[] = [];
let socketHandlers: Record<string, ((event: unknown) => void)[]> = {};
let peerHandlers: Record<string, ((event: unknown) => void)[]> = {};
let peerCreated = 0;
let peers: FakePeerConnection[] = [];
let sentOnChannel: string[] = [];
let channelListeners: ((event: { data: string }) => void)[] = [];
let remoteDescriptions: { type: string; sdp: string }[] = [];
let addedCandidates: unknown[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    queueMicrotask(() => this.fire('open', {}));
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    (socketHandlers[name] ??= []).push(handler);
  }

  send(raw: string): void {
    sent.push(JSON.parse(raw) as Sent);
  }

  close(): void {
    this.readyState = 3;
  }

  fire(name: string, event: unknown): void {
    for (const handler of socketHandlers[name] ?? []) handler(event);
  }
}

class FakePeerConnection {
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;

  constructor(readonly configuration: unknown) {
    peerCreated++;
    peers.push(this);
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    (peerHandlers[name] ??= []).push(handler);
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    remoteDescriptions.push(description);
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\r\nANSWER\r\n' };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    addedCandidates.push(candidate);
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }

  close(): void {
    this.connectionState = 'closed';
  }

  /**
   * Stand in for the control channel the agent opens as part of its offer.
   *
   * The browser receives this channel rather than creating one, so the test has to deliver
   * it the same way the real peer connection would.
   */
  openControlChannel(): void {
    const channel = {
      readyState: 'open',
      send: (data: string) => sentOnChannel.push(data),
      addEventListener: (_name: string, handler: (event: { data: string }) => void) =>
        channelListeners.push(handler),
    };

    for (const handler of peerHandlers['datachannel'] ?? []) handler({ channel });
  }
}

function fire(name: string, event: unknown): void {
  for (const handler of peerHandlers[name] ?? []) handler(event);
}

function socketMessage(payload: unknown): void {
  for (const handler of socketHandlers['message'] ?? []) {
    handler({ data: JSON.stringify(payload) });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals['WebSocket'] = FakeWebSocket;
globals['RTCPeerConnection'] = FakePeerConnection;
globals['performance'] ??= { now: () => Date.now() };

const { RemoteDesktopStream, decodableCodecs, MAX_TERMINAL_CHUNK } = await import(
  './remote-desktop.js'
);

const OFFER_SDP = 'v=0\r\nOFFER\r\n';

const PROFILE = {
  name: 'Test',
  maxWidthPixels: null,
  maxHeightPixels: null,
  targetFps: 30,
  minBitrateBps: 1_000_000,
  maxBitrateBps: 8_000_000,
  codecPreference: [],
  audioEnabled: false,
  qualityBias: 'balanced' as const,
  adaptive: true,
  overrides: { bitrateBps: null, frameRate: null, resolutionScale: null },
};

interface Recorded {
  phases: string[];
  negotiations: unknown[];
  errors: { code: string; message: string }[];
  tracks: unknown[];
  control: { granted: boolean; reason: string | null }[];
  degraded: (string | null)[];
  surfaces: { surface: string; detail: string | null }[];
  terminalControl: { granted: boolean; reason: string | null }[];
  terminal: { kind: string; terminalId: string; data: string | null; detail: string | null }[];
  clipboard: { kind: string; text: string | null; detail: string | null }[];
}

function makeStream(requestAudio = false) {
  const recorded: Recorded = {
    phases: [],
    negotiations: [],
    errors: [],
    tracks: [],
    control: [],
    degraded: [],
    surfaces: [],
    terminalControl: [],
    terminal: [],
    clipboard: [],
  };

  const stream = new RemoteDesktopStream({
    realtimeUrl: 'ws://realtime.test',
    sessionToken: 'a-session-token',
    iceServers: [],
    profile: PROFILE,
    displayId: null,
    requestAudio,
    events: {
      onPhase: (phase) => recorded.phases.push(phase),
      onTrack: (track) => recorded.tracks.push(track),
      onNegotiation: (negotiation) => recorded.negotiations.push(negotiation),
      onAgentStats: () => {},
      onClientStats: () => {},
      onError: (error) => recorded.errors.push({ code: error.code, message: error.message }),
      onInputControl: (control) =>
        recorded.control.push({ granted: control.granted, reason: control.reason }),
      onDegraded: (reason) => recorded.degraded.push(reason),
      onSurface: (surface, detail) => recorded.surfaces.push({ surface, detail }),
      onTerminalControl: (control) =>
        recorded.terminalControl.push({ granted: control.granted, reason: control.reason }),
      onTerminal: (event) =>
        recorded.terminal.push({
          kind: event.kind,
          terminalId: event.terminalId,
          data: event.data,
          detail: event.detail,
        }),
      onClipboard: (event) =>
        recorded.clipboard.push({ kind: event.kind, text: event.text, detail: event.detail }),
    },
  });

  return { stream, recorded };
}

function lastOfKind(kind: string): Sent | undefined {
  return [...sent].reverse().find((message) => message.kind === kind);
}

function signalsOfType(type: string): Record<string, unknown>[] {
  return sent
    .filter((message) => message.kind === 'client.signal')
    .map((message) => (message['envelope'] as { payload: Record<string, unknown> }).payload)
    .filter((payload) => payload['type'] === type);
}

/** Take a stream all the way to an accepted session and a sent request. */
async function authenticate(stream: InstanceType<typeof RemoteDesktopStream>): Promise<void> {
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  socketMessage({
    kind: 'cloud.client-auth-accepted',
    sessionId: 'SESSION-1',
    pcId: 'PC-1',
    capabilities: ['screen'],
    agentConnected: true,
    serverTime: new Date().toISOString(),
  });
}

beforeEach(() => {
  sent.length = 0;
  socketHandlers = {};
  peerHandlers = {};
  remoteDescriptions = [];
  addedCandidates = [];
  peerCreated = 0;
  peers = [];
  sentOnChannel = [];
  channelListeners = [];
});

test('the session token is the first thing sent, and nothing else precedes it', async () => {
  const { stream } = makeStream();
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The relay closes a socket that says anything before it authenticates, so ordering here
  // is not cosmetic.
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'client.auth');
  assert.equal(sent[0]?.['sessionToken'], 'a-session-token');
  assert.equal(sent[0]?.['protocolVersion'], 1);

  stream.stop();
});

test('a stream request is sent once the session is accepted, naming what this browser can decode', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  const requests = signalsOfType('stream.request');
  assert.equal(requests.length, 1);

  const request = requests[0]?.['request'] as Record<string, unknown>;
  assert.deepEqual(request['profile'], PROFILE);
  assert.equal(request['displayId'], null);

  // Codecs are reported, not assumed. The agent refuses rather than guessing when there is
  // no overlap, so an empty or wrong list here produces a stream that never starts.
  assert.ok(Array.isArray(request['clientCodecs']));
  assert.ok((request['clientCodecs'] as string[]).includes('h264'));

  // Audio is not captured by any agent build yet; asking for it would earn an adjustment
  // saying no, which is noise rather than information.
  assert.equal(request['requestAudio'], false);

  stream.stop();
});

test('an offer is answered, and the answer goes back on the same stream id', async () => {
  const { stream, recorded } = makeStream();
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.ready',
        negotiation: { streamId: stream.id, videoCodec: 'h264', adjustments: [] },
      },
    },
  });

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: { type: 'sdp.offer', sdp: 'v=0\r\nOFFER\r\n' },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(recorded.negotiations.length, 1);
  assert.equal(peerCreated, 1);
  assert.equal(remoteDescriptions[0]?.type, 'offer');

  const answers = signalsOfType('sdp.answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.['sdp'], 'v=0\r\nANSWER\r\n');

  const envelope = lastOfKind('client.signal')?.['envelope'] as { streamId: string; sessionId: string };
  assert.equal(envelope.streamId, stream.id);
  assert.equal(envelope.sessionId, 'SESSION-1');

  stream.stop();
});

test('signaling for another stream in the same session is ignored', async () => {
  const { stream, recorded } = makeStream();
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: 'SOMEBODY-ELSES-STREAM',
      payload: { type: 'sdp.offer', sdp: 'v=0\r\nNOT-OURS\r\n' },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  // One session can hold several streams — a second display, say. Answering another
  // stream's offer would hijack it.
  assert.equal(peerCreated, 0);
  assert.equal(remoteDescriptions.length, 0);
  assert.equal(recorded.errors.length, 0);

  stream.stop();
});

test('local candidates are trickled, and the end of gathering is announced', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: { streamId: stream.id, payload: { type: 'sdp.offer', sdp: 'v=0\r\nOFFER\r\n' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  fire('icecandidate', {
    candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  });
  fire('icecandidate', { candidate: null });

  const candidates = signalsOfType('ice.candidate');
  assert.equal(candidates.length, 1);
  assert.match(String(candidates[0]?.['candidate']), /typ host/);
  assert.equal(candidates[0]?.['sdpMid'], '0');

  // A null candidate means gathering finished. Saying so lets the agent stop waiting.
  assert.equal(signalsOfType('ice.complete').length, 1);

  stream.stop();
});

test('a remote candidate is applied to the peer connection', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: { streamId: stream.id, payload: { type: 'sdp.offer', sdp: 'v=0\r\nOFFER\r\n' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'ice.candidate',
        candidate: 'candidate:2 1 udp 1 192.168.1.5 6000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(addedCandidates.length, 1);

  stream.stop();
});

test('a PC that is offline is reported rather than waited on', async () => {
  const { stream, recorded } = makeStream();
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  socketMessage({
    kind: 'cloud.client-auth-accepted',
    sessionId: 'SESSION-1',
    pcId: 'PC-1',
    capabilities: ['screen'],
    agentConnected: false,
    serverTime: new Date().toISOString(),
  });

  assert.equal(recorded.errors[0]?.code, 'agent-offline');
  assert.ok(recorded.phases.includes('failed'));

  // Nothing was requested: asking a PC that is not there for its screen would leave the
  // operator watching a spinner.
  assert.equal(signalsOfType('stream.request').length, 0);

  stream.stop();
});

test('a refused session says why instead of closing silently', async () => {
  const { stream, recorded } = makeStream();
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  socketMessage({
    kind: 'cloud.client-auth-rejected',
    reason: 'capability-missing',
    detail: 'This session does not hold the screen capability.',
  });

  assert.equal(recorded.errors[0]?.code, 'capability-missing');
  assert.match(recorded.errors[0]?.message ?? '', /screen capability/);
  assert.ok(recorded.phases.includes('failed'));
});

test('an agent error during a running stream reports without ending it', async () => {
  const { stream, recorded } = makeStream();
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: { streamId: stream.id, payload: { type: 'sdp.offer', sdp: 'v=0\r\nOFFER\r\n' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.state',
        state: 'STREAMING',
        unavailableReason: null,
        detail: null,
      },
    },
  });

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.error',
        code: 'input-unavailable',
        message: 'This build cannot send input.',
        limitation: false,
        recommendedAction: null,
      },
    },
  });

  // The picture is still arriving. An error about a feature that is missing must not tear
  // down a stream that is working.
  assert.equal(recorded.errors.at(-1)?.code, 'input-unavailable');
  assert.equal(recorded.phases.at(-1), 'streaming');

  stream.stop();
});

test('stopping tells the agent, so the PC stops capturing', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  stream.stop();

  const stops = signalsOfType('stream.stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0]?.['reason'], 'client-closed');
});

test('a profile change is sent to the agent rather than applied locally', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  stream.setProfile({ ...PROFILE, maxBitrateBps: 2_000_000, targetFps: 24 });

  const changes = signalsOfType('stream.set-profile');
  assert.equal(changes.length, 1);

  const profile = changes[0]?.['profile'] as Record<string, unknown>;
  assert.equal(profile['maxBitrateBps'], 2_000_000);
  assert.equal(profile['targetFps'], 24);

  stream.stop();
});

test('with no codec capabilities to read, H.264 is claimed and nothing more', () => {
  // Every WebRTC implementation is required to decode H.264, so it is a floor rather than
  // a guess. Claiming AV1 without evidence would negotiate a stream that renders nothing.
  const previous = globals['RTCRtpReceiver'];
  delete globals['RTCRtpReceiver'];

  try {
    assert.deepEqual(decodableCodecs(), ['h264']);
  } finally {
    if (previous !== undefined) globals['RTCRtpReceiver'] = previous;
  }
});

test('codecs are read from what the browser reports, in WOLF preference order', () => {
  globals['RTCRtpReceiver'] = {
    getCapabilities: () => ({
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/H264' },
        { mimeType: 'video/AV1' },
      ],
    }),
  };

  try {
    // AV1 first because it is the best of the three where both ends have it; VP8 last.
    // The agent still only offers what it can encode, so this is a preference, not a demand.
    assert.deepEqual(decodableCodecs(), ['av1', 'h264', 'vp8']);
  } finally {
    delete globals['RTCRtpReceiver'];
  }
});

/* ------------------------------------------------------------------------- */
/* Input                                                                      */
/* ------------------------------------------------------------------------- */

/** Take a stream to a peer connection with the agent's control channel open. */
async function connectWithControlChannel(
  stream: InstanceType<typeof RemoteDesktopStream>,
): Promise<void> {
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: { streamId: stream.id, payload: { type: 'sdp.offer', sdp: OFFER_SDP } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  peers.at(-1)?.openControlChannel();
}

/** Deliver a message on the control channel, the way the agent would. */
function deliverControl(message: unknown): void {
  for (const handler of channelListeners) handler({ data: JSON.stringify(message) });
}

function grantControl(streamId: string, granted: boolean, reason: string): void {
  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId,
      payload: {
        type: 'input.control',
        granted,
        holderSessionId: granted ? 'SESSION-1' : null,
        expiresAt: granted ? new Date(Date.now() + 120_000).toISOString() : null,
        reason,
      },
    },
  });
}

test('input is not sent before the cloud has granted control', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  stream.sendInput([{ type: 'pointer.move', x: 0.5, y: 0.5, offsetMs: 0 }]);

  // The default is no. A client that sent input on the strength of having a data channel
  // would be deciding for itself that it may drive somebody else's PC.
  assert.equal(sentOnChannel.length, 0);

  stream.stop();
});

test('asking for control sends a request, and asking is not the same as having', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  stream.requestControl();
  assert.equal(signalsOfType('input.request').length, 1);

  stream.sendInput([{ type: 'pointer.move', x: 0.5, y: 0.5, offsetMs: 0 }]);
  assert.equal(sentOnChannel.length, 0);

  stream.stop();
});

test('once control is granted, input goes down the data channel in protocol shape', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  grantControl(stream.id, true, 'granted');
  assert.equal(recorded.control.at(-1)?.granted, true);

  stream.sendInput([
    { type: 'pointer.move', x: 0.25, y: 0.75, offsetMs: 0 },
    { type: 'key', key: 0x41, action: 'down', scanCode: null, extended: false, offsetMs: 4 },
  ]);

  assert.equal(sentOnChannel.length, 1);
  const message = JSON.parse(sentOnChannel[0]!) as Record<string, unknown>;
  const batch = message['batch'] as Record<string, unknown>;

  // The host validates this itself — nothing upstream sees it — so a shape wrong here is
  // refused at the far end with nothing to explain why.
  assert.equal(message['kind'], 'input');
  assert.equal(batch['streamId'], stream.id);
  assert.equal(typeof batch['sequence'], 'number');
  assert.equal(typeof batch['sentAt'], 'string');
  assert.equal((batch['events'] as unknown[]).length, 2);

  stream.stop();
});

test('losing control stops input immediately', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  grantControl(stream.id, true, 'granted');
  stream.sendInput([{ type: 'pointer.move', x: 0.5, y: 0.5, offsetMs: 0 }]);
  assert.equal(sentOnChannel.length, 1);

  grantControl(stream.id, false, 'held-by-another-session');
  stream.sendInput([{ type: 'pointer.move', x: 0.5, y: 0.5, offsetMs: 0 }]);

  // Somebody else is driving now. Continuing to send would be this client fighting them
  // for the pointer.
  assert.equal(sentOnChannel.length, 1);
  assert.equal(recorded.control.at(-1)?.reason, 'held-by-another-session');

  stream.stop();
});

test('a batch larger than the protocol allows is trimmed before it is sent', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);
  grantControl(stream.id, true, 'granted');

  stream.sendInput(
    Array.from({ length: 300 }, () => ({
      type: 'pointer.move' as const,
      x: 0.5,
      y: 0.5,
      offsetMs: 0,
    })),
  );

  const batch = (JSON.parse(sentOnChannel[0]!) as { batch: { events: unknown[] } }).batch;

  // The host refuses an oversized batch whole, so trimming here keeps a burst of pointer
  // movement from discarding the movement that mattered.
  assert.equal(batch.events.length, 128);

  stream.stop();
});

test('a refusal from the PC is surfaced rather than swallowed', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  // The host answers only when something is wrong, so this is the operator's only signal
  // that their clicks are going nowhere.
  deliverControl({
    kind: 'input.response',
    response: {
      streamId: stream.id,
      sequence: 7,
      outcome: 'unsupported',
      reason: 'The window in focus is running as administrator.',
      limitation: true,
    },
  });

  assert.equal(recorded.errors.at(-1)?.code, 'input-unsupported');
  assert.match(recorded.errors.at(-1)?.message ?? '', /administrator/);

  stream.stop();
});

/* ------------------------------------------------------------------------- */
/* Adaptation                                                                 */
/* ------------------------------------------------------------------------- */

test('a degraded stream keeps running and says why', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.state',
        state: 'DEGRADED',
        unavailableReason: null,
        detail: 'packet-loss',
      },
    },
  });

  // The picture is still arriving. Reporting this as a fault would be wrong, and reporting
  // nothing would leave the operator wondering why it went soft.
  assert.equal(recorded.degraded.at(-1), 'packet-loss');
  assert.equal(recorded.phases.at(-1), 'streaming');

  stream.stop();
});

test('recovering to the profile clears the degradation', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  const state = (value: string, detail: string | null) =>
    socketMessage({
      kind: 'cloud.signal',
      envelope: {
        streamId: stream.id,
        payload: { type: 'stream.state', state: value, unavailableReason: null, detail },
      },
    });

  state('DEGRADED', 'bandwidth');
  assert.equal(recorded.degraded.at(-1), 'bandwidth');

  state('STREAMING', null);

  // A badge that stayed up after the stream recovered would train the operator to ignore it.
  assert.equal(recorded.degraded.at(-1), null);

  stream.stop();
});

/* ------------------------------------------------------------------------- */
/* Audio                                                                      */
/* ------------------------------------------------------------------------- */

test('a stream asks for sound only when somebody turned it on', async () => {
  const { stream } = makeStream();
  await authenticate(stream);

  const request = signalsOfType('stream.request')[0]?.['request'] as Record<string, unknown>;

  // Watching a machine is not a decision to start listening to it, so the default is off
  // and the PC is never asked for audio it was not meant to send.
  assert.equal(request['requestAudio'], false);

  stream.stop();
});

test('turning sound on asks the PC for it', async () => {
  const { stream } = makeStream(true);
  await authenticate(stream);

  const request = signalsOfType('stream.request')[0]?.['request'] as Record<string, unknown>;
  assert.equal(request['requestAudio'], true);

  stream.stop();
});

test('a PC that refuses audio says so in the negotiation', async () => {
  const { stream, recorded } = makeStream(true);
  await authenticate(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.ready',
        negotiation: {
          streamId: stream.id,
          videoCodec: 'h264',
          audioCodec: null,
          adjustments: [
            {
              setting: 'audioEnabled',
              requested: 'true',
              applied: 'false',
              reason: 'This session was not granted permission to hear this PC.',
            },
          ],
        },
      },
    },
  });

  const negotiation = recorded.negotiations.at(-1) as { audioCodec: string | null; adjustments: unknown[] };

  // Null rather than an error: the picture still works, and the viewer shows the reason
  // instead of leaving somebody wondering why the stream is silent.
  assert.equal(negotiation.audioCodec, null);
  assert.equal(negotiation.adjustments.length, 1);

  stream.stop();
});

/* ------------------------------------------------------------------------- */
/* Clipboard                                                                  */
/* ------------------------------------------------------------------------- */

test('input is wrapped so the channel can carry more than one kind of message', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);
  grantControl(stream.id, true, 'granted');

  stream.sendInput([{ type: 'pointer.move', x: 0.5, y: 0.5, offsetMs: 0 }]);

  const sent = JSON.parse(String(sentOnChannel.at(-1))) as Record<string, unknown>;

  // Telling input and clipboard apart by which fields happen to be present is the kind of
  // guess that lets a malformed clipboard message be read as a burst of keystrokes.
  assert.equal(sent['kind'], 'input');
  assert.ok(sent['batch']);

  stream.stop();
});

test('clipboard text goes on the data channel, never through the cloud', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  assert.equal(stream.sendClipboard('copied in the browser'), true);

  const message = JSON.parse(String(sentOnChannel.at(-1))) as Record<string, unknown>;
  assert.equal(message['kind'], 'clipboard.content');
  assert.equal(message['text'], 'copied in the browser');
  assert.equal(message['origin'], 'client');

  // Nothing clipboard-shaped went to the relay. Content that never reaches a server cannot
  // be stored by one, which is what makes the promise keepable.
  const overSocket = sent.filter((message: Sent) =>
    JSON.stringify(message).includes('copied in the browser'),
  );
  assert.equal(overSocket.length, 0);

  stream.stop();
});

test('an oversized paste is refused before it is sent', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  const before = sentOnChannel.length;
  assert.equal(stream.sendClipboard('x'.repeat(300_000)), false);

  // Refused here rather than after a round trip, and never truncated: a silently shortened
  // paste is only noticed once whatever was pasted is broken.
  assert.equal(sentOnChannel.length, before);

  stream.stop();
});

test('content offered by the PC is surfaced rather than written to the local clipboard', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  deliverControl({
    kind: 'clipboard.content',
    streamId: stream.id,
    format: 'text',
    text: 'copied on the PC',
    origin: 'pc',
    at: new Date().toISOString(),
  });

  // Handed to the UI, which offers it. A remote machine silently replacing what you copied
  // is not something to do without being asked.
  assert.equal(recorded.clipboard.at(-1)?.kind, 'content');
  assert.equal(recorded.clipboard.at(-1)?.text, 'copied on the PC');

  stream.stop();
});

test('a refusal from the PC is explained rather than dropped', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  deliverControl({
    kind: 'clipboard.refused',
    streamId: stream.id,
    reason: 'not-permitted',
    detail: 'This session was not granted permission to use this PC clipboard.',
  });

  assert.equal(recorded.clipboard.at(-1)?.kind, 'refused');
  assert.match(recorded.clipboard.at(-1)?.detail ?? '', /not granted permission/);

  stream.stop();
});

test('a format WOLF does not carry is named', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  deliverControl({ kind: 'clipboard.unsupported', streamId: stream.id, describes: 'image' });

  // Somebody who copies a screenshot and finds nothing on the other machine should be told
  // images are not moved, not left concluding clipboard sharing is broken.
  assert.equal(recorded.clipboard.at(-1)?.kind, 'unsupported');
  assert.match(recorded.clipboard.at(-1)?.detail ?? '', /image/);

  stream.stop();
});

/* ------------------------------------------------------------------------- */
/* Multiple displays                                                          */
/* ------------------------------------------------------------------------- */

test('switching display asks the PC rather than restarting the stream', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  const before = recorded.phases.length;
  stream.setDisplay('\\.\DISPLAY2');

  const change = signalsOfType('stream.set-display');
  assert.equal(change.length, 1);
  assert.equal(change[0]?.['displayId'], '\\.\DISPLAY2');

  // No teardown: a fresh negotiation and ICE exchange is a lot to pay for looking at the
  // other monitor.
  assert.equal(signalsOfType('stream.stop').length, 0);
  assert.equal(recorded.phases.length, before);

  stream.stop();
});

test('the PC answers a display switch with what it actually switched to', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  stream.setDisplay(null);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.ready',
        negotiation: {
          streamId: stream.id,
          display: { id: 'DISPLAY-2', name: 'Second monitor', widthPixels: 1920, heightPixels: 1080 },
          videoCodec: 'h264',
          audioCodec: null,
          adjustments: [],
        },
      },
    },
  });

  // The size usually changes with the display, so the panel follows what came back rather
  // than continuing to describe the monitor it asked to leave.
  const negotiation = recorded.negotiations.at(-1) as { display: { name: string; widthPixels: number } };
  assert.equal(negotiation.display.name, 'Second monitor');
  assert.equal(negotiation.display.widthPixels, 1920);

  stream.stop();
});

test('a stream that becomes the lock screen says so', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'stream.state',
        state: 'STREAMING',
        unavailableReason: null,
        detail: 'the screen is locked',
        showing: 'secure-desktop',
      },
    },
  });

  // The stream did not stop, restart or renegotiate — the picture simply became the lock
  // screen. Without this the operator would be looking at a sign-in prompt with no way to
  // tell whether WOLF put it there, and no warning that Ctrl+Alt+Delete will not work.
  assert.deepEqual(recorded.surfaces.at(-1), {
    surface: 'secure-desktop',
    detail: 'the screen is locked',
  });
  assert.equal(recorded.phases.at(-1), 'streaming');

  stream.stop();
});

test('unlocking puts the picture back and drops the warning', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  const showing = (surface: string, detail: string | null) =>
    socketMessage({
      kind: 'cloud.signal',
      envelope: {
        streamId: stream.id,
        payload: {
          type: 'stream.state',
          state: 'STREAMING',
          unavailableReason: null,
          detail,
          showing: surface,
        },
      },
    });

  showing('secure-desktop', 'the screen is locked');
  showing('desktop', null);

  // A lock-screen warning left standing over somebody's actual desktop is worse than none:
  // it says input is going somewhere it is not.
  assert.deepEqual(recorded.surfaces.at(-1), { surface: 'desktop', detail: null });

  stream.stop();
});

test('an agent that says nothing about the desktop is read as showing the ordinary one', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: { type: 'stream.state', state: 'STREAMING', unavailableReason: null, detail: null },
    },
  });

  assert.deepEqual(recorded.surfaces.at(-1), { surface: 'desktop', detail: null });

  stream.stop();
});

/* ------------------------------------------------------------------------- */
/* Terminal                                                                   */
/* ------------------------------------------------------------------------- */

test('a shell cannot be opened without the lease', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  // The default is no, and it is enforced here as well as on the PC. A client that sent an
  // open without a lease would be answered with a refusal — but not sending it at all means
  // the PC never sees a request it has to reason about.
  assert.equal(stream.openTerminal('cmd', 120, 30), null);
  assert.equal(stream.sendTerminalInput('anything', 'whoami\r'), false);
  assert.equal(recorded.terminal.length, 0);

  stream.stop();
});

test('the terminal lease is asked for separately from the keyboard', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  stream.requestControl();
  const inputAsks = signalsOfType('input.request');
  assert.equal(signalsOfType('terminal.request').length, 0, 'asking for input asked for a shell');

  stream.requestTerminal();

  // Two grants, two asks. Holding the keyboard is not the same as being allowed to run
  // commands, and an operator who wanted one must not silently acquire the other.
  assert.equal(signalsOfType('terminal.request').length, 1);
  assert.equal(signalsOfType('input.request').length, inputAsks.length);

  stream.stop();
});

test('a granted lease lets a shell be opened, and it goes on the data channel', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'terminal.control',
        granted: true,
        holderSessionId: 'a-session',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        reason: 'granted',
      },
    },
  });

  assert.deepEqual(recorded.terminalControl.at(-1), { granted: true, reason: 'granted' });

  const terminalId = stream.openTerminal('cmd', 120, 30);
  assert.ok(terminalId);

  const opened = JSON.parse(sentOnChannel.at(-1)!) as Record<string, unknown>;
  assert.equal(opened['kind'], 'terminal.open');
  assert.equal(opened['shell'], 'cmd');
  assert.equal(opened['terminalId'], terminalId);

  // Typing goes the same way. Nothing about a terminal passes through the cloud: what is
  // typed into one, and what it prints back, routinely contains secrets nobody meant to
  // disclose, and content that never reaches a server cannot be stored by one.
  assert.equal(stream.sendTerminalInput(terminalId!, 'whoami\r'), true);

  const typed = JSON.parse(sentOnChannel.at(-1)!) as Record<string, unknown>;
  assert.equal(typed['kind'], 'terminal.input');
  assert.equal(typed['data'], 'whoami\r');

  assert.equal(signalsOfType('terminal.input').length, 0, 'terminal traffic reached the cloud');

  stream.stop();
});

test('losing the lease stops the client sending anything more', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  const grant = (granted: boolean, reason: string) =>
    socketMessage({
      kind: 'cloud.signal',
      envelope: {
        streamId: stream.id,
        payload: {
          type: 'terminal.control',
          granted,
          holderSessionId: granted ? 'a-session' : null,
          expiresAt: granted ? new Date(Date.now() + 600_000).toISOString() : null,
          reason,
        },
      },
    });

  grant(true, 'granted');
  const terminalId = stream.openTerminal('cmd', 120, 30)!;
  assert.ok(terminalId);

  grant(false, 'released');

  // The PC closes the shells when the lease lapses. The client refusing to send is the other
  // half of the same rule, and it means a lapsed lease does not produce a stream of messages
  // the far end will only refuse.
  assert.equal(stream.sendTerminalInput(terminalId, 'whoami\r'), false);
  assert.equal(stream.openTerminal('cmd', 120, 30), null);

  stream.stop();
});

test('what a shell prints reaches the renderer and nothing else', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  deliverControl({
      kind: 'terminal.opened',
      terminalId: 'terminal-1',
      shell: 'cmd',
      processId: 4242,
      columns: 120,
      rows: 30,
      elevated: false,
    });

  deliverControl({
      kind: 'terminal.output',
      terminalId: 'terminal-1',
      sequence: 0,
      data: 'DOMAIN\operator\r',
    });

  assert.equal(recorded.terminal[0]!.kind, 'opened');
  assert.equal(recorded.terminal[1]!.kind, 'output');
  assert.equal(recorded.terminal[1]!.data, 'DOMAIN\operator\r');

  // It arrived on the data channel, so it never touched a server. The client hands it to a
  // renderer and keeps no copy of its own.
  assert.equal(signalsOfType('terminal.output').length, 0);

  stream.stop();
});

test('a refusal from the PC is surfaced with whether Windows or WOLF said no', async () => {
  const { stream, recorded } = makeStream();
  await connectWithControlChannel(stream);

  deliverControl({
      kind: 'terminal.refused',
      terminalId: 'terminal-1',
      reason: 'unsupported',
      detail: 'An elevated terminal needs the terminal-admin capability.',
      limitation: true,
    });

  const refused = recorded.terminal.at(-1)!;
  assert.equal(refused.kind, 'refused');
  assert.match(refused.detail!, /terminal-admin/);

  stream.stop();
});

test('an oversized paste into a terminal is refused before it is sent', async () => {
  const { stream } = makeStream();
  await connectWithControlChannel(stream);

  socketMessage({
    kind: 'cloud.signal',
    envelope: {
      streamId: stream.id,
      payload: {
        type: 'terminal.control',
        granted: true,
        holderSessionId: 'a-session',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        reason: 'granted',
      },
    },
  });

  const terminalId = stream.openTerminal('cmd', 120, 30)!;
  const before = sentOnChannel.length;

  // Bounded here as well as at the far end, which is the difference between a message and a
  // wasted round trip that the PC then has to refuse.
  assert.equal(stream.sendTerminalInput(terminalId, 'x'.repeat(MAX_TERMINAL_CHUNK + 1)), false);
  assert.equal(sentOnChannel.length, before);

  stream.stop();
});

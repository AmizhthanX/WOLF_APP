import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PROFILES,
  hasOverrides,
  isTransientUnavailable,
  negotiateCodec,
  remoteDesktopProfile,
  streamRequest,
  type VideoCodec,
} from './remote-desktop.js';
import {
  AGENT_TO_CLIENT_PAYLOADS,
  CLIENT_TO_AGENT_PAYLOADS,
  isAgentToClient,
  isClientToAgent,
  signalEnvelope,
  signalPayload,
} from './signaling.js';
import { inputBatch, inputEvent, isExtendedKey, VirtualKeys } from './input.js';

const ID = '01J9ZQK7T0000000000000000A';

/* ------------------------------------------------------------------------- */
/* Codec negotiation                                                          */
/* ------------------------------------------------------------------------- */

test('negotiation picks the best codec both sides actually support', () => {
  const agent: VideoCodec[] = ['h264', 'h265'];
  const client: VideoCodec[] = ['h264', 'vp8'];
  assert.equal(negotiateCodec(agent, client), 'h264');
});

test('a client preference wins where it overlaps', () => {
  const agent: VideoCodec[] = ['av1', 'h264'];
  const client: VideoCodec[] = ['av1', 'h264'];
  assert.equal(negotiateCodec(agent, client, ['h264']), 'h264');
  assert.equal(negotiateCodec(agent, client, ['av1']), 'av1');
});

test('a client preference for something unsupported falls back rather than failing', () => {
  const agent: VideoCodec[] = ['h264'];
  const client: VideoCodec[] = ['h264'];
  // The client would like AV1; neither side has it, so H.264 is used rather than nothing.
  assert.equal(negotiateCodec(agent, client, ['av1']), 'h264');
});

test('no overlap returns null instead of guessing', () => {
  // Guessing here would mean streaming something the client cannot decode: a black screen
  // that looks like a broken stream rather than a stated incompatibility.
  assert.equal(negotiateCodec(['h265'], ['vp8']), null);
  assert.equal(negotiateCodec([], ['h264']), null);
  assert.equal(negotiateCodec(['h264'], []), null);
});

test('H.264 is preferred over VP8 and VP9 when nothing better is mutual', () => {
  assert.equal(negotiateCodec(['vp8', 'vp9', 'h264'], ['vp8', 'vp9', 'h264']), 'h264');
});

/* ------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* ------------------------------------------------------------------------- */

test('the built-in profiles are valid and meaningfully different', () => {
  const lan = BUILT_IN_PROFILES['lan-maximum-quality']!;
  const mobile = BUILT_IN_PROFILES['mobile-low-bandwidth']!;

  assert.equal(lan.qualityBias, 'quality');
  assert.equal(mobile.qualityBias, 'performance');
  assert.ok(mobile.maxBitrateBps < lan.maxBitrateBps);
  assert.ok(mobile.targetFps < lan.targetFps);
  assert.equal(mobile.audioEnabled, false, 'audio is dropped first on a metered link');
  assert.ok(lan.adaptive, 'adaptive stays on even at maximum quality');
});

test('a profile whose maximum bitrate is below its minimum is rejected', () => {
  const result = remoteDesktopProfile.safeParse({
    name: 'Broken',
    minBitrateBps: 20_000_000,
    maxBitrateBps: 1_000_000,
  });
  assert.equal(result.success, false);
});

test('a resolution cap must name both dimensions', () => {
  assert.equal(
    remoteDesktopProfile.safeParse({ name: 'Half', maxWidthPixels: 1280 }).success,
    false,
    'a width without a height has no defined meaning',
  );
  assert.equal(
    remoteDesktopProfile.safeParse({
      name: 'Half',
      maxWidthPixels: 1280,
      maxHeightPixels: 720,
    }).success,
    true,
  );
});

test('profile defaults are adaptive with audio on', () => {
  const profile = remoteDesktopProfile.parse({ name: 'Default' });
  assert.equal(profile.adaptive, true);
  assert.equal(profile.audioEnabled, true);
  assert.equal(profile.maxWidthPixels, null, 'native resolution unless capped');
});

test('nothing is pinned unless the operator pins it', () => {
  const profile = remoteDesktopProfile.parse({ name: 'Default' });

  assert.deepEqual(profile.overrides, {
    bitrateBps: null,
    frameRate: null,
    resolutionScale: null,
  });
  assert.equal(hasOverrides(profile.overrides), false);
});

test('a lever can be pinned on its own, leaving the rest adapting', () => {
  const profile = remoteDesktopProfile.parse({
    name: 'Readable',
    overrides: { resolutionScale: 1 },
  });

  // The point of pinning per lever: hold the resolution so text stays sharp, and let the
  // frame rate and bitrate take whatever the link does to them.
  assert.equal(profile.overrides.resolutionScale, 1);
  assert.equal(profile.overrides.frameRate, null);
  assert.equal(profile.adaptive, true, 'pinning one lever does not switch adaptation off');
  assert.equal(hasOverrides(profile.overrides), true);
});

test('a pin that contradicts its own profile is rejected, not resolved', () => {
  const overBitrate = remoteDesktopProfile.safeParse({
    name: 'Contradictory',
    maxBitrateBps: 5_000_000,
    overrides: { bitrateBps: 20_000_000 },
  });
  assert.equal(overBitrate.success, false, 'a pin above the ceiling has no sensible reading');

  const overFps = remoteDesktopProfile.safeParse({
    name: 'Contradictory',
    targetFps: 30,
    overrides: { frameRate: 60 },
  });
  assert.equal(overFps.success, false);

  // Under the ceiling is the normal case and stays legal.
  assert.equal(
    remoteDesktopProfile.safeParse({
      name: 'Fine',
      maxBitrateBps: 5_000_000,
      overrides: { bitrateBps: 3_000_000 },
    }).success,
    true,
  );
});

test('a stream request must name at least one codec the client can decode', () => {
  const withoutCodecs = streamRequest.safeParse({
    profile: { name: 'Default' },
    clientCodecs: [],
  });
  assert.equal(withoutCodecs.success, false);

  const valid = streamRequest.parse({
    profile: { name: 'Default' },
    clientCodecs: ['h264'],
  });
  assert.equal(valid.displayId, null, 'null means the primary display');
});

/* ------------------------------------------------------------------------- */
/* Unavailability                                                             */
/* ------------------------------------------------------------------------- */

test('session boundaries are transient; missing hardware is not', () => {
  // The distinction drives the UI: one says "wait", the other says "this will not work".
  assert.equal(isTransientUnavailable('locked'), true);
  assert.equal(isTransientUnavailable('login'), true);
  assert.equal(isTransientUnavailable('signed-out'), true);
  assert.equal(isTransientUnavailable('restarting'), true);

  assert.equal(isTransientUnavailable('no-encoder'), false);
  assert.equal(isTransientUnavailable('capture-unsupported'), false);
  assert.equal(isTransientUnavailable('codec-mismatch'), false);
  assert.equal(isTransientUnavailable('kill-switch'), false);
});

/* ------------------------------------------------------------------------- */
/* Signaling                                                                  */
/* ------------------------------------------------------------------------- */

function envelope(payload: unknown) {
  return {
    protocolVersion: 1,
    sessionId: ID,
    streamId: ID,
    sentAt: '2026-09-06T12:00:00.000Z',
    payload,
  };
}

test('a signaling envelope is bound to a session and a stream', () => {
  const parsed = signalEnvelope.parse(envelope({ type: 'ice.complete' }));
  assert.equal(parsed.sessionId, ID);
  assert.equal(parsed.streamId, ID);
});

test('an envelope with an unknown payload type is rejected', () => {
  // Signaling is validated, not forwarded blind; an unknown type is not a tunnel.
  assert.equal(signalEnvelope.safeParse(envelope({ type: 'exec.shell' })).success, false);
});

test('oversized SDP and candidates are rejected', () => {
  assert.equal(
    signalPayload.safeParse({ type: 'sdp.offer', sdp: 'v=0'.repeat(20_000) }).success,
    false,
  );
  assert.equal(
    signalPayload.safeParse({
      type: 'ice.candidate',
      candidate: 'a'.repeat(2000),
      sdpMid: '0',
      sdpMLineIndex: 0,
    }).success,
    false,
  );
});

test('direction is part of the contract, not a convention', () => {
  // A client must not be able to publish stats that make a stream look healthy.
  assert.equal(isClientToAgent('stream.stats'), false);
  assert.equal(isAgentToClient('stream.stats'), true);

  // An agent must not be able to ask itself to start streaming.
  assert.equal(isAgentToClient('stream.request'), false);
  assert.equal(isClientToAgent('stream.request'), true);

  // The offer comes from the agent, the answer from the client.
  assert.equal(isAgentToClient('sdp.offer'), true);
  assert.equal(isClientToAgent('sdp.offer'), false);
  assert.equal(isClientToAgent('sdp.answer'), true);
  assert.equal(isAgentToClient('sdp.answer'), false);

  // Candidates and stops are genuinely bidirectional.
  assert.ok(isClientToAgent('ice.candidate') && isAgentToClient('ice.candidate'));
  assert.ok(isClientToAgent('stream.stop') && isAgentToClient('stream.stop'));
});

/**
 * Payloads only the relay may author.
 *
 * A payload in neither direction list cannot be sent by a client or by an agent, which is
 * the point: `input.control` decides who is allowed to drive somebody's PC, so neither end
 * gets to assert it. Listing them here rather than allowing any undeclared type keeps the
 * exemption deliberate — a payload added without a direction fails this test until somebody
 * decides which of the two it is.
 */
const RELAY_AUTHORED: readonly string[] = ['input.control'];

test('every payload type has a declared direction, or is one only the relay may author', () => {
  const declared = new Set([...CLIENT_TO_AGENT_PAYLOADS, ...AGENT_TO_CLIENT_PAYLOADS]);
  const options = signalPayload.options.map((option) => option.shape.type.value);

  for (const type of options) {
    if (RELAY_AUTHORED.includes(type)) continue;
    assert.ok(declared.has(type), `${type} has no declared direction`);
  }
});

test('a payload only the relay may author cannot be sent by either end', () => {
  for (const type of RELAY_AUTHORED) {
    // Both checks matter. A client that could send `input.control` would be granting itself
    // the keyboard; an agent that could send it would be telling a dashboard that somebody
    // else is driving when nobody is.
    assert.equal(isClientToAgent(type as never), false, `a client can send ${type}`);
    assert.equal(isAgentToClient(type as never), false, `an agent can send ${type}`);
  }
});

/* ------------------------------------------------------------------------- */
/* Input                                                                      */
/* ------------------------------------------------------------------------- */

test('pointer coordinates are normalised and range-checked', () => {
  assert.equal(inputEvent.safeParse({ type: 'pointer.move', x: 0.5, y: 0.5 }).success, true);
  assert.equal(inputEvent.safeParse({ type: 'pointer.move', x: 1.5, y: 0.5 }).success, false);
  assert.equal(inputEvent.safeParse({ type: 'pointer.move', x: -0.1, y: 0.5 }).success, false);
});

test('keys are virtual-key codes, not strings', () => {
  assert.equal(
    inputEvent.safeParse({ type: 'key', key: 'Enter', action: 'down' }).success,
    false,
    'a string key would need a parser, and a parser is something to get wrong',
  );
  assert.equal(
    inputEvent.safeParse({ type: 'key', key: VirtualKeys.Enter, action: 'down' }).success,
    true,
  );

  // 0 is not a key and 255 is reserved.
  assert.equal(inputEvent.safeParse({ type: 'key', key: 0, action: 'down' }).success, false);
  assert.equal(inputEvent.safeParse({ type: 'key', key: 255, action: 'down' }).success, false);
});

test('scroll deltas are bounded', () => {
  const valid = inputEvent.safeParse({
    type: 'pointer.scroll',
    x: 0.5,
    y: 0.5,
    deltaX: 0,
    deltaY: 3,
  });
  assert.equal(valid.success, true);

  const runaway = inputEvent.safeParse({
    type: 'pointer.scroll',
    x: 0.5,
    y: 0.5,
    deltaX: 0,
    deltaY: 100_000,
  });
  assert.equal(runaway.success, false, 'one event must not scroll a document forever');
});

test('text input is bounded', () => {
  assert.equal(inputEvent.safeParse({ type: 'text', value: 'hello' }).success, true);
  assert.equal(inputEvent.safeParse({ type: 'text', value: '' }).success, false);
  assert.equal(inputEvent.safeParse({ type: 'text', value: 'x'.repeat(1000) }).success, false);
});

test('modifier state defaults to nothing held', () => {
  const parsed = inputEvent.parse({
    type: 'key',
    key: VirtualKeys.Enter,
    action: 'down',
  });
  assert.deepEqual(
    parsed.type === 'key' ? parsed.modifiers : null,
    { shift: false, control: false, alt: false, meta: false },
  );
});

test('reserved combinations are their own event type', () => {
  // Ctrl+Alt+Del cannot be synthesised from three key events, so it is not modelled as
  // three key events. Naming it lets the agent answer "this needs the privileged helper".
  assert.equal(
    inputEvent.safeParse({ type: 'system.combo', combo: 'ctrl-alt-del' }).success,
    true,
  );
  assert.equal(
    inputEvent.safeParse({ type: 'system.combo', combo: 'rm-rf' }).success,
    false,
  );
});

test('a batch is bounded and carries a sequence number', () => {
  const batch = inputBatch.parse({
    streamId: ID,
    sequence: 41,
    sentAt: '2026-09-06T12:00:00.000Z',
    events: [{ type: 'pointer.move', x: 0.1, y: 0.2 }],
  });
  assert.equal(batch.sequence, 41);

  assert.equal(
    inputBatch.safeParse({
      streamId: ID,
      sequence: 0,
      sentAt: '2026-09-06T12:00:00.000Z',
      events: [],
    }).success,
    false,
  );

  assert.equal(
    inputBatch.safeParse({
      streamId: ID,
      sequence: 0,
      sentAt: '2026-09-06T12:00:00.000Z',
      events: Array.from({ length: 200 }, () => ({ type: 'pointer.move', x: 0, y: 0 })),
    }).success,
    false,
  );
});

test('extended keys are identified so Windows interprets them correctly', () => {
  assert.equal(isExtendedKey(VirtualKeys.ArrowLeft), true);
  assert.equal(isExtendedKey(VirtualKeys.Delete), true);
  assert.equal(isExtendedKey(VirtualKeys.MetaLeft), true);
  assert.equal(isExtendedKey(VirtualKeys.Space), false);
});

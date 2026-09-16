import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerWakeCommand, wakeMacAddress } from './power.js';
import { powerWakeResult, systemCapabilitiesResult } from '../results.js';

/**
 * Wake-on-LAN's shapes: the one address a wake packet may be built for, and what a PC reports about
 * being woken.
 */

test('a MAC address is six lowercase hex pairs', () => {
  assert.ok(wakeMacAddress.safeParse('d8:bb:c1:0a:2b:3c').success);
  for (const bad of ['D8:BB:C1:0A:2B:3C', 'd8-bb-c1-0a-2b-3c', 'd8bbc10a2b3c', 'd8:bb:c1:0a:2b', 'd8:bb:c1:0a:2b:3c:4d', '']) {
    assert.equal(wakeMacAddress.safeParse(bad).success, false, bad);
  }
});

test('a group or all-zero address is not one a wake packet is built for', () => {
  // The low bit of the first octet marks a group: every machine listening for it, not one.
  assert.equal(wakeMacAddress.safeParse('01:00:5e:00:00:01').success, false);
  assert.equal(wakeMacAddress.safeParse('ff:ff:ff:ff:ff:ff').success, false);
  assert.equal(wakeMacAddress.safeParse('00:00:00:00:00:00').success, false);
  assert.ok(wakeMacAddress.safeParse('02:00:00:00:00:01').success, 'a locally administered unicast address is still one adapter');
});

test('a client names the PC to wake; the address is optional in the body the client sends', () => {
  assert.ok(powerWakeCommand.safeParse({ type: 'power.wake', payload: { targetPcId: '01J9ZQK7T0000000000000000A' } }).success);
  assert.equal(
    powerWakeCommand.safeParse({
      type: 'power.wake',
      payload: { targetPcId: '01J9ZQK7T0000000000000000A', macAddress: 'ff:ff:ff:ff:ff:ff' },
    }).success,
    false,
  );
});

test('an agent that says nothing about waking is read as having no wired address', () => {
  const parsed = systemCapabilitiesResult.parse({
    hardwareVideoEncoders: [],
    preferredVideoCodec: null,
    displayCount: 1,
    audioCaptureAvailable: false,
    wakeOnLanCapable: false,
    privilegedHelperAvailable: false,
    secureDesktopCaptureAvailable: false,
    remoteUnlockProvisioned: false,
    gpuVendors: [],
    windowsBuild: null,
  });
  assert.equal(parsed.wakeMacAddress, null);
});

test('a wake result never claims the PC woke', () => {
  const sent = {
    targetPcId: '01J9ZQK7T0000000000000000A',
    method: 'lan-broadcast',
    packetsSent: 6,
    networks: 1,
    sentAt: '2026-09-16T10:00:00.000Z',
  };
  assert.equal(powerWakeResult.safeParse(sent).success, false, 'confirmationPending is required');
  assert.ok(powerWakeResult.safeParse({ ...sent, confirmationPending: true }).success);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeReadiness, wakeSenders, wakeSentText, type WakeablePc } from './wake.js';

function pc(overrides: Partial<WakeablePc> & { id: string }): WakeablePc {
  return {
    name: overrides.id,
    status: 'offline',
    remoteAccessEnabled: true,
    capabilities: { wakeOnLanCapable: true, wakeAddressKnown: true, supportedCommands: ['power.wake'] },
    ...overrides,
  };
}

test('a PC is ready to wake only when it is offline, reachable by policy, and has a known armed adapter', () => {
  assert.equal(wakeReadiness(pc({ id: 'a' })).kind, 'ready');
  assert.equal(wakeReadiness(pc({ id: 'a', status: 'online' })).kind, 'online');
  assert.equal(wakeReadiness(pc({ id: 'a', remoteAccessEnabled: false })).kind, 'switched-off');
  assert.equal(
    wakeReadiness(pc({ id: 'a', capabilities: { wakeOnLanCapable: false, wakeAddressKnown: false, supportedCommands: [] } })).kind,
    'no-address',
  );
  assert.equal(wakeReadiness(pc({ id: 'a', capabilities: null })).kind, 'no-address');
  assert.equal(
    wakeReadiness(pc({ id: 'a', capabilities: { wakeOnLanCapable: false, wakeAddressKnown: true, supportedCommands: [] } })).kind,
    'not-armed',
  );
});

test('senders are the owner’s other PCs that are online, not switched off, and can send a wake', () => {
  const target = pc({ id: 'tower' });
  const senders = wakeSenders(target, [
    target,
    pc({ id: 'zeta', status: 'online' }),
    pc({ id: 'alpha', status: 'online' }),
    pc({ id: 'asleep' }),
    pc({ id: 'off', status: 'online', remoteAccessEnabled: false }),
    pc({ id: 'old-agent', status: 'online', capabilities: { wakeOnLanCapable: false, supportedCommands: ['power.action'] } }),
  ]);

  assert.deepEqual(senders.map((sender) => sender.id), ['alpha', 'zeta']);
});

test('the result says what was sent, never that the PC woke', () => {
  const text = wakeSentText('Laptop', 'Tower', { packetsSent: 6, networks: 1 });
  assert.match(text, /Laptop sent 6 wake packets for Tower across 1 local network\./);
  assert.doesNotMatch(text, /woke Tower|Tower woke|is awake/);
});

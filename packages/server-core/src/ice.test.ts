import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIceConfiguration, type IceSettings } from './ice.js';

/**
 * ICE configuration, which decides whether a stream can leave the local network.
 *
 * The interesting cases are the two ends of the range: nothing configured, where WOLF has
 * to be honest that a stream will only work on the same network, and TURN configured, where
 * the credential has to be one the relay will actually accept.
 */

const now = new Date('2026-01-01T00:00:00.000Z');

const nothing: IceSettings = {
  stunUrls: [],
  turnUrls: [],
  turnSecret: '',
  turnCredentialTtlSeconds: 3600,
  internetCapable: false,
};

test('with nothing configured, no servers are invented', () => {
  const configuration = buildIceConfiguration(nothing, 'user-1', now);

  // The shipped default. WOLF does not route somebody's screen through a public STUN
  // server nobody chose, so the honest answer here is an empty list and a LAN-only stream.
  assert.deepEqual(configuration.iceServers, []);
  assert.equal(configuration.iceTransportPolicy, 'all');
});

test('a STUN server is offered without credentials, because it needs none', () => {
  const configuration = buildIceConfiguration(
    { ...nothing, stunUrls: ['stun:stun.example.net:3478'] },
    'user-1',
    now,
  );

  assert.equal(configuration.iceServers.length, 1);
  assert.deepEqual(configuration.iceServers[0]?.urls, ['stun:stun.example.net:3478']);
  assert.equal(configuration.iceServers[0]?.username, null);
  assert.equal(configuration.iceServers[0]?.credential, null);
});

test('TURN credentials are short-lived and verifiable by the relay', () => {
  const settings: IceSettings = {
    ...nothing,
    turnUrls: ['turn:turn.example.net:3478'],
    turnSecret: 'shared-with-the-turn-server',
    turnCredentialTtlSeconds: 600,
    internetCapable: true,
  };

  const configuration = buildIceConfiguration(settings, 'user-1', now);
  const server = configuration.iceServers[0];
  assert.ok(server);

  // The TURN REST API's format: the username is an expiry and a user id, and the password
  // is an HMAC of it. coturn recomputes the same HMAC from its own copy of the secret, so
  // nothing has to be stored per session and a leaked credential expires on its own.
  const expectedExpiry = Math.floor((now.getTime() + 600_000) / 1000);
  assert.equal(server.username, `${expectedExpiry}:user-1`);
  assert.equal(
    server.credential,
    createHmac('sha1', settings.turnSecret).update(server.username!).digest('base64'),
  );

  assert.equal(configuration.expiresAt, new Date(now.getTime() + 600_000).toISOString());
});

test('the credential is bound to the user it was minted for', () => {
  const settings: IceSettings = {
    ...nothing,
    turnUrls: ['turn:turn.example.net:3478'],
    turnSecret: 'shared-with-the-turn-server',
    internetCapable: true,
  };

  const first = buildIceConfiguration(settings, 'user-1', now);
  const second = buildIceConfiguration(settings, 'user-2', now);

  // Two users at the same instant get different credentials, so relay usage attributable
  // to one account cannot be produced by another.
  assert.notEqual(first.iceServers[0]?.username, second.iceServers[0]?.username);
  assert.notEqual(first.iceServers[0]?.credential, second.iceServers[0]?.credential);
});

test('a TURN server configured without a secret is not offered at all', () => {
  const configuration = buildIceConfiguration(
    { ...nothing, turnUrls: ['turn:turn.example.net:3478'], turnSecret: '' },
    'user-1',
    now,
  );

  // Handing out a relay address with no credential produces a connection that fails during
  // ICE, minutes of confusion, and no clue that the configuration is incomplete.
  assert.deepEqual(configuration.iceServers, []);
});

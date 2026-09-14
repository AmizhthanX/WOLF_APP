import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describe,
  judgeMetric,
  judgeOffline,
  MIN_SAMPLES,
  transition,
  type AlertState,
  type RuleShape,
} from './engine.js';

/**
 * Whether a rule holds, and what to do about it.
 *
 * The two ways this can go wrong are a notification nobody should have received and silence
 * when somebody should have been told. The second is worse, and the one to watch for is the
 * quiet version of it: a machine that stops reporting resolving its own alert.
 */

const now = new Date('2026-09-14T12:00:00.000Z');

/** One value per minute across the last `minutes` minutes, newest at `now`. */
function perMinute(minutes: number, value: (minuteAgo: number) => number) {
  return Array.from({ length: minutes + 1 }, (_, index) => ({
    at: new Date(now.getTime() - (minutes - index) * 60_000),
    value: value(minutes - index),
  }));
}

const above: RuleShape = { condition: 'metric-above', metric: 'cpu.usage', threshold: 90, forMinutes: 10 };
const below: RuleShape = { condition: 'metric-below', metric: 'battery.charge', threshold: 20, forMinutes: 10 };

/* ------------------------------------------------------------------------- */
/* Judging a metric                                                           */
/* ------------------------------------------------------------------------- */

test('a metric over its line for the whole window is breaching', () => {
  const verdict = judgeMetric(above, perMinute(10, () => 95), now);

  assert.equal(verdict.kind, 'breaching');
  assert.equal(verdict.kind === 'breaching' && verdict.value, 95);
});

test('one dip under the line during the window means it did not hold', () => {
  // "Sustained" means the whole window. A rule for CPU above 90% for ten minutes should not fire
  // on a machine that fell to 40% at minute seven — and the error this avoids is the one that
  // teaches the owner to ignore the inbox.
  const verdict = judgeMetric(above, perMinute(10, (minuteAgo) => (minuteAgo === 3 ? 40 : 95)), now);

  assert.equal(verdict.kind, 'clear');
});

test('the value reported for a breach is the one closest to the line', () => {
  // Everything crossed the line, so the least extreme sample is the honest summary: "stayed above
  // 90%, never lower than 91%". Reporting the peak would describe a spike, not the sustained state.
  const verdict = judgeMetric(above, perMinute(10, (minuteAgo) => 91 + minuteAgo), now);

  assert.equal(verdict.kind === 'breaching' && verdict.value, 91);
});

test('a below rule is the mirror image', () => {
  assert.equal(judgeMetric(below, perMinute(10, () => 12), now).kind, 'breaching');
  assert.equal(judgeMetric(below, perMinute(10, (minuteAgo) => (minuteAgo === 0 ? 25 : 12)), now).kind, 'clear');
});

test('a value exactly on the threshold is not over it', () => {
  // Strictly above, strictly below. A rule written as "above 90" should not fire at 90.
  assert.equal(judgeMetric(above, perMinute(10, () => 90), now).kind, 'clear');
  assert.equal(judgeMetric(below, perMinute(10, () => 20), now).kind, 'clear');
});

/* ------------------------------------------------------------------------- */
/* The third answer                                                           */
/* ------------------------------------------------------------------------- */

test('no samples at all is unknown, never clear', () => {
  // The case the whole three-answer design exists for. A machine that has stopped reporting has
  // not recovered; treating silence as "fine" resolves the alert at exactly the wrong moment.
  assert.equal(judgeMetric(above, [], now).kind, 'unknown');
});

test('too few samples to describe a sustained condition is unknown', () => {
  const one = [{ at: now, value: 99 }];
  assert.ok(one.length < MIN_SAMPLES);
  assert.equal(judgeMetric(above, one, now).kind, 'unknown');
});

test('an agent that reconnected moments ago cannot fire a half-hour rule', () => {
  // Two samples above the line in the last thirty seconds, for a rule that asked for thirty
  // minutes. Firing would be a guess about twenty-nine and a half minutes nobody observed.
  const rule: RuleShape = { ...above, forMinutes: 30 };
  const recent = [
    { at: new Date(now.getTime() - 30_000), value: 99 },
    { at: now, value: 99 },
  ];

  assert.equal(judgeMetric(rule, recent, now).kind, 'unknown');
});

test('samples that stopped halfway through the window are unknown', () => {
  // Reported above the line for the first half, then nothing. Saying it breached "for ten
  // minutes" would be a statement about five minutes nobody saw.
  const firstHalf = perMinute(10, () => 99).filter((entry) => entry.at.getTime() <= now.getTime() - 5 * 60_000);

  assert.equal(judgeMetric(above, firstHalf, now).kind, 'unknown');
});

test('a hole in the middle of the window is unknown, even with both edges covered', () => {
  // Reported at the start and the end of a day and off for three hours in between. That was not
  // observed breaching for twenty-four hours.
  const rule: RuleShape = { ...above, forMinutes: 1440 };
  const points = Array.from({ length: 289 }, (_, index) => ({
    at: new Date(now.getTime() - (288 - index) * 5 * 60_000),
    value: 99,
  })).filter((entry) => {
    const minutesAgo = (now.getTime() - entry.at.getTime()) / 60_000;
    return minutesAgo < 600 || minutesAgo > 780;
  });

  assert.equal(judgeMetric(rule, points, now).kind, 'unknown');
  // The same day with no hole is a breach, so it is the hole that decided it.
  assert.equal(
    judgeMetric(rule, Array.from({ length: 289 }, (_, index) => ({
      at: new Date(now.getTime() - (288 - index) * 5 * 60_000),
      value: 99,
    })), now).kind,
    'breaching',
  );
});

test('samples outside the window do not count', () => {
  // Hours of old breaching data and nothing recent is not a current breach.
  const old = Array.from({ length: 30 }, (_, index) => ({
    at: new Date(now.getTime() - (120 + index) * 60_000),
    value: 99,
  }));

  assert.equal(judgeMetric(above, old, now).kind, 'unknown');
});

test('samples that do not quite land on the window edges still count', () => {
  // Real samples arrive a few seconds off the minute. Demanding one at the exact first second
  // would make a rule never fire on a machine that is reporting normally.
  const jittered = perMinute(10, () => 95).map((entry, index) => ({
    at: new Date(entry.at.getTime() + (index === 0 ? 20_000 : 0)),
    value: entry.value,
  }));

  assert.equal(judgeMetric(above, jittered, now).kind, 'breaching');
});

/* ------------------------------------------------------------------------- */
/* Offline                                                                    */
/* ------------------------------------------------------------------------- */

test('a PC away for longer than the window is breaching', () => {
  const verdict = judgeOffline(
    { condition: 'pc-offline', metric: null, threshold: null, forMinutes: 10 },
    { status: 'offline', lastSeenAt: new Date(now.getTime() - 25 * 60_000) },
    now,
  );

  assert.equal(verdict.kind, 'breaching');
  assert.equal(verdict.kind === 'breaching' && verdict.value, 25);
});

test('a PC that only just dropped off is not yet an alert', () => {
  // A reboot, a Wi-Fi blip. The sustain window is what separates those from a machine that is
  // actually gone.
  const verdict = judgeOffline(
    { condition: 'pc-offline', metric: null, threshold: null, forMinutes: 10 },
    { status: 'offline', lastSeenAt: new Date(now.getTime() - 3 * 60_000) },
    now,
  );

  assert.equal(verdict.kind, 'clear');
});

test('an online PC is clear, and a never-seen one is unknown', () => {
  const rule: RuleShape = { condition: 'pc-offline', metric: null, threshold: null, forMinutes: 10 };

  assert.equal(judgeOffline(rule, { status: 'online', lastSeenAt: now }, now).kind, 'clear');

  // A machine still being enrolled has no "since" to measure from. Firing on it would be noise
  // from the first minute of its existence.
  assert.equal(judgeOffline(rule, { status: 'offline', lastSeenAt: null }, now).kind, 'unknown');
});

/* ------------------------------------------------------------------------- */
/* The state machine                                                          */
/* ------------------------------------------------------------------------- */

const ok: AlertState = { state: 'ok', lastNotifiedAt: null, notified: false };
const breaching = { kind: 'breaching', value: 95 } as const;
const clear = { kind: 'clear', value: 40 } as const;
const unknown = { kind: 'unknown', reason: 'no data' } as const;

test('a first breach fires and notifies', () => {
  assert.deepEqual(transition(null, breaching, 60, now), { kind: 'fire', notify: true });
  assert.deepEqual(transition(ok, breaching, 60, now), { kind: 'fire', notify: true });
});

test('a breach that is already firing says nothing new', () => {
  // Told once. A notification every minute an alert stays up is the inbox the owner stops reading.
  const firing: AlertState = { state: 'firing', lastNotifiedAt: now, notified: true };

  assert.deepEqual(transition(firing, breaching, 60, now), { kind: 'none' });
});

test('clearing a firing alert resolves it and says so', () => {
  const firing: AlertState = { state: 'firing', lastNotifiedAt: new Date(now.getTime() - 60_000), notified: true };

  assert.deepEqual(transition(firing, clear, 60, now), { kind: 'resolve', notify: true });
});

test('unknown never moves an alert in either direction', () => {
  const firing: AlertState = { state: 'firing', lastNotifiedAt: now, notified: true };

  // The single rule that keeps a machine that went silent from quietly resolving its own alert.
  assert.deepEqual(transition(firing, unknown, 60, now), { kind: 'none' });
  assert.deepEqual(transition(ok, unknown, 60, now), { kind: 'none' });
  assert.deepEqual(transition(null, unknown, 60, now), { kind: 'none' });
});

test('a flapping rule inside its cooldown fires silently', () => {
  // Notified twenty minutes ago, resolved, breaching again, with a sixty-minute cooldown. A metric
  // hovering at its threshold would otherwise be a notification every few minutes.
  const recentlyTold: AlertState = {
    state: 'ok',
    lastNotifiedAt: new Date(now.getTime() - 20 * 60_000),
    notified: false,
  };

  assert.deepEqual(transition(recentlyTold, breaching, 60, now), { kind: 'fire', notify: false });
});

test('once the cooldown has passed, a new breach is news again', () => {
  const longAgo: AlertState = {
    state: 'ok',
    lastNotifiedAt: new Date(now.getTime() - 61 * 60_000),
    notified: false,
  };

  assert.deepEqual(transition(longAgo, breaching, 60, now), { kind: 'fire', notify: true });
});

test('a silent firing does not produce a resolved notification when it clears', () => {
  // The owner was never told it fired. "Back to normal" about something they never heard was wrong
  // would be a message that makes no sense in isolation.
  const silentlyFiring: AlertState = {
    state: 'firing',
    lastNotifiedAt: new Date(now.getTime() - 20 * 60_000),
    notified: false,
  };

  assert.deepEqual(transition(silentlyFiring, clear, 60, now), { kind: 'resolve', notify: false });
});

test('a clear reading on a quiet alert does nothing', () => {
  assert.deepEqual(transition(ok, clear, 60, now), { kind: 'none' });
  assert.deepEqual(transition(null, clear, 60, now), { kind: 'none' });
});

/* ------------------------------------------------------------------------- */
/* The words                                                                  */
/* ------------------------------------------------------------------------- */

test('a fired notification names the PC, the metric, the line and the rule', () => {
  const words = describe({
    kind: 'fired',
    ruleName: 'Disk nearly full',
    pcName: 'STUDIO',
    condition: 'metric-above',
    metric: 'disk.usedPercent',
    seriesKey: 'C:',
    threshold: 90,
    forMinutes: 30,
    value: 93.46,
    severity: 'warning',
  });

  assert.equal(words.title, 'Disk used (C:) on STUDIO is above 90%');
  assert.match(words.detail, /for 30 minutes/);
  assert.match(words.detail, /93\.5%/);
  assert.match(words.detail, /Disk nearly full/);
});

test('an offline notification reads as one', () => {
  const fired = describe({
    kind: 'fired',
    ruleName: 'Office PC down',
    pcName: 'OFFICE',
    condition: 'pc-offline',
    metric: null,
    seriesKey: null,
    threshold: null,
    forMinutes: 10,
    value: 42,
    severity: 'critical',
  });

  const resolved = describe({
    kind: 'resolved',
    ruleName: 'Office PC down',
    pcName: 'OFFICE',
    condition: 'pc-offline',
    metric: null,
    seriesKey: null,
    threshold: null,
    forMinutes: 10,
    value: null,
    severity: 'critical',
  });

  assert.equal(fired.title, 'OFFICE is offline');
  assert.match(fired.detail, /42 minutes/);
  assert.equal(resolved.title, 'OFFICE is back online');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AutomationAction } from '@wolf/protocol';
import type { TelemetrySample } from '@wolf/telemetry-schema';
import {
  authorizeRun,
  authorizeSave,
  cooldownAllows,
  dueScheduleSlot,
  evaluateConditions,
  inTimeWindow,
  localTime,
} from './engine.js';

/**
 * When an automation runs, and whether it still may.
 *
 * A wrong answer here restarts a machine at the wrong hour, twice, or on the authority of a device
 * that was revoked last week. The tests are written around those outcomes.
 */

/* ------------------------------------------------------------------------- */
/* Local time and schedules                                                   */
/* ------------------------------------------------------------------------- */

test('local time is read in the automation zone, not the server zone', () => {
  // 21:45 UTC is 03:15 the next morning in India.
  const local = localTime(new Date('2026-09-14T21:45:00Z'), 'Asia/Kolkata');
  assert.deepEqual(local, { date: '2026-09-15', time: '03:15', weekday: 'tue', minuteOfDay: 195 });
});

const nightly = { time: '03:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const, timeZone: 'Asia/Kolkata' };

test('a schedule is due at its minute and names the local slot', () => {
  // 03:00 IST on Tuesday 15 September is 21:30 UTC on the 14th.
  assert.equal(dueScheduleSlot(nightly, new Date('2026-09-14T21:30:20Z')), '2026-09-15T03:00');
});

test('a schedule stays due for the grace window and then is not', () => {
  assert.equal(dueScheduleSlot(nightly, new Date('2026-09-14T21:34:59Z')), '2026-09-15T03:00');

  // Six minutes late is late. A machine is not shut down whenever the server happens to come back.
  assert.equal(dueScheduleSlot(nightly, new Date('2026-09-14T21:35:00Z')), null);
  assert.equal(dueScheduleSlot(nightly, new Date('2026-09-14T21:29:59Z')), null);
});

test('a schedule only runs on its days, judged by the local day', () => {
  const weekdaysOnly = { ...nightly, days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const };

  // Sunday 21:30 UTC is already Monday 03:00 in India: due.
  assert.equal(dueScheduleSlot(weekdaysOnly, new Date('2026-09-13T21:30:00Z')), '2026-09-14T03:00');
  // Friday 21:30 UTC is Saturday in India: not due.
  assert.equal(dueScheduleSlot(weekdaysOnly, new Date('2026-09-18T21:30:00Z')), null);
});

test('a time skipped by clocks going forward does not run that day', () => {
  // New York, 8 March 2026: 02:00 jumps to 03:00. There is no 02:30.
  const skipped = { time: '02:30', days: ['sun'] as const, timeZone: 'America/New_York' };

  for (let minute = 0; minute < 120; minute += 1) {
    const at = new Date(Date.parse('2026-03-08T06:00:00Z') + minute * 60_000);
    assert.equal(dueScheduleSlot(skipped, at), null, at.toISOString());
  }
});

test('a time repeated by clocks going back yields one slot, so it runs once', () => {
  // New York, 1 November 2026: 01:30 happens at 05:30 UTC and again at 06:30 UTC.
  const repeated = { time: '01:30', days: ['sun'] as const, timeZone: 'America/New_York' };

  const first = dueScheduleSlot(repeated, new Date('2026-11-01T05:30:00Z'));
  const second = dueScheduleSlot(repeated, new Date('2026-11-01T06:30:00Z'));

  assert.equal(first, '2026-11-01T01:30');
  assert.equal(second, first, 'the same key both times; the slot table stores it once');
});

/* ------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* ------------------------------------------------------------------------- */

test('a time window contains its start and not its end', () => {
  const office = { start: '09:00', end: '17:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const, timeZone: 'UTC' };

  assert.equal(inTimeWindow(office, new Date('2026-09-14T09:00:00Z')), true);
  assert.equal(inTimeWindow(office, new Date('2026-09-14T16:59:00Z')), true);
  assert.equal(inTimeWindow(office, new Date('2026-09-14T17:00:00Z')), false);
  assert.equal(inTimeWindow(office, new Date('2026-09-13T12:00:00Z')), false, 'Sunday');
});

test('a window across midnight belongs to the day it started', () => {
  const overnight = { start: '22:00', end: '06:00', days: ['fri'] as const, timeZone: 'UTC' };

  assert.equal(inTimeWindow(overnight, new Date('2026-09-18T23:00:00Z')), true, 'Friday night');
  assert.equal(inTimeWindow(overnight, new Date('2026-09-19T05:00:00Z')), true, 'Saturday morning, Friday window');
  assert.equal(inTimeWindow(overnight, new Date('2026-09-20T05:00:00Z')), false, 'Sunday morning, Saturday window');
  assert.equal(inTimeWindow(overnight, new Date('2026-09-18T12:00:00Z')), false, 'Friday noon');
});

const now = new Date('2026-09-14T12:00:00Z');

function sample(cpu: number, disks: Record<string, number> = {}): TelemetrySample {
  return {
    sampledAt: now.toISOString(),
    uptimeSeconds: 1,
    cpu: { usagePercent: cpu, perCorePercent: [], frequencyMhz: null, temperatureCelsius: null, queueLength: null, packagePowerWatts: null },
    memory: { totalBytes: null, usedBytes: null, availableBytes: null, committedBytes: null, commitLimitBytes: null, cachedBytes: null },
    gpus: [],
    disks: Object.entries(disks).map(([volume, used]) => ({
      volume,
      label: null,
      totalBytes: 100,
      freeBytes: 100 - used,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      activeTimePercent: null,
      queueLength: null,
      temperatureCelsius: null,
      healthStatus: 'unknown' as const,
    })),
    networks: [],
    thermal: [],
    battery: null,
    agent: null,
  };
}

test('a metric condition holds on a recent reading', () => {
  const verdict = evaluateConditions([{ kind: 'metric', metric: 'cpu.usage', seriesKey: null, comparison: 'below', threshold: 20 }], {
    now,
    latest: { sampledAt: new Date(now.getTime() - 30_000), sample: sample(5) },
    activeSessions: 0,
  });
  assert.deepEqual(verdict, { met: true });
});

test('no recent telemetry does not satisfy a metric condition', () => {
  // "Restart when idle" must not restart a machine that simply stopped reporting its load.
  const condition = [{ kind: 'metric', metric: 'cpu.usage', seriesKey: null, comparison: 'below', threshold: 20 }] as const;

  assert.equal(evaluateConditions(condition, { now, latest: null, activeSessions: 0 }).met, false);
  assert.equal(
    evaluateConditions(condition, { now, latest: { sampledAt: new Date(now.getTime() - 3 * 60_000), sample: sample(5) }, activeSessions: 0 }).met,
    false,
  );
});

test('with no device named, every device must satisfy the condition', () => {
  const condition = [{ kind: 'metric', metric: 'disk.usedPercent', seriesKey: null, comparison: 'below', threshold: 90 }] as const;
  const latest = { sampledAt: now, sample: sample(5, { 'C:': 50, 'D:': 95 }) };

  assert.equal(evaluateConditions(condition, { now, latest, activeSessions: 0 }).met, false);

  const onlyC = [{ ...condition[0], seriesKey: 'C:' }];
  assert.equal(evaluateConditions(onlyC, { now, latest, activeSessions: 0 }).met, true);
});

test('a metric the PC does not report is not met', () => {
  const verdict = evaluateConditions(
    [{ kind: 'metric', metric: 'battery.charge', seriesKey: null, comparison: 'above', threshold: 50 }],
    { now, latest: { sampledAt: now, sample: sample(5) }, activeSessions: 0 },
  );
  assert.equal(verdict.met, false);
});

test('conditions stop at the first that fails, and say which', () => {
  const verdict = evaluateConditions(
    [
      { kind: 'no-active-session' },
      { kind: 'metric', metric: 'cpu.usage', seriesKey: null, comparison: 'below', threshold: 20 },
    ],
    { now, latest: { sampledAt: now, sample: sample(5) }, activeSessions: 1 },
  );

  assert.deepEqual(verdict, { met: false, detail: 'Somebody is connected to the PC.' });
});

/* ------------------------------------------------------------------------- */
/* Cooldowns                                                                  */
/* ------------------------------------------------------------------------- */

test('a cooldown allows a first run and one after it has passed', () => {
  assert.equal(cooldownAllows(null, 60, now), true);
  assert.equal(cooldownAllows(new Date(now.getTime() - 59 * 60_000), 60, now), false);
  assert.equal(cooldownAllows(new Date(now.getTime() - 60 * 60_000), 60, now), true);
});

/* ------------------------------------------------------------------------- */
/* Authority                                                                  */
/* ------------------------------------------------------------------------- */

const notify: AutomationAction = { kind: 'notify', severity: 'info', message: 'Nightly check' };
const restart: AutomationAction = {
  kind: 'command',
  command: { type: 'power.action', payload: { action: 'restart', delaySeconds: 60, force: false } },
};
const forcedRestart: AutomationAction = {
  kind: 'command',
  command: { type: 'power.action', payload: { action: 'restart', delaySeconds: 60, force: true } },
};
const nowSeconds = Math.floor(now.getTime() / 1000);

test('a notification-only automation needs no confirmation', () => {
  assert.deepEqual(authorizeSave({ actions: [notify], confirmedRiskLevel: undefined, authTimeSeconds: 0, now }), { ok: true, risk: 'low' });
});

test('a high-risk automation needs the matching confirmation and a fresh password', () => {
  assert.equal(
    authorizeSave({ actions: [notify, restart], confirmedRiskLevel: undefined, authTimeSeconds: nowSeconds, now }).ok,
    false,
  );

  // Confirmed at a milder level than the server classifies: refused.
  const milder = authorizeSave({ actions: [restart], confirmedRiskLevel: 'medium', authTimeSeconds: nowSeconds, now });
  assert.deepEqual(milder, { ok: false, risk: 'high', problem: 'confirmation' });

  const stale = authorizeSave({ actions: [restart], confirmedRiskLevel: 'high', authTimeSeconds: nowSeconds - 3600, now });
  assert.deepEqual(stale, { ok: false, risk: 'high', problem: 'reauthentication' });

  assert.deepEqual(
    authorizeSave({ actions: [restart], confirmedRiskLevel: 'high', authTimeSeconds: nowSeconds - 60, now }),
    { ok: true, risk: 'high' },
  );
});

test('a critical action can never be automated, however it is confirmed', () => {
  assert.deepEqual(
    authorizeSave({ actions: [forcedRestart], confirmedRiskLevel: 'critical', authTimeSeconds: nowSeconds, now }),
    { ok: false, risk: 'critical', problem: 'critical' },
  );
});

test('a run is refused once the authorizing device is revoked', () => {
  const verdict = authorizeRun({ actions: [restart], authorizedRisk: 'high', authorizingDeviceActive: false });
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, 'authority-revoked');
});

test('a run whose actions now classify above what was authorized is refused', () => {
  // Authorized as medium, now classifying high: an upgrade or a hand-edited row must not widen what
  // the owner agreed to.
  const verdict = authorizeRun({ actions: [restart], authorizedRisk: 'medium', authorizingDeviceActive: true });
  assert.equal(!verdict.ok && verdict.reason, 'risk-escalated');

  assert.deepEqual(authorizeRun({ actions: [restart], authorizedRisk: 'high', authorizingDeviceActive: true }), { ok: true, risk: 'high' });
});

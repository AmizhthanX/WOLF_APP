import {
  automationRisk,
  riskRank,
  SCHEDULE_GRACE_MINUTES,
  type AutomationAction,
  type AutomationCondition,
  type Weekday,
} from '@wolf/protocol';
import { policyFor, type RiskLevel } from '@wolf/shared-types';
import { readingsOf, type TelemetrySample } from '@wolf/telemetry-schema';

/**
 * Deciding whether an automation should run, and whether it still may.
 *
 * Pure: the clock, the latest telemetry and the stored authority are passed in. The job that calls
 * this owns the database; what lives here is the part where a wrong answer restarts somebody's
 * machine at the wrong time.
 */

/* ------------------------------------------------------------------------- */
/* Local time                                                                 */
/* ------------------------------------------------------------------------- */

export interface LocalTime {
  /** YYYY-MM-DD in the zone. */
  readonly date: string;
  /** HH:MM, 24-hour, in the zone. */
  readonly time: string;
  readonly weekday: Weekday;
  /** Minutes since local midnight. */
  readonly minuteOfDay: number;
}

const WEEKDAY_BY_SHORT: Readonly<Record<string, Weekday>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A moment as a wall clock in a zone reads it. */
export function localTime(at: Date, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }

  const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  const hour = parts['hour'] === '24' ? '00' : parts['hour']!;
  const minute = parts['minute']!;

  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    time: `${hour}:${minute}`,
    weekday: WEEKDAY_BY_SHORT[parts['weekday']!]!,
    minuteOfDay: Number(hour) * 60 + Number(minute),
  };
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/* ------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The scheduled local minute that is due now, if one is.
 *
 * Due means the wall clock in the automation's zone showed the scheduled time on a scheduled day at
 * some moment in the last {@link SCHEDULE_GRACE_MINUTES} minutes. The answer is a slot key — local
 * date and time — which the caller inserts into a table whose primary key is the deduplication.
 *
 * Daylight saving falls out of reading the wall clock rather than doing arithmetic on offsets:
 *
 * - a time that does not exist that day (02:30 on the night clocks go forward) never shows on the
 *   wall clock, so it does not run that day — there is no honest "02:30" to run at;
 * - a time that happens twice (01:30 on the night clocks go back) produces the same slot key both
 *   times, so it runs once.
 */
export function dueScheduleSlot(
  trigger: { readonly time: string; readonly days: readonly Weekday[]; readonly timeZone: string },
  now: Date,
  graceMinutes: number = SCHEDULE_GRACE_MINUTES,
): string | null {
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

  for (let back = 0; back < graceMinutes; back += 1) {
    const local = localTime(new Date(minuteStart - back * 60_000), trigger.timeZone);
    if (local.time === trigger.time && trigger.days.includes(local.weekday)) {
      return `${local.date}T${local.time}`;
    }
  }

  return null;
}

/* ------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* ------------------------------------------------------------------------- */

/** Telemetry older than this does not describe the machine now. */
export const CONDITION_TELEMETRY_MAX_AGE_MS = 2 * 60_000;

export interface ConditionContext {
  readonly now: Date;
  readonly latest: { readonly sampledAt: Date; readonly sample: TelemetrySample } | null;
  readonly activeSessions: number;
}

export type ConditionVerdict = { readonly met: true } | { readonly met: false; readonly detail: string };

export function inTimeWindow(
  condition: { readonly start: string; readonly end: string; readonly days: readonly Weekday[]; readonly timeZone: string },
  now: Date,
): boolean {
  const local = localTime(now, condition.timeZone);
  const start = minutesOf(condition.start);
  const end = minutesOf(condition.end);
  const minute = local.minuteOfDay;

  if (end > start) {
    return condition.days.includes(local.weekday) && minute >= start && minute < end;
  }

  // Spans midnight. The evening half belongs to today; the morning half to the window that
  // started yesterday, so it is yesterday's weekday that has to be selected.
  if (minute >= start) return condition.days.includes(local.weekday);
  if (minute < end) {
    const yesterday = ORDER[(ORDER.indexOf(local.weekday) + 6) % 7]!;
    return condition.days.includes(yesterday);
  }
  return false;
}

export function evaluateCondition(condition: AutomationCondition, context: ConditionContext): ConditionVerdict {
  switch (condition.kind) {
    case 'time-window':
      return inTimeWindow(condition, context.now)
        ? { met: true }
        : { met: false, detail: `Outside ${condition.start}–${condition.end} (${condition.timeZone}).` };

    case 'no-active-session':
      return context.activeSessions === 0
        ? { met: true }
        : { met: false, detail: 'Somebody is connected to the PC.' };

    case 'metric': {
      // No recent reading is not "below the line". An action nobody is watching does not run on a
      // guess about a machine that has stopped reporting.
      if (!context.latest || context.now.getTime() - context.latest.sampledAt.getTime() > CONDITION_TELEMETRY_MAX_AGE_MS) {
        return { met: false, detail: 'No recent telemetry from the PC.' };
      }

      const values = readingsOf(context.latest.sample)
        .filter((reading) => reading.metric === condition.metric)
        .filter((reading) => condition.seriesKey === null || reading.seriesKey === condition.seriesKey)
        .map((reading) => reading.value);

      if (values.length === 0) {
        return { met: false, detail: `The PC does not report ${condition.metric}${condition.seriesKey ? ` for ${condition.seriesKey}` : ''}.` };
      }

      const holds = values.every((value) =>
        condition.comparison === 'above' ? value > condition.threshold : value < condition.threshold,
      );

      return holds
        ? { met: true }
        : { met: false, detail: `${condition.metric} is not ${condition.comparison} ${condition.threshold}.` };
    }
  }
}

/** Every condition, in order; the first that fails is the reason. */
export function evaluateConditions(
  conditions: readonly AutomationCondition[],
  context: ConditionContext,
): ConditionVerdict {
  for (const condition of conditions) {
    const verdict = evaluateCondition(condition, context);
    if (!verdict.met) return verdict;
  }
  return { met: true };
}

/* ------------------------------------------------------------------------- */
/* Cooldowns                                                                  */
/* ------------------------------------------------------------------------- */

export function cooldownAllows(lastRunAt: Date | null, cooldownMinutes: number, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= cooldownMinutes * 60_000;
}

/* ------------------------------------------------------------------------- */
/* Authority                                                                  */
/* ------------------------------------------------------------------------- */

export type SaveAuthorization =
  | { readonly ok: true; readonly risk: RiskLevel }
  | { readonly ok: false; readonly risk: RiskLevel; readonly problem: 'critical' | 'confirmation' | 'reauthentication' };

/**
 * What saving (or enabling) an automation requires, given what the owner supplied.
 *
 * The same policy as a command sent by hand, applied once at the moment the decision is made:
 * the confirmed risk level must equal the server's classification, and a high-risk automation
 * needs a password entered within the policy's window.
 */
export function authorizeSave(input: {
  readonly actions: readonly AutomationAction[];
  readonly confirmedRiskLevel: RiskLevel | undefined;
  readonly authTimeSeconds: number;
  readonly now: Date;
}): SaveAuthorization {
  const risk = automationRisk(input.actions);
  if (risk === 'critical') return { ok: false, risk, problem: 'critical' };

  const policy = policyFor(risk);
  if (policy.requiresConfirmation && input.confirmedRiskLevel !== risk) {
    return { ok: false, risk, problem: 'confirmation' };
  }

  if (policy.requiresPasswordReauth) {
    const age = Math.floor(input.now.getTime() / 1000) - input.authTimeSeconds;
    if (age > policy.reauthMaxAgeSeconds) return { ok: false, risk, problem: 'reauthentication' };
  }

  return { ok: true, risk };
}

export type RunAuthority =
  | { readonly ok: true; readonly risk: RiskLevel }
  | { readonly ok: false; readonly reason: 'authority-revoked' | 'risk-escalated'; readonly detail: string };

/**
 * Whether a stored automation may still act, checked at every run.
 *
 * Classification is repeated rather than trusted from the save: a WOLF upgrade that decides stopping
 * some service is now critical must stop automations that stop it, not grandfather them in.
 */
export function authorizeRun(input: {
  readonly actions: readonly AutomationAction[];
  readonly authorizedRisk: RiskLevel;
  readonly authorizingDeviceActive: boolean;
}): RunAuthority {
  if (!input.authorizingDeviceActive) {
    return {
      ok: false,
      reason: 'authority-revoked',
      detail: 'The device that authorized this automation has been revoked.',
    };
  }

  const risk = automationRisk(input.actions);
  if (risk === 'critical' || riskRank(risk) > riskRank(input.authorizedRisk)) {
    return {
      ok: false,
      reason: 'risk-escalated',
      detail: `Its actions are now classified ${risk} risk, above the ${input.authorizedRisk} it was authorized for.`,
    };
  }

  return { ok: true, risk };
}

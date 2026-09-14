import type { AlertCondition, AlertSeverity } from '@wolf/protocol';
import { readingsOf, type TelemetrySample } from '@wolf/telemetry-schema';

/**
 * Deciding whether an alert rule holds, and what to do about it.
 *
 * Pure: no database, no clock, no I/O. The job that calls this owns all three; what lives here
 * is the part where a wrong answer is either a notification nobody should have received or,
 * worse, silence when somebody should have been told.
 */

/** What one evaluation concluded. */
export type Verdict =
  | { readonly kind: 'breaching'; readonly value: number }
  | { readonly kind: 'clear'; readonly value: number | null }
  /**
   * Not enough data to say either way.
   *
   * The third answer, and the one that matters most. Treating "no data" as "fine" resolves an
   * alert the moment a machine stops reporting — which is exactly when somebody needs it most.
   */
  | { readonly kind: 'unknown'; readonly reason: string };

export interface RuleShape {
  readonly condition: AlertCondition;
  readonly metric: string | null;
  readonly threshold: number | null;
  readonly forMinutes: number;
}

/**
 * How much of the sustain window the samples have to cover.
 *
 * Ninety percent, not all of it. Samples do not land exactly on window edges, and demanding a
 * sample at the very first second would make a rule never fire on a machine that is otherwise
 * reporting normally. Much less than this and an agent that reconnected thirty seconds ago with
 * two samples above the line could fire a rule that asked for half an hour.
 */
export const REQUIRED_COVERAGE = 0.9;

/** Fewest samples that can describe a sustained condition at all. */
export const MIN_SAMPLES = 2;

/**
 * The smallest hole between samples that is still tolerated, however short the window.
 *
 * Ten percent of a one-minute window is six seconds, and an agent sampling every five seconds
 * over a slow link misses that routinely. A minute is the floor.
 */
export const MIN_GAP_TOLERANCE_MS = 60_000;

/**
 * Every value of one metric in a window, grouped by series.
 *
 * Uses the rollup's own definition of what each metric means, so a rule about
 * `disk.usedPercent` is judged on exactly the number the history chart draws.
 */
export function seriesValues(
  samples: readonly { readonly sampledAt: Date; readonly sample: TelemetrySample }[],
  metric: string,
): Map<string | null, { at: Date; value: number }[]> {
  const series = new Map<string | null, { at: Date; value: number }[]>();

  for (const entry of samples) {
    for (const reading of readingsOf(entry.sample)) {
      if (reading.metric !== metric) continue;

      let values = series.get(reading.seriesKey);
      if (!values) {
        values = [];
        series.set(reading.seriesKey, values);
      }

      values.push({ at: entry.sampledAt, value: reading.value });
    }
  }

  return series;
}

/**
 * Whether a metric has been over (or under) its line for the whole window.
 *
 * *The whole window*: a single sample back under the threshold clears it. That is the meaning of
 * "sustained", and it errs towards not notifying — a rule for "CPU above 90% for 10 minutes"
 * should not fire on a machine that dipped to 40% at minute seven.
 */
export function judgeMetric(
  rule: RuleShape,
  values: readonly { at: Date; value: number }[],
  now: Date,
): Verdict {
  if (rule.threshold === null) {
    return { kind: 'unknown', reason: 'The rule has no threshold.' };
  }

  const windowMs = rule.forMinutes * 60_000;
  const windowStart = now.getTime() - windowMs;
  const inWindow = values.filter((entry) => entry.at.getTime() >= windowStart && entry.at.getTime() <= now.getTime());

  if (inWindow.length < MIN_SAMPLES) {
    return { kind: 'unknown', reason: 'Not enough samples in the window to judge.' };
  }

  const first = Math.min(...inWindow.map((entry) => entry.at.getTime()));
  const last = Math.max(...inWindow.map((entry) => entry.at.getTime()));

  // Coverage is measured from the first sample to now rather than first to last: a machine that
  // reported for the first half of the window and then went silent has not been observed for
  // the second half, and saying it breached "for the whole window" would be a guess.
  const covered = (now.getTime() - first) / windowMs;
  const stale = (now.getTime() - last) / windowMs;

  if (covered < REQUIRED_COVERAGE || stale > 1 - REQUIRED_COVERAGE) {
    return { kind: 'unknown', reason: 'The samples do not cover enough of the window.' };
  }

  // Edges are not enough: a machine that reported at both ends of a day and was off for three
  // hours in the middle was not observed breaching "for 24 hours". Any hole wider than the slack
  // the edges are allowed makes the answer unknown.
  const allowedGap = Math.max(windowMs * (1 - REQUIRED_COVERAGE), MIN_GAP_TOLERANCE_MS);
  const times = inWindow.map((entry) => entry.at.getTime()).sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! - times[index - 1]! > allowedGap) {
      return { kind: 'unknown', reason: 'The samples have a gap inside the window.' };
    }
  }

  const above = rule.condition === 'metric-above';

  // The value reported is the one that decided the answer: the least extreme sample for a
  // breach (it still crossed the line, so everything did), and the latest for a clear.
  if (above) {
    const lowest = Math.min(...inWindow.map((entry) => entry.value));
    if (lowest > rule.threshold) return { kind: 'breaching', value: lowest };
  } else {
    const highest = Math.max(...inWindow.map((entry) => entry.value));
    if (highest < rule.threshold) return { kind: 'breaching', value: highest };
  }

  const latest = inWindow.reduce((newest, entry) => (entry.at > newest.at ? entry : newest));
  return { kind: 'clear', value: latest.value };
}

/**
 * Whether a PC has been offline for the whole sustain window.
 *
 * Unknown for a PC that has never been seen: there is no "since" to measure from, and a rule
 * that fired on a machine still being enrolled would be noise from the first minute.
 */
export function judgeOffline(
  rule: RuleShape,
  pc: { readonly status: string; readonly lastSeenAt: Date | null },
  now: Date,
): Verdict {
  if (pc.status === 'online') return { kind: 'clear', value: null };

  if (pc.lastSeenAt === null) {
    return { kind: 'unknown', reason: 'The PC has never been seen.' };
  }

  const minutesAway = (now.getTime() - pc.lastSeenAt.getTime()) / 60_000;

  return minutesAway >= rule.forMinutes
    ? { kind: 'breaching', value: Math.floor(minutesAway) }
    : { kind: 'clear', value: null };
}

/** The last answer recorded for one rule, PC and series. */
export interface AlertState {
  readonly state: 'ok' | 'firing';
  readonly lastNotifiedAt: Date | null;
  /** Whether the current firing produced a notification. */
  readonly notified: boolean;
}

/** What should happen as a result of an evaluation. */
export type Transition =
  | { readonly kind: 'none' }
  /** Start firing, and tell the owner. */
  | { readonly kind: 'fire'; readonly notify: true }
  /**
   * Start firing, but say nothing — the cooldown since the last notification has not passed.
   *
   * Recorded rather than ignored, so that the alert is visibly firing and so that clearing it
   * later does not produce a "resolved" for something the owner was never told about.
   */
  | { readonly kind: 'fire'; readonly notify: false }
  /** Stop firing. Notify only if the firing did. */
  | { readonly kind: 'resolve'; readonly notify: boolean };

/**
 * The state machine.
 *
 * Two states, three verdicts. Unknown never moves anything; that single rule is what keeps a
 * machine that stopped reporting from quietly resolving its own alerts.
 */
export function transition(
  current: AlertState | null,
  verdict: Verdict,
  cooldownMinutes: number,
  now: Date,
): Transition {
  if (verdict.kind === 'unknown') return { kind: 'none' };

  const firing = current?.state === 'firing';

  if (verdict.kind === 'breaching') {
    if (firing) return { kind: 'none' };

    const lastNotified = current?.lastNotifiedAt ?? null;
    const coolingDown =
      lastNotified !== null && now.getTime() - lastNotified.getTime() < cooldownMinutes * 60_000;

    return coolingDown ? { kind: 'fire', notify: false } : { kind: 'fire', notify: true };
  }

  if (!firing) return { kind: 'none' };

  return { kind: 'resolve', notify: current?.notified ?? false };
}

const METRIC_LABELS: Readonly<Record<string, { label: string; unit: string }>> = {
  'cpu.usage': { label: 'CPU usage', unit: '%' },
  'cpu.temperature': { label: 'CPU temperature', unit: '°C' },
  'memory.used': { label: 'Memory used', unit: ' bytes' },
  'memory.usedPercent': { label: 'Memory used', unit: '%' },
  'gpu.usage': { label: 'GPU usage', unit: '%' },
  'gpu.vramUsed': { label: 'GPU memory used', unit: ' bytes' },
  'gpu.temperature': { label: 'GPU temperature', unit: '°C' },
  'disk.usedPercent': { label: 'Disk used', unit: '%' },
  'disk.activeTime': { label: 'Disk active time', unit: '%' },
  'network.receiveRate': { label: 'Network receive', unit: ' B/s' },
  'network.sendRate': { label: 'Network send', unit: ' B/s' },
  'battery.charge': { label: 'Battery charge', unit: '%' },
  'agent.cpu': { label: 'WOLF agent CPU', unit: '%' },
  'agent.memory': { label: 'WOLF agent memory', unit: ' bytes' },
};

function formatValue(value: number, unit: string): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

/**
 * The words of a notification.
 *
 * Built from fixed templates and the rule's facts. Nothing here reads from a terminal, a file, a
 * clipboard or an event log, because nothing a rule evaluates carries any of those.
 */
export function describe(input: {
  readonly kind: 'fired' | 'resolved';
  readonly ruleName: string;
  readonly pcName: string;
  readonly condition: AlertCondition;
  readonly metric: string | null;
  readonly seriesKey: string | null;
  readonly threshold: number | null;
  readonly forMinutes: number;
  readonly value: number | null;
  readonly severity: AlertSeverity;
}): { title: string; detail: string } {
  const where = input.seriesKey ? ` (${input.seriesKey})` : '';

  if (input.condition === 'pc-offline') {
    return input.kind === 'fired'
      ? {
          title: `${input.pcName} is offline`,
          detail: `${input.pcName} has not been seen for ${input.value ?? input.forMinutes} minutes. Rule: ${input.ruleName}.`,
        }
      : {
          title: `${input.pcName} is back online`,
          detail: `${input.pcName} is reporting again. Rule: ${input.ruleName}.`,
        };
  }

  const known = METRIC_LABELS[input.metric ?? ''] ?? { label: input.metric ?? 'A metric', unit: '' };
  const line = input.threshold === null ? '' : formatValue(input.threshold, known.unit);
  const value = input.value === null ? 'unknown' : formatValue(input.value, known.unit);
  const direction = input.condition === 'metric-above' ? 'above' : 'below';

  return input.kind === 'fired'
    ? {
        title: `${known.label}${where} on ${input.pcName} is ${direction} ${line}`,
        detail: `${known.label}${where} has stayed ${direction} ${line} for ${input.forMinutes} minutes, reaching ${value}. Rule: ${input.ruleName}.`,
      }
    : {
        title: `${known.label}${where} on ${input.pcName} is back to normal`,
        detail: `${known.label}${where} is no longer ${direction} ${line}; the latest reading is ${value}. Rule: ${input.ruleName}.`,
      };
}

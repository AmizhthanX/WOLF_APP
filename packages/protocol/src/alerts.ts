import { z } from 'zod';
import { AGGREGATED_METRICS } from '@wolf/telemetry-schema';

/**
 * Alert rules, and the notifications they produce.
 *
 * A rule is a question WOLF keeps asking on the owner's behalf: *has this PC's disk been more
 * than 90% full for the last half hour? has this machine been offline for ten minutes?* When
 * the answer changes, the owner is told — once — and told again when it changes back.
 *
 * ## Three answers, not two
 *
 * Every evaluation is *breaching*, *clear*, or **unknown**. Unknown is what happens when there
 * is not enough data to say: an agent that has just reconnected with one sample, a PC whose
 * sensor reports nothing. Unknown changes nothing — a firing alert stays firing and a quiet one
 * stays quiet. The alternative, treating "no data" as "fine", resolves an alert the moment a
 * machine stops reporting, which is exactly when somebody most needs it to stay up.
 *
 * ## What a notification carries
 *
 * A PC's name, a metric, a number, a threshold. Never content: nothing from a terminal, a file,
 * a clipboard or an event log reaches a rule, because rules are evaluated over telemetry and
 * presence and nothing else. The rule's own name is the owner's text, shown back to the owner.
 *
 * ## Delivered in the app, for now
 *
 * Notifications land in an inbox in the web app. E-mail, push and webhooks are not built. Each
 * is a real piece of design rather than a transport to bolt on: e-mail needs secret-managed
 * credentials, push needs the Android client, and a webhook is an owner-configured URL that the
 * cloud would make requests to — which is a server-side request forgery surface until it is
 * designed as one.
 */

export const ALERT_CONDITIONS = ['metric-above', 'metric-below', 'pc-offline'] as const;
export const alertCondition = z.enum(ALERT_CONDITIONS);
export type AlertCondition = z.infer<typeof alertCondition>;

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const alertSeverity = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof alertSeverity>;

/**
 * Rules one owner may hold.
 *
 * Every enabled rule is evaluated every minute against every PC it targets, so the count is a
 * bound on work the cloud does unprompted. A hundred is far more than a person maintains by
 * hand and small enough that a runaway script creating rules cannot make evaluation fall behind.
 */
export const MAX_ALERT_RULES = 100;

/**
 * How long a condition has to hold before it counts.
 *
 * A minute is the shortest window that means anything with samples every few seconds; a day is
 * the longest that raw samples reliably cover. A CPU at 100% for four seconds is a compile, not
 * an incident, and a rule with no sustain window would notify on every one.
 */
export const MIN_SUSTAIN_MINUTES = 1;
export const MAX_SUSTAIN_MINUTES = 1440;

/**
 * The shortest gap between two notifications for the same rule, PC and series.
 *
 * Five minutes at least. A metric hovering at its threshold crosses it constantly, and without a
 * floor a flapping rule is a notification every minute — which trains the owner to ignore the
 * inbox, which is worse than having no rule.
 */
export const MIN_COOLDOWN_MINUTES = 5;
export const MAX_COOLDOWN_MINUTES = 10_080;

const ruleFields = {
  name: z.string().trim().min(1).max(120),
  /** A single PC, or null for every PC on the account — including ones enrolled later. */
  pcId: z.string().length(26).nullable().default(null),
  condition: alertCondition,
  /** Required for the metric conditions; ignored for `pc-offline`. */
  metric: z.enum(AGGREGATED_METRICS).nullable().default(null),
  /**
   * One disk, one GPU, one adapter — or null for every series of the metric, each judged on its
   * own. "Any disk over 90%" is the common rule and it is the null case.
   */
  seriesKey: z.string().max(128).nullable().default(null),
  threshold: z.number().finite().nullable().default(null),
  forMinutes: z.number().int().min(MIN_SUSTAIN_MINUTES).max(MAX_SUSTAIN_MINUTES),
  severity: alertSeverity.default('warning'),
  cooldownMinutes: z.number().int().min(MIN_COOLDOWN_MINUTES).max(MAX_COOLDOWN_MINUTES).default(60),
  enabled: z.boolean().default(true),
};

/**
 * A metric rule has to say which metric and where the line is; an offline rule has neither.
 *
 * Checked here rather than left for the evaluator to shrug at, because a rule that cannot fire
 * is a rule its owner believes is watching something.
 */
function coherent(
  rule: { condition: AlertCondition; metric: string | null; threshold: number | null },
  context: z.RefinementCtx,
): void {
  if (rule.condition === 'pc-offline') return;

  if (rule.metric === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['metric'], message: 'A metric rule needs a metric.' });
  }

  if (rule.threshold === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['threshold'],
      message: 'A metric rule needs a threshold.',
    });
  }
}

export const alertRuleInput = z.object(ruleFields).superRefine(coherent);
export type AlertRuleInput = z.infer<typeof alertRuleInput>;

/** A partial update. Coherence is checked against the merged rule, not the patch. */
export const alertRulePatch = z.object(ruleFields).partial();
export type AlertRulePatch = z.infer<typeof alertRulePatch>;

export const alertRule = z.object({
  id: z.string().length(26),
  ...ruleFields,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertRule = z.infer<typeof alertRule>;

/** `automation`: written by an automation's notify action, or to say one failed or was turned off. */
export const NOTIFICATION_KINDS = ['fired', 'resolved', 'automation'] as const;
export const notificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKind>;

export const notification = z.object({
  id: z.string().length(26),
  /** Null once the rule has been deleted; the notification outlives it on purpose. */
  ruleId: z.string().length(26).nullable(),
  automationId: z.string().length(26).nullable(),
  pcId: z.string().length(26).nullable(),
  kind: notificationKind,
  severity: alertSeverity,
  title: z.string().max(200),
  detail: z.string().max(500),
  metric: z.string().max(64).nullable(),
  seriesKey: z.string().max(128).nullable(),
  /** The value that crossed the line, or that came back under it. */
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  occurredAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof notification>;

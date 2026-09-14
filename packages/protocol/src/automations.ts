import { z } from 'zod';
import { RISK_LEVELS, type RiskLevel } from '@wolf/shared-types';
import { AGGREGATED_METRICS } from '@wolf/telemetry-schema';
import { agentCommandBody, classifyRisk, type AgentCommandBody } from './commands/index.js';

/**
 * Automations: when something happens, and these conditions hold, do these things.
 *
 * ## What an automation may do
 *
 * Nobody is watching when an automation acts, so the question is not only "may the owner do this"
 * but "may the owner decide *now* that this happens *later*, unattended". The answers:
 *
 * - **Low and medium risk** — yes. The confirmation a person would have given is given once, when
 *   the automation is saved, for the exact risk level the server classifies.
 * - **High risk** — yes, with the owner's password re-entered at save time. Restarting a machine at
 *   three in the morning is the use case that makes automation worth having.
 * - **Critical risk — never.** A critical action requires a single-use privileged grant, and the
 *   point of single use is that one decision authorizes one action. An automation that could fire
 *   one every night would turn a grant into a standing permission.
 *
 * Only commands on {@link AUTOMATABLE_COMMANDS} can be automated at all. The list excludes anything
 * that names a live identifier: a PID read now describes a different process tomorrow, and there is
 * no "terminate by name" command to fall back on — inventing one here would be a way round the
 * PID-reuse guard.
 *
 * ## What an automation is not
 *
 * It is not a script. Every action is a typed command already on the allow-list, validated against
 * the same schema, classified by the same function and delivered on the same path as one a person
 * sends. Nothing here executes arbitrary text.
 */

/** Commands an automation may carry. Everything else is refused at save time. */
export const AUTOMATABLE_COMMANDS = [
  'power.action',
  'service.control',
  'task.control',
  'startup.set-enabled',
] as const satisfies readonly AgentCommandBody['type'][];

export type AutomatableCommandType = (typeof AUTOMATABLE_COMMANDS)[number];

export function isAutomatableCommand(type: string): type is AutomatableCommandType {
  return (AUTOMATABLE_COMMANDS as readonly string[]).includes(type);
}

export const MAX_AUTOMATIONS = 50;
export const MAX_AUTOMATION_ACTIONS = 5;
export const MAX_AUTOMATION_CONDITIONS = 5;
export const MAX_AUTOMATION_TARGETS = 20;

/**
 * How long after a scheduled minute a run may still start.
 *
 * An API instance restarting at 02:59 must not skip a 03:00 run, and one that was down until 09:00
 * must not shut the machine down six hours late in the middle of the working day. Commands in WOLF
 * never run late; scheduled automations inherit that.
 */
export const SCHEDULE_GRACE_MINUTES = 5;

/** An alert event older than this when it is picked up is dropped, for the same reason. */
export const EVENT_MAX_AGE_MINUTES = 5;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time of day as HH:MM, 24-hour');
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const weekdays = z.array(z.enum(WEEKDAYS)).min(1).max(7);
const timeZone = z.string().min(1).max(64).refine(isValidTimeZone, 'Not a time zone this server knows');

/* ------------------------------------------------------------------------- */
/* Triggers                                                                   */
/* ------------------------------------------------------------------------- */

export const scheduleTrigger = z.object({
  kind: z.literal('schedule'),
  /** Local time in {@link timeZone}. */
  time: clockTime,
  days: weekdays,
  timeZone,
});

export const alertTrigger = z.object({
  kind: z.literal('alert'),
  /** One rule, or null for any of the owner's rules. */
  ruleId: z.string().length(26).nullable().default(null),
  on: z.enum(['fired', 'resolved']).default('fired'),
});

/** Only when the owner presses "Run now". */
export const manualTrigger = z.object({ kind: z.literal('manual') });

export const automationTrigger = z.discriminatedUnion('kind', [scheduleTrigger, alertTrigger, manualTrigger]);
export type AutomationTrigger = z.infer<typeof automationTrigger>;
export const TRIGGER_KINDS = ['schedule', 'alert', 'manual'] as const;

/* ------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* ------------------------------------------------------------------------- */

export const timeWindowCondition = z.object({
  kind: z.literal('time-window'),
  /** Inclusive start; an end at or before the start spans midnight. */
  start: clockTime,
  end: clockTime,
  /** The day the window *starts* on. */
  days: weekdays,
  timeZone,
});

export const metricCondition = z.object({
  kind: z.literal('metric'),
  metric: z.enum(AGGREGATED_METRICS),
  /**
   * One device, or null. With null, every device reporting the metric must satisfy it — the
   * conservative reading for an action nobody is watching.
   */
  seriesKey: z.string().max(128).nullable().default(null),
  comparison: z.enum(['above', 'below']),
  threshold: z.number().finite(),
});

/** Nobody is connected to the PC. Restarting a machine under somebody's remote session is rude. */
export const noActiveSessionCondition = z.object({ kind: z.literal('no-active-session') });

export const automationCondition = z.discriminatedUnion('kind', [
  timeWindowCondition,
  metricCondition,
  noActiveSessionCondition,
]);
export type AutomationCondition = z.infer<typeof automationCondition>;

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

export const notifyAction = z.object({
  kind: z.literal('notify'),
  severity: z.enum(['info', 'warning', 'critical']).default('info'),
  /** The owner's own words, shown in their own inbox. */
  message: z.string().trim().min(1).max(200),
});

export const commandAction = z.object({
  kind: z.literal('command'),
  command: agentCommandBody.refine((command) => isAutomatableCommand(command.type), {
    message: `Only ${AUTOMATABLE_COMMANDS.join(', ')} can be automated.`,
  }),
});

export const automationAction = z.discriminatedUnion('kind', [notifyAction, commandAction]);
export type AutomationAction = z.infer<typeof automationAction>;

/* ------------------------------------------------------------------------- */
/* Targets                                                                    */
/* ------------------------------------------------------------------------- */

export const automationTargets = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('pcs'),
    pcIds: z.array(z.string().length(26)).min(1).max(MAX_AUTOMATION_TARGETS),
  }),
  /**
   * The PC the triggering alert fired for. Deliberately there is no "every PC" mode: an automation
   * that restarts every machine on the account, including ones enrolled next year, is a decision
   * nobody should make once and forget.
   */
  z.object({ mode: z.literal('alert-pc') }),
]);
export type AutomationTargets = z.infer<typeof automationTargets>;

/* ------------------------------------------------------------------------- */
/* The automation                                                             */
/* ------------------------------------------------------------------------- */

const automationFields = {
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: automationTrigger,
  conditions: z.array(automationCondition).max(MAX_AUTOMATION_CONDITIONS).default([]),
  actions: z.array(automationAction).min(1).max(MAX_AUTOMATION_ACTIONS),
  targets: automationTargets,
  /** Least time between two runs on the same PC. */
  cooldownMinutes: z.number().int().min(1).max(10_080).default(60),
  /**
   * Most runs across all PCs in 24 hours. A backstop against a trigger storm — an alert flapping
   * all night — that a per-PC cooldown alone does not bound on a many-PC automation.
   */
  maxRunsPerDay: z.number().int().min(1).max(96).default(4),
};

const RANK: Readonly<Record<RiskLevel, number>> = Object.fromEntries(
  RISK_LEVELS.map((level, index) => [level, index]),
) as Record<RiskLevel, number>;

export function riskRank(level: RiskLevel): number {
  return RANK[level];
}

/** The highest risk among an automation's actions. Notifications are low. */
export function automationRisk(actions: readonly AutomationAction[]): RiskLevel {
  let highest: RiskLevel = 'low';
  for (const action of actions) {
    if (action.kind !== 'command') continue;
    const risk = classifyRisk(action.command);
    if (RANK[risk] > RANK[highest]) highest = risk;
  }
  return highest;
}

type AutomationShape = z.infer<z.ZodObject<typeof automationFields>>;

function coherent(automation: AutomationShape, context: z.RefinementCtx): void {
  if (automation.targets.mode === 'alert-pc' && automation.trigger.kind !== 'alert') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targets'],
      message: '"The PC the alert fired for" needs an alert trigger.',
    });
  }

  automation.actions.forEach((action, index) => {
    if (action.kind === 'command' && classifyRisk(action.command) === 'critical') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions', index],
        message:
          'This action is critical risk, which needs a single-use privileged grant each time. It cannot be automated.',
      });
    }
  });

  if (automation.targets.mode === 'pcs' && new Set(automation.targets.pcIds).size !== automation.targets.pcIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targets', 'pcIds'], message: 'A PC is listed twice.' });
  }
}

export const automationInput = z.object(automationFields).superRefine(coherent);
export type AutomationInput = z.infer<typeof automationInput>;

/** A partial update; coherence is checked on the merged automation. */
export const automationPatch = z.object(automationFields).partial();

/**
 * Saving or enabling an automation is the moment its authority is granted, so it carries the same
 * confirmation a command does: the risk level the owner was shown, which must equal the server's.
 */
export const saveAutomationBody = z.object({
  automation: z.unknown(),
  confirmedRiskLevel: z.enum(RISK_LEVELS).optional(),
});

export const automation = z.object({
  id: z.string().length(26),
  ...automationFields,
  /** The risk level the owner confirmed. A run whose actions classify higher is refused. */
  authorizedRiskLevel: z.enum(RISK_LEVELS),
  authorizedAt: z.string(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Automation = z.infer<typeof automation>;

/* ------------------------------------------------------------------------- */
/* Runs                                                                       */
/* ------------------------------------------------------------------------- */

export const AUTOMATION_RUN_STATUSES = ['running', 'completed', 'failed', 'skipped', 'interrupted'] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** Why a run did not do its actions. Stable codes; the UI words them. */
export const AUTOMATION_SKIP_REASONS = [
  'cooldown',
  'daily-limit',
  'condition-not-met',
  'pc-offline',
  'kill-switch',
  'pc-unavailable',
  'unsupported-command',
  'authority-revoked',
  'risk-escalated',
  'resource-held',
  'stale-trigger',
] as const;
export type AutomationSkipReason = (typeof AUTOMATION_SKIP_REASONS)[number];

export const automationStep = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(['notify', 'command']),
  status: z.enum(['completed', 'failed', 'skipped']),
  commandId: z.string().nullable(),
  commandType: z.string().nullable(),
  /** Error code or short fixed description. Never a command result. */
  detail: z.string().max(300).nullable(),
});
export type AutomationStep = z.infer<typeof automationStep>;

export const automationRun = z.object({
  id: z.string().length(26),
  automationId: z.string().length(26),
  pcId: z.string().nullable(),
  triggerKind: z.enum(TRIGGER_KINDS),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  reason: z.string().nullable(),
  steps: z.array(automationStep),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof automationRun>;

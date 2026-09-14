import { z } from 'zod';
import { RISK_LEVELS, type RiskLevel } from '@wolf/shared-types';
import { displayName, tag } from '@wolf/validation';
import { MAX_ALERT_RULES, alertRuleInput } from './alerts.js';
import { MAX_AUTOMATIONS, automationInput } from './automations.js';
import { remoteDesktopProfile } from './remote-desktop.js';

/**
 * Configuration backup and restore.
 *
 * ## What a backup is
 *
 * The configuration the owner wrote, and nothing else: what their PCs are called and tagged, their
 * remote desktop profiles, their alert rules and their automations. It is generated on request and
 * handed to the browser; the cloud keeps no copy.
 *
 * ## What a backup is not
 *
 * - **Not credentials.** No password hash, token, device key, PC key or enrollment token is ever in
 *   one, so a backup file is not a way into anything and needs no encryption to be safe to keep.
 * - **Not history.** No telemetry, audit, notifications, sessions, commands or automation runs.
 * - **Not PCs.** A PC's identity is a key it generated at enrollment. A file cannot recreate that,
 *   so a restore applies names and tags to PCs that are still enrolled and says which are not.
 * - **Not authority.** An automation in a backup is a definition. Restoring it records a new
 *   authority from the restoring device, and restored automations come back turned off unless the
 *   owner confirms turning them on — at the risk level of the riskiest one.
 *
 * ## Integrity
 *
 * A backup carries a SHA-256 checksum of its content. That catches a damaged or hand-edited file; it
 * is not a signature, because anyone can recompute it. What protects a restore is that every item is
 * validated against the same schemas as when it was first saved — a critical action in a doctored
 * automation is refused exactly as it would be from the API — and that no authority comes from the
 * file.
 */

export const CONFIGURATION_FORMAT = 'wolf.configuration';
export const CONFIGURATION_VERSION = 1;

export const CONFIGURATION_SECTIONS = ['pcs', 'remoteDesktopProfiles', 'alertRules', 'automations'] as const;
export type ConfigurationSection = (typeof CONFIGURATION_SECTIONS)[number];

export const MAX_BACKUP_PCS = 500;
export const MAX_BACKUP_PROFILES = 50;

const id = z.string().length(26);

/** JSON with object keys sorted, so the same content always has the same checksum. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const backupPc = z.object({
  id,
  name: displayName,
  tags: z.array(tag).max(20).default([]),
  favorite: z.boolean().default(false),
});

export const backupProfile = z.object({
  id,
  name: displayName,
  settings: remoteDesktopProfile,
  isDefault: z.boolean().default(false),
});

export const backupAlertRule = z.object({ id, rule: alertRuleInput });
export const backupAutomation = z.object({ id, automation: automationInput });

function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

export const configurationContent = z
  .object({
    pcs: z.array(backupPc).max(MAX_BACKUP_PCS),
    remoteDesktopProfiles: z.array(backupProfile).max(MAX_BACKUP_PROFILES),
    alertRules: z.array(backupAlertRule).max(MAX_ALERT_RULES),
    automations: z.array(backupAutomation).max(MAX_AUTOMATIONS),
  })
  .superRefine((content, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (!unique(content.pcs, (pc) => pc.id)) issue('pcs', 'A PC appears twice.');
    if (!unique(content.pcs, (pc) => pc.name)) issue('pcs', 'Two PCs have the same name.');
    if (!unique(content.remoteDesktopProfiles, (profile) => profile.id)) issue('remoteDesktopProfiles', 'A profile appears twice.');
    if (!unique(content.remoteDesktopProfiles, (profile) => profile.name)) issue('remoteDesktopProfiles', 'Two profiles have the same name.');
    if (content.remoteDesktopProfiles.filter((profile) => profile.isDefault).length > 1) {
      issue('remoteDesktopProfiles', 'More than one profile is the default.');
    }
    if (!unique(content.alertRules, (rule) => rule.id)) issue('alertRules', 'An alert rule appears twice.');
    if (!unique(content.automations, (automation) => automation.id)) issue('automations', 'An automation appears twice.');
  });
export type ConfigurationContent = z.infer<typeof configurationContent>;

/**
 * The file. The content is checked separately from the envelope so that a backup from a newer WOLF
 * is refused with that reason rather than as a pile of schema errors.
 */
export const configurationBackup = z.object({
  format: z.literal(CONFIGURATION_FORMAT),
  version: z.number().int(),
  createdAt: z.string(),
  /** SHA-256 of {@link canonicalJson} of `content`. Detects damage; it is not a signature. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.unknown(),
});
export type ConfigurationBackup = z.infer<typeof configurationBackup>;

export const restoreRequest = z.object({
  backup: z.unknown(),
  sections: z.array(z.enum(CONFIGURATION_SECTIONS)).min(1).max(CONFIGURATION_SECTIONS.length),
  /**
   * Restored automations come back turned off unless this is set. Setting it makes the restore the
   * moment those automations are authorized, confirmed at the risk of the riskiest one.
   */
  enableAutomations: z.boolean().default(false),
  confirmedRiskLevel: z.enum(RISK_LEVELS).optional(),
});

export const RESTORE_WARNING_CODES = [
  'pc-not-enrolled',
  'pc-name-taken',
  'rule-pc-missing',
  'automation-pcs-missing',
  'automation-rule-missing',
] as const;
export type RestoreWarningCode = (typeof RESTORE_WARNING_CODES)[number];

export interface RestoreSectionCounts {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
}

export interface RestoreWarning {
  readonly code: RestoreWarningCode;
  readonly section: ConfigurationSection;
  readonly id: string;
  readonly message: string;
}

/** What a restore will do, shown before it does it. */
export interface RestorePlan {
  readonly sections: Partial<Record<ConfigurationSection, RestoreSectionCounts>>;
  readonly warnings: readonly RestoreWarning[];
  /** Restored automations that will be turned on. */
  readonly automationsEnabled: number;
  /** The risk level the restore must be confirmed at. */
  readonly riskLevel: RiskLevel;
}

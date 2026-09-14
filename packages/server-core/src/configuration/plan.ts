import { createHash } from 'node:crypto';
import {
  CONFIGURATION_VERSION,
  automationRisk,
  canonicalJson,
  configurationBackup,
  configurationContent,
  type AlertRuleInput,
  type AutomationInput,
  type ConfigurationContent,
  type ConfigurationSection,
  type RestorePlan,
  type RestoreSectionCounts,
  type RestoreWarning,
} from '@wolf/protocol';
import { maxRisk, policyFor, type RiskLevel } from '@wolf/shared-types';

/**
 * Checking a backup, and working out what restoring it would do.
 *
 * Pure apart from hashing. The repository reads the current configuration and writes the result;
 * the decisions — which PCs still exist, which names would collide, which automations lose their
 * targets or their rule, and what the restore has to be confirmed at — are made here, where they are
 * tested without a database.
 */

export function configurationChecksum(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export type BackupVerdict =
  | { readonly ok: true; readonly content: ConfigurationContent }
  | { readonly ok: false; readonly problem: string; readonly cause: string };

/** Envelope, version, checksum, then every item against its schema — in that order. */
export function verifyBackup(file: unknown): BackupVerdict {
  const envelope = configurationBackup.safeParse(file);
  if (!envelope.success) {
    return {
      ok: false,
      problem: 'This is not a WOLF configuration backup.',
      cause: 'The file does not have the format of a backup made by WOLF.',
    };
  }

  const { version, checksum, content } = envelope.data;

  if (version > CONFIGURATION_VERSION || version < 1) {
    return {
      ok: false,
      problem: 'This backup was made by a different version of WOLF.',
      cause: `It is backup format ${version}; this server reads format ${CONFIGURATION_VERSION}.`,
    };
  }

  if (configurationChecksum(content) !== checksum) {
    return {
      ok: false,
      problem: 'The backup file has been changed or damaged.',
      cause: 'Its contents do not match the checksum written when it was made.',
    };
  }

  const parsed = configurationContent.safeParse(content);
  if (!parsed.success) {
    return {
      ok: false,
      problem: 'The backup contains configuration WOLF will not accept.',
      cause: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'backup'}: ${issue.message}`)
        .join('; '),
    };
  }

  return { ok: true, content: parsed.data };
}

/** What exists on the account now, as far as a restore cares. */
export interface CurrentConfiguration {
  /** Every PC, revoked ones included: their names still count against uniqueness. */
  readonly pcs: readonly { readonly id: string; readonly name: string; readonly active: boolean }[];
  readonly profileIds: readonly string[];
  readonly alertRuleIds: readonly string[];
  readonly automations: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly ruleId: string | null;
  }[];
}

export interface RestoreWork {
  readonly plan: RestorePlan;
  readonly pcUpdates: readonly { readonly id: string; readonly name: string; readonly tags: readonly string[]; readonly favorite: boolean }[];
  readonly profiles: ConfigurationContent['remoteDesktopProfiles'];
  readonly rules: readonly { readonly id: string; readonly rule: AlertRuleInput }[];
  readonly automations: readonly { readonly id: string; readonly automation: AutomationInput; readonly risk: RiskLevel }[];
  /** Existing automations, not being restored, whose alert rule the restore removes. */
  readonly disableAutomationIds: readonly string[];
}

function counts(current: readonly string[], restored: readonly string[], skipped: number): RestoreSectionCounts {
  const existing = new Set(current);
  const kept = new Set(restored);
  return {
    created: restored.filter((id) => !existing.has(id)).length,
    updated: restored.filter((id) => existing.has(id)).length,
    deleted: current.filter((id) => !kept.has(id)).length,
    skipped,
  };
}

/**
 * Work out a restore.
 *
 * Each chosen section is replaced by the backup's: items in both are updated in place (keeping their
 * ids, so an automation's run history and an alert's notifications stay attached), items only in the
 * backup are created, items only on the account are deleted. PCs are the exception — they are never
 * created or deleted, only renamed and retagged.
 */
export function planRestore(
  content: ConfigurationContent,
  current: CurrentConfiguration,
  options: { readonly sections: readonly ConfigurationSection[]; readonly enableAutomations: boolean },
): RestoreWork {
  const chosen = new Set(options.sections);
  const warnings: RestoreWarning[] = [];
  const sections: RestorePlan['sections'] = {};
  const active = new Set(current.pcs.filter((pc) => pc.active).map((pc) => pc.id));
  const currentName = new Map(current.pcs.map((pc) => [pc.id, pc.name]));

  /* PCs ----------------------------------------------------------------- */

  let pcUpdates: { id: string; name: string; tags: string[]; favorite: boolean }[] = [];

  if (chosen.has('pcs')) {
    let skipped = 0;

    for (const pc of content.pcs) {
      if (!active.has(pc.id)) {
        skipped += 1;
        warnings.push({
          code: 'pc-not-enrolled',
          section: 'pcs',
          id: pc.id,
          message: `"${pc.name}" is not enrolled on this account. Enroll it again, then restore to apply its name and tags.`,
        });
        continue;
      }
      pcUpdates.push({ id: pc.id, name: pc.name, tags: pc.tags, favorite: pc.favorite });
    }

    // A name has to be unique across every PC, including ones this restore does not touch and
    // revoked ones. Where the backup's name would collide, the PC keeps the name it has. Reverting can
    // itself collide with another PC's new name, so this repeats until nothing does; it ends because
    // current names are already unique.
    const untouched = current.pcs.filter((pc) => !pcUpdates.some((update) => update.id === pc.id));
    const reverted = new Set<string>();

    for (let pass = 0; pass <= pcUpdates.length; pass += 1) {
      const holders = new Map<string, string[]>();
      for (const pc of untouched) holders.set(pc.name, [...(holders.get(pc.name) ?? []), pc.id]);
      for (const update of pcUpdates) holders.set(update.name, [...(holders.get(update.name) ?? []), update.id]);

      const clashing = pcUpdates.filter((update) => (holders.get(update.name)?.length ?? 0) > 1 && update.name !== currentName.get(update.id));
      if (clashing.length === 0) break;

      pcUpdates = pcUpdates.map((update) => {
        if (!clashing.includes(update)) return update;
        reverted.add(update.id);
        return { ...update, name: currentName.get(update.id)! };
      });
    }

    for (const id of reverted) {
      const wanted = content.pcs.find((pc) => pc.id === id)!;
      warnings.push({
        code: 'pc-name-taken',
        section: 'pcs',
        id,
        message: `Another PC is already called "${wanted.name}", so this one keeps the name "${currentName.get(id)}". Its tags were restored.`,
      });
    }

    sections.pcs = { created: 0, updated: pcUpdates.length, deleted: 0, skipped };
  }

  /* Remote desktop profiles --------------------------------------------- */

  const profiles = chosen.has('remoteDesktopProfiles') ? content.remoteDesktopProfiles : [];
  if (chosen.has('remoteDesktopProfiles')) {
    sections.remoteDesktopProfiles = counts(current.profileIds, profiles.map((profile) => profile.id), 0);
  }

  /* Alert rules --------------------------------------------------------- */

  const rules: { id: string; rule: AlertRuleInput }[] = [];
  if (chosen.has('alertRules')) {
    let skipped = 0;
    for (const entry of content.alertRules) {
      if (entry.rule.pcId !== null && !active.has(entry.rule.pcId)) {
        skipped += 1;
        // Not quietly widened to "every PC": a rule about one machine is not a rule about all of them.
        warnings.push({
          code: 'rule-pc-missing',
          section: 'alertRules',
          id: entry.id,
          message: `The alert rule "${entry.rule.name}" watches a PC that is not enrolled on this account, so it was not restored.`,
        });
        continue;
      }
      rules.push(entry);
    }
    sections.alertRules = counts(current.alertRuleIds, rules.map((entry) => entry.id), skipped);
  }

  const ruleIdsAfter = new Set(chosen.has('alertRules') ? rules.map((entry) => entry.id) : current.alertRuleIds);

  /* Automations --------------------------------------------------------- */

  const automations: { id: string; automation: AutomationInput; risk: RiskLevel }[] = [];
  const disableAutomationIds: string[] = [];

  if (chosen.has('automations')) {
    let skipped = 0;

    for (const entry of content.automations) {
      let automation = entry.automation;

      if (automation.targets.mode === 'pcs') {
        const kept = automation.targets.pcIds.filter((pcId) => active.has(pcId));
        if (kept.length === 0) {
          skipped += 1;
          warnings.push({
            code: 'automation-pcs-missing',
            section: 'automations',
            id: entry.id,
            message: `None of the PCs "${automation.name}" acts on are enrolled on this account, so it was not restored.`,
          });
          continue;
        }
        if (kept.length < automation.targets.pcIds.length) {
          warnings.push({
            code: 'automation-pcs-missing',
            section: 'automations',
            id: entry.id,
            message: `"${automation.name}" was restored without ${automation.targets.pcIds.length - kept.length} PC(s) that are not enrolled.`,
          });
          automation = { ...automation, targets: { mode: 'pcs', pcIds: kept } };
        }
      }

      if (automation.trigger.kind === 'alert' && automation.trigger.ruleId !== null && !ruleIdsAfter.has(automation.trigger.ruleId)) {
        skipped += 1;
        warnings.push({
          code: 'automation-rule-missing',
          section: 'automations',
          id: entry.id,
          message: `"${automation.name}" is triggered by an alert rule that will not exist, so it was not restored.`,
        });
        continue;
      }

      automation = { ...automation, enabled: options.enableAutomations && automation.enabled };
      automations.push({ id: entry.id, automation, risk: automationRisk(automation.actions) });
    }

    sections.automations = counts(
      current.automations.map((existing) => existing.id),
      automations.map((entry) => entry.id),
      skipped,
    );
  } else if (chosen.has('alertRules')) {
    // Automations are staying, but the rules some of them wait for may not be.
    for (const existing of current.automations) {
      if (existing.enabled && existing.ruleId !== null && !ruleIdsAfter.has(existing.ruleId)) {
        disableAutomationIds.push(existing.id);
        warnings.push({
          code: 'automation-rule-missing',
          section: 'automations',
          id: existing.id,
          message: 'An automation waits for an alert rule this restore removes, so it will be turned off.',
        });
      }
    }
  }

  const enabled = automations.filter((entry) => entry.automation.enabled);
  const automationsRisk = enabled.reduce<RiskLevel>((highest, entry) => maxRisk(highest, entry.risk), 'low');

  return {
    plan: {
      sections,
      warnings,
      automationsEnabled: enabled.length,
      // Replacing configuration wholesale is never a low-risk click, whatever is in it.
      riskLevel: maxRisk('medium', automationsRisk),
    },
    pcUpdates,
    profiles,
    rules,
    automations,
    disableAutomationIds,
  };
}

export type RestoreAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: 'confirmation' | 'reauthentication' };

/** The command policy for the restore's risk level: the same confirmation, the same password window. */
export function authorizeRestore(input: {
  readonly riskLevel: RiskLevel;
  readonly confirmedRiskLevel: RiskLevel | undefined;
  readonly authTimeSeconds: number;
  readonly now: Date;
}): RestoreAuthorization {
  const policy = policyFor(input.riskLevel);

  if (policy.requiresConfirmation && input.confirmedRiskLevel !== input.riskLevel) {
    return { ok: false, problem: 'confirmation' };
  }

  if (policy.requiresPasswordReauth) {
    const age = Math.floor(input.now.getTime() / 1000) - input.authTimeSeconds;
    if (age > policy.reauthMaxAgeSeconds) return { ok: false, problem: 'reauthentication' };
  }

  return { ok: true };
}

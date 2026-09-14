import type { RiskLevel } from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';
import type { CurrentConfiguration, RestoreWork } from '../../configuration/plan.js';

/**
 * Reading the owner's configuration out, and writing a restore back in one transaction.
 *
 * A snapshot selects named columns — never `*` — so that a column added to these tables later does
 * not end up in backup files because nobody thought about it.
 */

/** Thrown when an id in a backup belongs to a row this account does not own. The transaction rolls back. */
export class RestoreConflictError extends Error {
  constructor(readonly section: string, readonly id: string) {
    super(`The ${section} item ${id} belongs to another account.`);
  }
}

export interface RestoreAuthority {
  readonly deviceId: string;
  readonly at: Date;
}

export class ConfigurationRepository {
  constructor(private readonly db: Database) {}

  /** The owner's configuration, as backup content. */
  async snapshot(userId: string): Promise<Record<string, unknown[]>> {
    const [pcs, profiles, rules, automations] = await Promise.all([
      this.db.query<{ id: string; name: string; tags: string[]; favorite: boolean }>(
        `SELECT id, name, tags, favorite FROM pcs
          WHERE user_id = $1 AND registration_state <> 'revoked'
          ORDER BY id`,
        [userId],
      ),
      this.db.query<{ id: string; name: string; settings: unknown; is_default: boolean }>(
        `SELECT id, name, settings, is_default FROM remote_desktop_profiles WHERE user_id = $1 ORDER BY id`,
        [userId],
      ),
      this.db.query<{
        id: string;
        name: string;
        pc_id: string | null;
        condition: string;
        metric: string | null;
        series_key: string | null;
        threshold: number | null;
        for_minutes: number;
        severity: string;
        cooldown_minutes: number;
        enabled: boolean;
      }>(
        `SELECT id, name, pc_id, condition, metric, series_key, threshold, for_minutes, severity,
                cooldown_minutes, enabled
           FROM alert_rules WHERE user_id = $1 ORDER BY id`,
        [userId],
      ),
      this.db.query<{
        id: string;
        name: string;
        enabled: boolean;
        trigger: unknown;
        conditions: unknown;
        actions: unknown;
        targets: unknown;
        cooldown_minutes: number;
        max_runs_per_day: number;
      }>(
        `SELECT id, name, enabled, trigger, conditions, actions, targets, cooldown_minutes, max_runs_per_day
           FROM automations WHERE user_id = $1 ORDER BY id`,
        [userId],
      ),
    ]);

    return {
      pcs: pcs.rows.map((row) => ({ id: row.id, name: row.name, tags: row.tags, favorite: row.favorite })),
      remoteDesktopProfiles: profiles.rows.map((row) => ({
        id: row.id,
        name: row.name,
        settings: row.settings,
        isDefault: row.is_default,
      })),
      alertRules: rules.rows.map((row) => ({
        id: row.id,
        rule: {
          name: row.name,
          pcId: row.pc_id,
          condition: row.condition,
          metric: row.metric,
          seriesKey: row.series_key,
          threshold: row.threshold,
          forMinutes: row.for_minutes,
          severity: row.severity,
          cooldownMinutes: row.cooldown_minutes,
          enabled: row.enabled,
        },
      })),
      automations: automations.rows.map((row) => ({
        id: row.id,
        automation: {
          name: row.name,
          enabled: row.enabled,
          trigger: row.trigger,
          conditions: row.conditions,
          actions: row.actions,
          targets: row.targets,
          cooldownMinutes: row.cooldown_minutes,
          maxRunsPerDay: row.max_runs_per_day,
        },
      })),
    };
  }

  async current(userId: string, client?: DatabaseClient): Promise<CurrentConfiguration> {
    const runner = client ?? this.db;
    const pcs = await runner.query<{ id: string; name: string; registration_state: string }>(
      'SELECT id, name, registration_state FROM pcs WHERE user_id = $1',
      [userId],
    );
    const profiles = await runner.query<{ id: string }>('SELECT id FROM remote_desktop_profiles WHERE user_id = $1', [userId]);
    const rules = await runner.query<{ id: string }>('SELECT id FROM alert_rules WHERE user_id = $1', [userId]);
    const automations = await runner.query<{ id: string; enabled: boolean; rule_id: string | null }>(
      `SELECT id, enabled, trigger->>'ruleId' AS rule_id FROM automations WHERE user_id = $1`,
      [userId],
    );

    return {
      pcs: pcs.rows.map((row) => ({ id: row.id, name: row.name, active: row.registration_state !== 'revoked' })),
      profileIds: profiles.rows.map((row) => row.id),
      alertRuleIds: rules.rows.map((row) => row.id),
      automations: automations.rows.map((row) => ({ id: row.id, enabled: row.enabled, ruleId: row.rule_id })),
    };
  }

  /**
   * Apply a planned restore inside the caller's transaction.
   *
   * Names go through a temporary value first wherever uniqueness is enforced, so a backup that swaps
   * two names does not fail halfway on a constraint that only the intermediate state violates.
   */
  async apply(
    client: DatabaseClient,
    userId: string,
    work: RestoreWork,
    sections: ReadonlySet<string>,
    authority: RestoreAuthority,
  ): Promise<void> {
    if (sections.has('pcs') && work.pcUpdates.length > 0) {
      const ids = work.pcUpdates.map((update) => update.id);
      await client.query(
        `UPDATE pcs SET name = '__wolf_restore_' || id WHERE user_id = $1 AND id::text = ANY($2::text[])`,
        [userId, ids],
      );
      for (const update of work.pcUpdates) {
        await client.query(
          'UPDATE pcs SET name = $3, tags = $4, favorite = $5, updated_at = now() WHERE id = $1 AND user_id = $2',
          [update.id, userId, update.name, update.tags, update.favorite],
        );
      }
    }

    if (sections.has('remoteDesktopProfiles')) {
      const ids = work.profiles.map((profile) => profile.id);
      await client.query(
        'DELETE FROM remote_desktop_profiles WHERE user_id = $1 AND NOT (id::text = ANY($2::text[]))',
        [userId, ids],
      );
      await client.query(
        `UPDATE remote_desktop_profiles SET is_default = FALSE, name = '__wolf_restore_' || id WHERE user_id = $1`,
        [userId],
      );
      for (const profile of work.profiles) {
        const { rowCount } = await client.query(
          `INSERT INTO remote_desktop_profiles (id, user_id, name, settings, is_default)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name, settings = EXCLUDED.settings, is_default = EXCLUDED.is_default, updated_at = now()
           WHERE remote_desktop_profiles.user_id = EXCLUDED.user_id`,
          [profile.id, userId, profile.name, JSON.stringify(profile.settings), profile.isDefault],
        );
        if ((rowCount ?? 0) === 0) throw new RestoreConflictError('remote desktop profile', profile.id);
      }
    }

    if (sections.has('alertRules')) {
      const ids = work.rules.map((entry) => entry.id);
      await client.query('DELETE FROM alert_rules WHERE user_id = $1 AND NOT (id::text = ANY($2::text[]))', [userId, ids]);
      // A restored definition is a new question; the answers the old one had do not carry over.
      await client.query('DELETE FROM alert_states WHERE rule_id::text = ANY($1::text[])', [ids]);

      for (const { id, rule } of work.rules) {
        const { rowCount } = await client.query(
          `INSERT INTO alert_rules
             (id, user_id, pc_id, name, condition, metric, series_key, threshold, for_minutes, severity, cooldown_minutes, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE
             SET pc_id = EXCLUDED.pc_id, name = EXCLUDED.name, condition = EXCLUDED.condition, metric = EXCLUDED.metric,
                 series_key = EXCLUDED.series_key, threshold = EXCLUDED.threshold, for_minutes = EXCLUDED.for_minutes,
                 severity = EXCLUDED.severity, cooldown_minutes = EXCLUDED.cooldown_minutes, enabled = EXCLUDED.enabled,
                 updated_at = now()
           WHERE alert_rules.user_id = EXCLUDED.user_id`,
          [
            id,
            userId,
            rule.pcId,
            rule.name,
            rule.condition,
            rule.metric,
            rule.seriesKey,
            rule.threshold,
            rule.forMinutes,
            rule.severity,
            rule.cooldownMinutes,
            rule.enabled,
          ],
        );
        if ((rowCount ?? 0) === 0) throw new RestoreConflictError('alert rule', id);
      }
    }

    if (sections.has('automations')) {
      const ids = work.automations.map((entry) => entry.id);
      await client.query('DELETE FROM automations WHERE user_id = $1 AND NOT (id::text = ANY($2::text[]))', [userId, ids]);

      for (const { id, automation, risk } of work.automations) {
        const { rowCount } = await client.query(
          `INSERT INTO automations
             (id, user_id, name, enabled, trigger_kind, trigger, conditions, actions, targets, cooldown_minutes,
              max_runs_per_day, authorized_risk, authorized_device_id, authorized_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, trigger_kind = EXCLUDED.trigger_kind,
                 trigger = EXCLUDED.trigger, conditions = EXCLUDED.conditions, actions = EXCLUDED.actions,
                 targets = EXCLUDED.targets, cooldown_minutes = EXCLUDED.cooldown_minutes,
                 max_runs_per_day = EXCLUDED.max_runs_per_day, authorized_risk = EXCLUDED.authorized_risk,
                 authorized_device_id = EXCLUDED.authorized_device_id, authorized_at = EXCLUDED.authorized_at,
                 updated_at = now()
           WHERE automations.user_id = EXCLUDED.user_id`,
          [
            id,
            userId,
            automation.name,
            automation.enabled,
            automation.trigger.kind,
            JSON.stringify(automation.trigger),
            JSON.stringify(automation.conditions),
            JSON.stringify(automation.actions),
            JSON.stringify(automation.targets),
            automation.cooldownMinutes,
            automation.maxRunsPerDay,
            // Never critical: the schema refused that before this point. For an automation restored
            // turned off this authority is inert — turning it on re-authorizes it.
            risk satisfies RiskLevel,
            authority.deviceId,
            authority.at,
          ],
        );
        if ((rowCount ?? 0) === 0) throw new RestoreConflictError('automation', id);
      }
    }

    if (work.disableAutomationIds.length > 0) {
      await client.query(
        'UPDATE automations SET enabled = FALSE, updated_at = now() WHERE user_id = $1 AND id::text = ANY($2::text[])',
        [userId, work.disableAutomationIds],
      );
    }
  }
}

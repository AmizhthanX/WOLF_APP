import type {
  AutomationAction,
  AutomationCondition,
  AutomationInput,
  AutomationRun,
  AutomationRunStatus,
  AutomationStep,
  AutomationTargets,
  AutomationTrigger,
} from '@wolf/protocol';
import { newId, type RiskLevel } from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';

interface AutomationRow {
  id: string;
  user_id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  targets: AutomationTargets;
  cooldown_minutes: number;
  max_runs_per_day: number;
  authorized_risk: RiskLevel;
  authorized_device_id: string;
  authorized_at: Date;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, user_id, name, enabled, trigger, conditions, actions, targets, cooldown_minutes,
                 max_runs_per_day, authorized_risk, authorized_device_id, authorized_at, last_run_at,
                 created_at, updated_at`;

/** An automation as the executor sees it: the definition plus who authorized it. */
export interface StoredAutomation {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: AutomationTrigger;
  readonly conditions: readonly AutomationCondition[];
  readonly actions: readonly AutomationAction[];
  readonly targets: AutomationTargets;
  readonly cooldownMinutes: number;
  readonly maxRunsPerDay: number;
  readonly authorizedRisk: RiskLevel;
  readonly authorizedDeviceId: string;
  readonly authorizedAt: Date;
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toAutomation(row: AutomationRow): StoredAutomation {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    targets: row.targets,
    cooldownMinutes: row.cooldown_minutes,
    maxRunsPerDay: row.max_runs_per_day,
    authorizedRisk: row.authorized_risk,
    authorizedDeviceId: row.authorized_device_id,
    authorizedAt: row.authorized_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Who decided, from where, at what risk. Replaced whenever the automation is re-authorized. */
export interface AutomationAuthority {
  readonly risk: RiskLevel;
  readonly deviceId: string;
  readonly at: Date;
}

export interface AutomationEvent {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'alert-fired' | 'alert-resolved';
  readonly ruleId: string | null;
  readonly pcId: string;
  readonly occurredAt: Date;
}

export type RunClaim =
  | { readonly outcome: 'claimed'; readonly runId: string }
  | { readonly outcome: 'cooldown' | 'daily-limit' };

interface RunRow {
  id: string;
  automation_id: string;
  pc_id: string | null;
  trigger_kind: AutomationRun['triggerKind'];
  status: AutomationRunStatus;
  reason: string | null;
  steps: AutomationStep[];
  started_at: Date;
  finished_at: Date | null;
}

function toRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    pcId: row.pc_id,
    triggerKind: row.trigger_kind,
    status: row.status,
    reason: row.reason,
    steps: row.steps,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export class AutomationRepository {
  constructor(private readonly db: Database) {}

  /* ----------------------------------------------------------------------- */
  /* Definitions                                                              */
  /* ----------------------------------------------------------------------- */

  async listForUser(userId: string): Promise<StoredAutomation[]> {
    const { rows } = await this.db.query<AutomationRow>(
      `SELECT ${COLUMNS} FROM automations WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toAutomation);
  }

  async findById(id: string, userId: string, client?: DatabaseClient): Promise<StoredAutomation | null> {
    const { rows } = await (client ?? this.db).query<AutomationRow>(
      `SELECT ${COLUMNS} FROM automations WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toAutomation(rows[0]) : null;
  }

  async countForUser(userId: string, client?: DatabaseClient): Promise<number> {
    const { rows } = await (client ?? this.db).query<{ count: number }>(
      'SELECT count(*)::int AS count FROM automations WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.count ?? 0;
  }

  async create(
    userId: string,
    input: AutomationInput,
    authority: AutomationAuthority,
    client?: DatabaseClient,
  ): Promise<StoredAutomation> {
    const { rows } = await (client ?? this.db).query<AutomationRow>(
      `INSERT INTO automations
         (id, user_id, name, enabled, trigger_kind, trigger, conditions, actions, targets,
          cooldown_minutes, max_runs_per_day, authorized_risk, authorized_device_id, authorized_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COLUMNS}`,
      [
        newId(),
        userId,
        input.name,
        input.enabled,
        input.trigger.kind,
        JSON.stringify(input.trigger),
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
        JSON.stringify(input.targets),
        input.cooldownMinutes,
        input.maxRunsPerDay,
        authority.risk,
        authority.deviceId,
        authority.at,
      ],
    );
    return toAutomation(rows[0]!);
  }

  /**
   * Replace a definition. With `authority` null the stored authority is kept — which the API allows
   * only for changes that cannot widen what the automation does (renaming, turning it off).
   */
  async update(
    id: string,
    userId: string,
    input: AutomationInput,
    authority: AutomationAuthority | null,
    client?: DatabaseClient,
  ): Promise<StoredAutomation | null> {
    const { rows } = await (client ?? this.db).query<AutomationRow>(
      `UPDATE automations
          SET name = $3, enabled = $4, trigger_kind = $5, trigger = $6, conditions = $7, actions = $8,
              targets = $9, cooldown_minutes = $10, max_runs_per_day = $11,
              authorized_risk = COALESCE($12, authorized_risk),
              authorized_device_id = COALESCE($13, authorized_device_id),
              authorized_at = COALESCE($14, authorized_at),
              updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${COLUMNS}`,
      [
        id,
        userId,
        input.name,
        input.enabled,
        input.trigger.kind,
        JSON.stringify(input.trigger),
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
        JSON.stringify(input.targets),
        input.cooldownMinutes,
        input.maxRunsPerDay,
        authority?.risk ?? null,
        authority?.deviceId ?? null,
        authority?.at ?? null,
      ],
    );
    return rows[0] ? toAutomation(rows[0]) : null;
  }

  async delete(id: string, userId: string, client?: DatabaseClient): Promise<boolean> {
    const { rowCount } = await (client ?? this.db).query('DELETE FROM automations WHERE id = $1 AND user_id = $2', [
      id,
      userId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Turn an automation off because it may no longer act. Compare-and-set on `enabled`, so the owner
   * is told once however many instances noticed.
   */
  async disable(id: string, client?: DatabaseClient): Promise<boolean> {
    const { rowCount } = await (client ?? this.db).query(
      'UPDATE automations SET enabled = FALSE, updated_at = now() WHERE id = $1 AND enabled',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Every enabled automation a revoked device authorized. Returns their ids. */
  async disableForDevice(deviceId: string, client?: DatabaseClient): Promise<string[]> {
    const { rows } = await (client ?? this.db).query<{ id: string }>(
      `UPDATE automations SET enabled = FALSE, updated_at = now()
        WHERE authorized_device_id = $1 AND enabled
        RETURNING id`,
      [deviceId],
    );
    return rows.map((row) => row.id);
  }

  async enabledByTrigger(kind: AutomationTrigger['kind'], limit = 1000): Promise<StoredAutomation[]> {
    const { rows } = await this.db.query<AutomationRow>(
      `SELECT ${COLUMNS} FROM automations WHERE enabled AND trigger_kind = $1 ORDER BY created_at LIMIT $2`,
      [kind, limit],
    );
    return rows.map(toAutomation);
  }

  async enabledAlertAutomationsFor(userId: string): Promise<StoredAutomation[]> {
    const { rows } = await this.db.query<AutomationRow>(
      `SELECT ${COLUMNS} FROM automations WHERE enabled AND trigger_kind = 'alert' AND user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toAutomation);
  }

  /* ----------------------------------------------------------------------- */
  /* Triggers                                                                 */
  /* ----------------------------------------------------------------------- */

  /** True for the one caller that claims a scheduled minute. */
  async claimScheduleSlot(automationId: string, slot: string, now: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO automation_schedule_slots (automation_id, slot, fired_at) VALUES ($1, $2, $3)
       ON CONFLICT (automation_id, slot) DO NOTHING`,
      [automationId, slot, now],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Record that an alert changed state, if anything could act on it.
   *
   * Called inside the alert evaluator's transaction, so the event exists exactly when the state
   * change does. Written only when the owner has an enabled alert-triggered automation: an event
   * table filling with alerts nobody automates is storage with no purpose.
   */
  async recordAlertEvent(
    client: DatabaseClient,
    input: { readonly userId: string; readonly ruleId: string; readonly pcId: string; readonly kind: AutomationEvent['kind']; readonly occurredAt: Date },
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `INSERT INTO automation_events (id, user_id, kind, rule_id, pc_id, occurred_at)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE EXISTS (SELECT 1 FROM automations WHERE user_id = $2 AND enabled AND trigger_kind = 'alert')`,
      [newId(), input.userId, input.kind, input.ruleId, input.pcId, input.occurredAt],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Take unclaimed events. Each is handed to exactly one caller. */
  async claimEvents(now: Date, limit = 100): Promise<AutomationEvent[]> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      kind: AutomationEvent['kind'];
      rule_id: string | null;
      pc_id: string;
      occurred_at: Date;
    }>(
      `UPDATE automation_events SET claimed_at = $1
        WHERE id IN (
          SELECT id FROM automation_events
           WHERE claimed_at IS NULL
           ORDER BY occurred_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
          AND claimed_at IS NULL
        RETURNING id, user_id, kind, rule_id, pc_id, occurred_at`,
      [now, limit],
    );

    return rows
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        ruleId: row.rule_id,
        pcId: row.pc_id,
        occurredAt: row.occurred_at,
      }))
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  /* ----------------------------------------------------------------------- */
  /* Runs                                                                     */
  /* ----------------------------------------------------------------------- */

  /**
   * Start a run on one PC, if the cooldown and the daily limit allow it.
   *
   * One transaction: the automation row is locked so two instances count the day's runs one after
   * the other, and the per-PC cooldown is a compare-and-set on when it last ran. The run row is
   * written in the same transaction, so a claimed cooldown always has a run to show for it.
   */
  async claimRun(
    client: DatabaseClient,
    input: {
      readonly automation: StoredAutomation;
      readonly pcId: string;
      readonly triggerKind: AutomationRun['triggerKind'];
      readonly now: Date;
      readonly leaseExpiresAt: Date;
      /** Manual runs are pressed by the owner and skip the cooldown; they still count to the day. */
      readonly ignoreCooldown: boolean;
    },
  ): Promise<RunClaim> {
    const { automation, pcId, now } = input;

    await client.query('SELECT id FROM automations WHERE id = $1 FOR UPDATE', [automation.id]);

    const { rows: counted } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM automation_runs
        WHERE automation_id = $1 AND started_at > $2 AND status <> 'skipped'`,
      [automation.id, new Date(now.getTime() - 86_400_000)],
    );
    if ((counted[0]?.count ?? 0) >= automation.maxRunsPerDay) {
      return { outcome: 'daily-limit' };
    }

    const cooldown = input.ignoreCooldown ? 0 : automation.cooldownMinutes;
    const { rowCount } = await client.query(
      `INSERT INTO automation_pc_state (automation_id, pc_id, last_run_at) VALUES ($1, $2, $3)
       ON CONFLICT (automation_id, pc_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at
        WHERE automation_pc_state.last_run_at <= $3::timestamptz - ($4::int * interval '1 minute')`,
      [automation.id, pcId, now, cooldown],
    );
    if ((rowCount ?? 0) === 0) {
      return { outcome: 'cooldown' };
    }

    const runId = newId();
    await client.query(
      `INSERT INTO automation_runs (id, automation_id, user_id, pc_id, trigger_kind, status, started_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7)`,
      [runId, automation.id, automation.userId, pcId, input.triggerKind, now, input.leaseExpiresAt],
    );
    await client.query('UPDATE automations SET last_run_at = $2 WHERE id = $1', [automation.id, now]);

    return { outcome: 'claimed', runId };
  }

  /** A run that did nothing, and why. */
  async recordSkippedRun(
    input: {
      readonly automation: StoredAutomation;
      readonly pcId: string | null;
      readonly triggerKind: AutomationRun['triggerKind'];
      readonly reason: string;
      readonly now: Date;
    },
    client?: DatabaseClient,
  ): Promise<string> {
    const id = newId();
    await (client ?? this.db).query(
      `INSERT INTO automation_runs (id, automation_id, user_id, pc_id, trigger_kind, status, reason, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'skipped', $6, $7, $7)`,
      [id, input.automation.id, input.automation.userId, input.pcId, input.triggerKind, input.reason.slice(0, 300), input.now],
    );
    return id;
  }

  async extendLease(runId: string, until: Date): Promise<void> {
    await this.db.query(`UPDATE automation_runs SET lease_expires_at = $2 WHERE id = $1 AND status = 'running'`, [runId, until]);
  }

  async finishRun(input: {
    readonly runId: string;
    readonly status: Exclude<AutomationRunStatus, 'running'>;
    readonly reason: string | null;
    readonly steps: readonly AutomationStep[];
    readonly now: Date;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE automation_runs
          SET status = $2, reason = $3, steps = $4, finished_at = $5, lease_expires_at = NULL
        WHERE id = $1 AND status = 'running'`,
      [input.runId, input.status, input.reason?.slice(0, 300) ?? null, JSON.stringify(input.steps), input.now],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Runs whose instance stopped holding them. Marked interrupted, never resumed: the remaining
   * half of a stop-then-start sequence an hour later is a different, unrequested action.
   */
  async interruptStaleRuns(now: Date): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE automation_runs
          SET status = 'interrupted', finished_at = $1, lease_expires_at = NULL,
              reason = 'The API instance running it stopped before it finished.'
        WHERE status = 'running' AND lease_expires_at < $1`,
      [now],
    );
    return rowCount ?? 0;
  }

  async listRuns(automationId: string, userId: string, limit = 50): Promise<AutomationRun[]> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT id, automation_id, pc_id, trigger_kind, status, reason, steps, started_at, finished_at
         FROM automation_runs
        WHERE automation_id = $1 AND user_id = $2
        ORDER BY started_at DESC
        LIMIT $3`,
      [automationId, userId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(toRun);
  }

  async findRun(runId: string): Promise<AutomationRun | null> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT id, automation_id, pc_id, trigger_kind, status, reason, steps, started_at, finished_at
         FROM automation_runs WHERE id = $1`,
      [runId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** An in-app notification from an automation: its own action, or news that it failed or stopped. */
  async insertNotification(
    input: {
      readonly userId: string;
      readonly automationId: string;
      readonly pcId: string | null;
      readonly severity: 'info' | 'warning' | 'critical';
      readonly title: string;
      readonly detail: string;
      readonly occurredAt: Date;
    },
    client?: DatabaseClient,
  ): Promise<string> {
    const id = newId();
    await (client ?? this.db).query(
      `INSERT INTO notifications (id, user_id, automation_id, pc_id, kind, severity, title, detail, occurred_at)
       VALUES ($1, $2, $3, $4, 'automation', $5, $6, $7, $8)`,
      [id, input.userId, input.automationId, input.pcId, input.severity, input.title.slice(0, 200), input.detail.slice(0, 500), input.occurredAt],
    );
    return id;
  }

  /** Claimed events after a day, runs after ninety days, schedule slots after a week. */
  async deleteExpired(now: Date): Promise<void> {
    await this.db.query('DELETE FROM automation_events WHERE claimed_at IS NOT NULL AND claimed_at < $1', [
      new Date(now.getTime() - 86_400_000),
    ]);
    await this.db.query(`DELETE FROM automation_runs WHERE status <> 'running' AND started_at < $1`, [
      new Date(now.getTime() - 90 * 86_400_000),
    ]);
    await this.db.query('DELETE FROM automation_schedule_slots WHERE fired_at < $1', [
      new Date(now.getTime() - 7 * 86_400_000),
    ]);
  }
}

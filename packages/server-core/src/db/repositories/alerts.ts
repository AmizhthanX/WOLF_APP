import type { AlertCondition, AlertRule, AlertSeverity, Notification, NotificationKind } from '@wolf/protocol';
import { newId } from '@wolf/shared-types';
import type { Database, DatabaseClient } from '../pool.js';

interface RuleRow {
  id: string;
  user_id: string;
  pc_id: string | null;
  name: string;
  condition: AlertCondition;
  metric: string | null;
  series_key: string | null;
  threshold: number | null;
  for_minutes: number;
  severity: AlertSeverity;
  cooldown_minutes: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const RULE_COLUMNS = `id, user_id, pc_id, name, condition, metric, series_key, threshold, for_minutes,
                      severity, cooldown_minutes, enabled, created_at, updated_at`;

/** A rule as the evaluator sees it: the API shape plus whose it is. */
export interface StoredRule extends AlertRule {
  readonly userId: string;
}

function toRule(row: RuleRow): StoredRule {
  return {
    id: row.id,
    userId: row.user_id,
    pcId: row.pc_id,
    name: row.name,
    condition: row.condition,
    metric: row.metric as AlertRule['metric'],
    seriesKey: row.series_key,
    threshold: row.threshold,
    forMinutes: row.for_minutes,
    severity: row.severity,
    cooldownMinutes: row.cooldown_minutes,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface NotificationRow {
  id: string;
  rule_id: string | null;
  pc_id: string | null;
  kind: NotificationKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  metric: string | null;
  series_key: string | null;
  value: number | null;
  threshold: number | null;
  occurred_at: Date;
  read_at: Date | null;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    ruleId: row.rule_id,
    pcId: row.pc_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    metric: row.metric,
    seriesKey: row.series_key,
    value: row.value,
    threshold: row.threshold,
    occurredAt: row.occurred_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

export interface RuleWrite {
  readonly pcId: string | null;
  readonly name: string;
  readonly condition: AlertCondition;
  readonly metric: string | null;
  readonly seriesKey: string | null;
  readonly threshold: number | null;
  readonly forMinutes: number;
  readonly severity: AlertSeverity;
  readonly cooldownMinutes: number;
  readonly enabled: boolean;
}

export interface StateRow {
  readonly pcId: string;
  readonly seriesKey: string;
  readonly state: 'ok' | 'firing';
  readonly changedAt: Date;
  readonly lastNotifiedAt: Date | null;
  readonly notified: boolean;
}

export class AlertRepository {
  constructor(private readonly db: Database) {}

  /* ----------------------------------------------------------------------- */
  /* Rules                                                                    */
  /* ----------------------------------------------------------------------- */

  async listRules(userId: string): Promise<StoredRule[]> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM alert_rules WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toRule);
  }

  async findRule(id: string, userId: string): Promise<StoredRule | null> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM alert_rules WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async countRules(userId: string, client?: DatabaseClient): Promise<number> {
    const { rows } = await (client ?? this.db).query<{ count: number }>(
      'SELECT count(*)::int AS count FROM alert_rules WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.count ?? 0;
  }

  async createRule(userId: string, rule: RuleWrite, client?: DatabaseClient): Promise<StoredRule> {
    const { rows } = await (client ?? this.db).query<RuleRow>(
      `INSERT INTO alert_rules
         (id, user_id, pc_id, name, condition, metric, series_key, threshold, for_minutes,
          severity, cooldown_minutes, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${RULE_COLUMNS}`,
      [
        newId(),
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
    return toRule(rows[0]!);
  }

  /**
   * Replace a rule's definition.
   *
   * Changing what a rule asks clears the answers it had: a rule that fired on "disk above 90%"
   * and is edited to "disk above 95%" has not been evaluated against the new question, and
   * carrying its firing state across would resolve — or fail to fire — on a basis the owner no
   * longer holds.
   */
  async updateRule(id: string, userId: string, rule: RuleWrite, client?: DatabaseClient): Promise<StoredRule | null> {
    const runner = client ?? this.db;

    const { rows } = await runner.query<RuleRow>(
      `UPDATE alert_rules
          SET pc_id = $3, name = $4, condition = $5, metric = $6, series_key = $7, threshold = $8,
              for_minutes = $9, severity = $10, cooldown_minutes = $11, enabled = $12, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${RULE_COLUMNS}`,
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

    if (!rows[0]) return null;

    await runner.query('DELETE FROM alert_states WHERE rule_id = $1', [id]);
    return toRule(rows[0]);
  }

  async deleteRule(id: string, userId: string, client?: DatabaseClient): Promise<boolean> {
    const { rowCount } = await (client ?? this.db).query(
      'DELETE FROM alert_rules WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Every enabled rule, for the evaluator. Bounded so one pass has a known cost. */
  async enabledRules(limit = 5000): Promise<StoredRule[]> {
    const { rows } = await this.db.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM alert_rules WHERE enabled ORDER BY user_id, created_at LIMIT $1`,
      [limit],
    );
    return rows.map(toRule);
  }

  /* ----------------------------------------------------------------------- */
  /* State                                                                    */
  /* ----------------------------------------------------------------------- */

  async statesFor(ruleId: string): Promise<StateRow[]> {
    const { rows } = await this.db.query<{
      pc_id: string;
      series_key: string;
      state: 'ok' | 'firing';
      changed_at: Date;
      last_notified_at: Date | null;
      notified: boolean;
    }>(
      `SELECT pc_id, series_key, state, changed_at, last_notified_at, notified
         FROM alert_states WHERE rule_id = $1`,
      [ruleId],
    );

    return rows.map((row) => ({
      pcId: row.pc_id,
      seriesKey: row.series_key,
      state: row.state,
      changedAt: row.changed_at,
      lastNotifiedAt: row.last_notified_at,
      notified: row.notified,
    }));
  }

  /**
   * Move one alert from one state to another, if nobody else already has.
   *
   * A compare-and-set, and it is the reason two API instances can run the evaluator at once
   * without telling the owner twice. The rollup job gets away without this because every write
   * it makes is an upsert of a value; a notification is not idempotent — a second one is a second
   * message in somebody's inbox. So the state change is conditional on the state the evaluator
   * read, and the notification is written only by whichever instance's update actually landed.
   *
   * The comparison includes when the state last changed, not only what it is. Comparing the state
   * alone would let a slow pass that read "firing" resolve an alert that another instance had
   * already resolved and re-fired in the meantime — the same word, a different firing.
   *
   * Returns false when another instance got there first, and nothing is written.
   */
  async transition(
    client: DatabaseClient,
    input: {
      readonly ruleId: string;
      readonly pcId: string;
      readonly seriesKey: string;
      readonly from: { readonly state: 'ok' | 'firing'; readonly changedAt: Date } | null;
      readonly to: 'ok' | 'firing';
      readonly notified: boolean;
      readonly notifiedAt: Date | null;
      readonly now: Date;
    },
  ): Promise<boolean> {
    if (input.from === null) {
      const { rowCount } = await client.query(
        `INSERT INTO alert_states (rule_id, pc_id, series_key, state, changed_at, last_notified_at, notified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (rule_id, pc_id, series_key) DO NOTHING`,
        [input.ruleId, input.pcId, input.seriesKey, input.to, input.now, input.notifiedAt, input.notified],
      );
      return (rowCount ?? 0) > 0;
    }

    const { rowCount } = await client.query(
      `UPDATE alert_states
          SET state = $4,
              changed_at = $5,
              last_notified_at = COALESCE($6, last_notified_at),
              notified = $7
        WHERE rule_id = $1 AND pc_id = $2 AND series_key = $3 AND state = $8 AND changed_at = $9`,
      [
        input.ruleId,
        input.pcId,
        input.seriesKey,
        input.to,
        input.now,
        input.notifiedAt,
        input.notified,
        input.from.state,
        input.from.changedAt,
      ],
    );

    return (rowCount ?? 0) > 0;
  }

  /* ----------------------------------------------------------------------- */
  /* Notifications                                                            */
  /* ----------------------------------------------------------------------- */

  async insertNotification(
    client: DatabaseClient,
    input: {
      readonly userId: string;
      readonly ruleId: string;
      readonly pcId: string;
      readonly kind: NotificationKind;
      readonly severity: AlertSeverity;
      readonly title: string;
      readonly detail: string;
      readonly metric: string | null;
      readonly seriesKey: string | null;
      readonly value: number | null;
      readonly threshold: number | null;
      readonly occurredAt: Date;
    },
  ): Promise<string> {
    const id = newId();

    await client.query(
      `INSERT INTO notifications
         (id, user_id, rule_id, pc_id, kind, severity, title, detail, metric, series_key, value,
          threshold, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.userId,
        input.ruleId,
        input.pcId,
        input.kind,
        input.severity,
        input.title.slice(0, 200),
        input.detail.slice(0, 500),
        input.metric,
        input.seriesKey,
        input.value,
        input.threshold,
        input.occurredAt,
      ],
    );

    return id;
  }

  async listNotifications(
    userId: string,
    options: { readonly unreadOnly: boolean; readonly limit: number },
  ): Promise<Notification[]> {
    const { rows } = await this.db.query<NotificationRow>(
      `SELECT id, rule_id, pc_id, kind, severity, title, detail, metric, series_key, value,
              threshold, occurred_at, read_at
         FROM notifications
        WHERE user_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL)
        ORDER BY occurred_at DESC
        LIMIT $3`,
      [userId, options.unreadOnly, Math.min(Math.max(options.limit, 1), 200)],
    );
    return rows.map(toNotification);
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return rows[0]?.count ?? 0;
  }

  async markRead(id: string, userId: string, now: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3)
        WHERE id = $1 AND user_id = $2`,
      [id, userId, now],
    );
    return (rowCount ?? 0) > 0;
  }

  async markAllRead(userId: string, now: Date): Promise<number> {
    const { rowCount } = await this.db.query(
      'UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL',
      [userId, now],
    );
    return rowCount ?? 0;
  }

  /**
   * Delete notifications past their window.
   *
   * Read ones after ninety days, unread ones after a year. An inbox is not an archive — the audit
   * log is — and a notification nobody read in a year is not going to be.
   */
  async deleteOldNotifications(now: Date): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM notifications
        WHERE (read_at IS NOT NULL AND occurred_at < $1)
           OR (read_at IS NULL AND occurred_at < $2)`,
      [new Date(now.getTime() - 90 * 86_400_000), new Date(now.getTime() - 365 * 86_400_000)],
    );
    return rowCount ?? 0;
  }
}

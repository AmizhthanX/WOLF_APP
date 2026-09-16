import { newId } from '@wolf/shared-types';
import type { AlertSeverity, NotificationKind, WebhookDeliveryOutcome } from '@wolf/protocol';
import type { Database, DatabaseClient } from '../pool.js';

export interface StoredWebhook {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly host: string;
  readonly urlSealed: string;
  readonly secretSalt: string;
  readonly minSeverity: AlertSeverity;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastDeliveryAt: Date | null;
  readonly lastOutcome: WebhookDeliveryOutcome | null;
  readonly lastStatus: number | null;
  readonly createdAt: Date;
}

/** A delivery taken for sending, with what it needs. */
export interface DueDelivery {
  readonly webhook: StoredWebhook;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly notification: {
    readonly id: string;
    readonly kind: NotificationKind;
    readonly severity: AlertSeverity;
    readonly title: string;
    readonly detail: string;
    readonly occurredAt: Date;
    readonly pc: { readonly id: string; readonly name: string } | null;
  };
}

interface WebhookRow {
  id: string;
  user_id: string;
  name: string;
  host: string;
  url_sealed: string;
  secret_salt: string;
  min_severity: AlertSeverity;
  enabled: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_delivery_at: Date | null;
  last_outcome: WebhookDeliveryOutcome | null;
  last_status: number | null;
  created_at: Date;
}

const COLUMNS = `id, user_id, name, host, url_sealed, secret_salt, min_severity, enabled, disabled_reason,
  consecutive_failures, last_delivery_at, last_outcome, last_status, created_at`;

function toWebhook(row: WebhookRow): StoredWebhook {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    host: row.host,
    urlSealed: row.url_sealed,
    secretSalt: row.secret_salt,
    minSeverity: row.min_severity,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at) : null,
    lastOutcome: row.last_outcome,
    lastStatus: row.last_status,
    createdAt: new Date(row.created_at),
  };
}

const SEVERITY_RANK_SQL = (column: string) => `(CASE ${column} WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END)`;

/**
 * Webhooks and their deliveries.
 *
 * The sealed URL and the salt leave this repository only toward the delivery job and the routes that need them;
 * neither is ever returned to an API caller or logged.
 */
export class WebhookRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly host: string;
    readonly urlSealed: string;
    readonly secretSalt: string;
    readonly minSeverity: AlertSeverity;
  }, client?: DatabaseClient): Promise<StoredWebhook> {
    const { rows } = await (client ?? this.db).query<WebhookRow>(
      `INSERT INTO webhooks (id, user_id, name, host, url_sealed, secret_salt, min_severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [input.id, input.userId, input.name, input.host, input.urlSealed, input.secretSalt, input.minSeverity],
    );
    return toWebhook(rows[0]!);
  }

  async countForUser(userId: string, client?: DatabaseClient): Promise<number> {
    const { rows } = await (client ?? this.db).query<{ count: string }>(
      'SELECT count(*)::text AS count FROM webhooks WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async listForUser(userId: string): Promise<StoredWebhook[]> {
    const { rows } = await this.db.query<WebhookRow>(
      `SELECT ${COLUMNS} FROM webhooks WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toWebhook);
  }

  async find(id: string, userId: string): Promise<StoredWebhook | null> {
    const { rows } = await this.db.query<WebhookRow>(
      `SELECT ${COLUMNS} FROM webhooks WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toWebhook(rows[0]) : null;
  }

  /** Rename, retune, or turn on or off. Turning one on clears why WOLF turned it off, and the failure count. */
  async update(
    id: string,
    userId: string,
    patch: { readonly name?: string; readonly enabled?: boolean; readonly minSeverity?: AlertSeverity },
  ): Promise<StoredWebhook | null> {
    const { rows } = await this.db.query<WebhookRow>(
      `UPDATE webhooks
          SET name = COALESCE($3, name),
              min_severity = COALESCE($4, min_severity),
              enabled = COALESCE($5, enabled),
              disabled_reason = CASE WHEN $5::boolean IS TRUE THEN NULL ELSE disabled_reason END,
              consecutive_failures = CASE WHEN $5::boolean IS TRUE AND NOT enabled THEN 0 ELSE consecutive_failures END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${COLUMNS}`,
      [id, userId, patch.name ?? null, patch.minSeverity ?? null, patch.enabled ?? null],
    );
    return rows[0] ? toWebhook(rows[0]) : null;
  }

  async rotateSalt(id: string, userId: string, salt: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE webhooks SET secret_salt = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
      [id, userId, salt],
    );
    return (rowCount ?? 0) > 0;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM webhooks WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Fan new notifications out to the webhooks that want them.
   *
   * One statement: claim notifications nobody has fanned out, and write a pending delivery for each enabled
   * webhook of the same owner whose minimum severity it meets. A notification too old to be news is claimed
   * and not fanned out. Returns how many deliveries were written.
   */
  async fanOut(now: Date, maxAgeMs: number, limit: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `WITH claimed AS (
         UPDATE notifications SET webhooked_at = $1
          WHERE id IN (
            SELECT id FROM notifications
             WHERE webhooked_at IS NULL
             ORDER BY occurred_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
          )
         RETURNING id, user_id, severity, occurred_at
       )
       INSERT INTO webhook_deliveries (webhook_id, notification_id, status, attempts, next_attempt_at, created_at)
       SELECT w.id, c.id, 'pending', 0, $1, $1
         FROM claimed c
         JOIN webhooks w ON w.user_id = c.user_id AND w.enabled
        WHERE ${SEVERITY_RANK_SQL('c.severity')} >= ${SEVERITY_RANK_SQL('w.min_severity')}
          AND c.occurred_at >= $2
       ON CONFLICT DO NOTHING`,
      [now, new Date(now.getTime() - maxAgeMs), limit],
    );
    return rowCount ?? 0;
  }

  /** Take deliveries that are due, each for one caller, for [leaseMs]. */
  async claimDue(now: Date, leaseMs: number, limit: number): Promise<DueDelivery[]> {
    const { rows } = await this.db.query<
      WebhookRow & {
        attempts: number;
        delivery_created_at: Date;
        notification_id: string;
        n_kind: NotificationKind;
        n_severity: AlertSeverity;
        n_title: string;
        n_detail: string;
        n_occurred_at: Date;
        pc_id: string | null;
        pc_name: string | null;
      }
    >(
      `WITH taken AS (
         UPDATE webhook_deliveries d
            SET lease_until = $2, attempts = d.attempts + 1
          WHERE (d.webhook_id, d.notification_id) IN (
            SELECT webhook_id, notification_id FROM webhook_deliveries
             WHERE status = 'pending' AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until < $1)
             ORDER BY next_attempt_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
          )
         RETURNING d.webhook_id, d.notification_id, d.attempts, d.created_at
       )
       SELECT w.id, w.user_id, w.name, w.host, w.url_sealed, w.secret_salt, w.min_severity, w.enabled, w.disabled_reason,
              w.consecutive_failures, w.last_delivery_at, w.last_outcome, w.last_status, w.created_at,
              t.attempts, t.created_at AS delivery_created_at, t.notification_id,
              n.kind AS n_kind, n.severity AS n_severity, n.title AS n_title, n.detail AS n_detail, n.occurred_at AS n_occurred_at,
              p.id AS pc_id, p.name AS pc_name
         FROM taken t
         JOIN webhooks w ON w.id = t.webhook_id
         JOIN notifications n ON n.id = t.notification_id
         LEFT JOIN pcs p ON p.id = n.pc_id`,
      [now, new Date(now.getTime() + leaseMs), limit],
    );

    return rows.map((row) => ({
      webhook: toWebhook(row),
      attempts: row.attempts,
      createdAt: new Date(row.delivery_created_at),
      notification: {
        id: row.notification_id,
        kind: row.n_kind,
        severity: row.n_severity,
        title: row.n_title,
        detail: row.n_detail,
        occurredAt: new Date(row.n_occurred_at),
        pc: row.pc_id ? { id: row.pc_id, name: row.pc_name ?? '' } : null,
      },
    }));
  }

  /**
   * Record how one attempt went: on the delivery (delivered, retry later, or given up) and on the webhook
   * (last outcome, and the run of failures). Returns true when this failure is the one that turned the
   * webhook off.
   */
  async recordAttempt(input: {
    readonly webhookId: string;
    readonly notificationId: string;
    readonly outcome: WebhookDeliveryOutcome;
    readonly status: number | null;
    readonly now: Date;
    /** Null: no more attempts. */
    readonly retryAt: Date | null;
    readonly disableAfterFailures: number;
  }): Promise<boolean> {
    const delivered = input.outcome === 'delivered';
    await this.db.query(
      `UPDATE webhook_deliveries
          SET status = $3, next_attempt_at = COALESCE($4, next_attempt_at), lease_until = NULL,
              last_outcome = $5, last_status = $6
        WHERE webhook_id = $1 AND notification_id = $2`,
      [input.webhookId, input.notificationId, delivered ? 'delivered' : input.retryAt ? 'pending' : 'failed', input.retryAt, input.outcome, input.status],
    );

    const { rows } = await this.db.query<{ turned_off: boolean }>(
      `UPDATE webhooks
          SET last_delivery_at = $2, last_outcome = $3, last_status = $4,
              consecutive_failures = CASE WHEN $5::boolean THEN 0 ELSE consecutive_failures + 1 END,
              enabled = CASE WHEN NOT $5::boolean AND consecutive_failures + 1 >= $6::integer THEN FALSE ELSE enabled END,
              disabled_reason = CASE WHEN NOT $5::boolean AND consecutive_failures + 1 >= $6::integer AND enabled
                                     THEN 'too-many-failures' ELSE disabled_reason END,
              updated_at = now()
        WHERE id = $1
        RETURNING (NOT $5::boolean AND consecutive_failures = $6::integer AND disabled_reason = 'too-many-failures') AS turned_off`,
      [input.webhookId, input.now, input.outcome, input.status, delivered, input.disableAfterFailures],
    );
    return rows[0]?.turned_off === true;
  }

  /** Pending deliveries to a webhook that was turned off will not be sent. */
  async abandonPending(webhookId: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_outcome = COALESCE(last_outcome, 'network'), lease_until = NULL
        WHERE webhook_id = $1 AND status = 'pending'`,
      [webhookId],
    );
  }

  async insertTurnedOffNotification(input: { readonly userId: string; readonly name: string; readonly host: string; readonly failures: number; readonly now: Date }): Promise<void> {
    await this.db.query(
      `INSERT INTO notifications (id, user_id, kind, severity, title, detail, occurred_at)
       VALUES ($1, $2, 'webhook', 'warning', $3, $4, $5)`,
      [
        newId(),
        input.userId,
        `Webhook “${input.name}” was turned off`.slice(0, 200),
        `The last ${input.failures} deliveries to ${input.host} failed, so WOLF stopped sending to it. Check the receiver, then turn the webhook back on.`.slice(0, 500),
        input.now,
      ],
    );
  }

  /** Delivery records after a week. */
  async deleteExpired(now: Date): Promise<void> {
    await this.db.query(`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < $1`, [
      new Date(now.getTime() - 7 * 86_400_000),
    ]);
  }
}

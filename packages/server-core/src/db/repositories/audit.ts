import type {
  AuditCategory,
  AuditEvent,
  AuditOutcome,
  ConnectionRoute,
  RiskLevel,
  SecurityEventType,
} from '@wolf/shared-types';
import { newId } from '@wolf/shared-types';
import { redactRecord } from '@wolf/validation';
import type { Database, DatabaseClient } from '../pool.js';

export interface AuditInput {
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly riskLevel: RiskLevel;
  readonly userId?: string | null;
  readonly deviceId?: string | null;
  readonly pcId?: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly sourceIp?: string | null;
  readonly route?: ConnectionRoute | null;
  readonly target?: Record<string, unknown> | null;
  readonly beforeValue?: Record<string, unknown> | null;
  readonly afterValue?: Record<string, unknown> | null;
  readonly errorCode?: string | null;
  readonly referenceId?: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  risk_level: RiskLevel;
  user_id: string | null;
  device_id: string | null;
  pc_id: string | null;
  session_id: string | null;
  request_id: string | null;
  source_ip: string | null;
  route: ConnectionRoute | null;
  target: Record<string, never> | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  error_code: string | null;
  reference_id: string | null;
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id as AuditEvent['id'],
    occurredAt: row.occurred_at.toISOString(),
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    riskLevel: row.risk_level,
    userId: row.user_id as AuditEvent['userId'],
    deviceId: row.device_id as AuditEvent['deviceId'],
    pcId: row.pc_id as AuditEvent['pcId'],
    sessionId: row.session_id as AuditEvent['sessionId'],
    requestId: row.request_id as AuditEvent['requestId'],
    sourceIp: row.source_ip,
    route: row.route,
    target: row.target,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    errorCode: row.error_code,
    referenceId: row.reference_id,
  };
}

export interface AuditQuery {
  readonly userId: string;
  readonly pcId?: string;
  readonly category?: AuditCategory;
  readonly outcome?: AuditOutcome;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  /** Cursor: return events strictly older than this id. */
  readonly before?: string;
}

/**
 * Audit repository.
 *
 * Every value written passes through the shared redactor, so a caller that hands over a
 * payload containing a password or clipboard text still cannot persist it. Rows are
 * append-only: there is no update or delete path here by design.
 */
export class AuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: AuditInput, client?: DatabaseClient): Promise<string> {
    const executor = client ?? this.db;
    const id = newId();
    await executor.query(
      `INSERT INTO audit_logs
         (id, category, action, outcome, risk_level, user_id, device_id, pc_id, session_id,
          request_id, source_ip, route, target, before_value, after_value, error_code, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        input.category,
        input.action,
        input.outcome,
        input.riskLevel,
        input.userId ?? null,
        input.deviceId ?? null,
        input.pcId ?? null,
        input.sessionId ?? null,
        input.requestId ?? null,
        input.sourceIp ?? null,
        input.route ?? null,
        input.target ? JSON.stringify(redactRecord(input.target)) : null,
        input.beforeValue ? JSON.stringify(redactRecord(input.beforeValue)) : null,
        input.afterValue ? JSON.stringify(redactRecord(input.afterValue)) : null,
        input.errorCode ?? null,
        input.referenceId ?? null,
      ],
    );
    return id;
  }

  async query(query: AuditQuery): Promise<AuditEvent[]> {
    const conditions: string[] = ['(user_id = $1 OR user_id IS NULL)'];
    const params: unknown[] = [query.userId];

    if (query.pcId) {
      params.push(query.pcId);
      conditions.push(`pc_id = $${params.length}`);
    }
    if (query.category) {
      params.push(query.category);
      conditions.push(`category = $${params.length}`);
    }
    if (query.outcome) {
      params.push(query.outcome);
      conditions.push(`outcome = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`occurred_at <= $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      conditions.push(`id < $${params.length}`);
    }

    params.push(Math.min(query.limit ?? 100, 500));

    const { rows } = await this.db.query<AuditRow>(
      `SELECT * FROM audit_logs
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(toEvent);
  }

  async recordSecurityEvent(
    input: {
      type: SecurityEventType;
      userId?: string | null;
      deviceId?: string | null;
      pcId?: string | null;
      sourceIp?: string | null;
      detail?: Record<string, unknown>;
    },
    client?: DatabaseClient,
  ): Promise<void> {
    const executor = client ?? this.db;
    await executor.query(
      `INSERT INTO security_events (id, type, user_id, device_id, pc_id, source_ip, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId(),
        input.type,
        input.userId ?? null,
        input.deviceId ?? null,
        input.pcId ?? null,
        input.sourceIp ?? null,
        JSON.stringify(redactRecord(input.detail ?? {})),
      ],
    );
  }
}

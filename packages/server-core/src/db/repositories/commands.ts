import type { RiskLevel } from '@wolf/shared-types';
import type {
  AgentCommandBody,
  AgentCommandType,
  AuthorizationContext,
  CommandStatus,
} from '@wolf/protocol';
import type { Database, DatabaseClient } from '../pool.js';

export interface CommandRecord {
  readonly id: string;
  readonly pcId: string;
  readonly sessionId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly requestId: string;
  readonly type: AgentCommandType;
  readonly riskLevel: RiskLevel;
  readonly status: CommandStatus;
  readonly payload: AgentCommandBody;
  readonly authorization: AuthorizationContext;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly sentAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorIsLimitation: boolean;
  readonly result: unknown;
}

interface CommandRow {
  id: string;
  pc_id: string;
  session_id: string | null;
  user_id: string;
  device_id: string;
  request_id: string;
  type: AgentCommandType;
  risk_level: RiskLevel;
  status: CommandStatus;
  payload: AgentCommandBody;
  authorization_context: AuthorizationContext;
  idempotency_key: string;
  created_at: Date;
  expires_at: Date;
  sent_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  error_is_limitation: boolean;
  result: unknown;
}

function toRecord(row: CommandRow): CommandRecord {
  return {
    id: row.id,
    pcId: row.pc_id,
    sessionId: row.session_id,
    userId: row.user_id,
    deviceId: row.device_id,
    requestId: row.request_id,
    type: row.type,
    riskLevel: row.risk_level,
    status: row.status,
    payload: row.payload,
    authorization: row.authorization_context,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorIsLimitation: row.error_is_limitation,
    result: row.result,
  };
}

const COLUMNS = `id, pc_id, session_id, user_id, device_id, request_id, type, risk_level,
                 status, payload, authorization_context, idempotency_key, created_at,
                 expires_at, sent_at, started_at, completed_at, error_code, error_message,
                 error_is_limitation, result`;

export interface CreateCommandInput {
  readonly id: string;
  readonly pcId: string;
  readonly sessionId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly requestId: string;
  readonly type: AgentCommandType;
  readonly riskLevel: RiskLevel;
  readonly payload: AgentCommandBody;
  readonly authorization: AuthorizationContext;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
}

export type CreateCommandOutcome =
  | { readonly created: true; readonly command: CommandRecord }
  /** The idempotency key was already used: the original command is returned unchanged. */
  | { readonly created: false; readonly command: CommandRecord };

export class CommandRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a command, or return the existing one for a repeated idempotency key.
   *
   * The uniqueness is enforced by an index rather than a read-then-write, so two
   * simultaneous retries of the same request cannot both insert.
   */
  async create(
    input: CreateCommandInput,
    client?: DatabaseClient,
  ): Promise<CreateCommandOutcome> {
    const executor = client ?? this.db;
    const { rows } = await executor.query<CommandRow>(
      `INSERT INTO commands
         (id, pc_id, session_id, user_id, device_id, request_id, type, risk_level, status,
          payload, authorization_context, idempotency_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12)
       ON CONFLICT (pc_id, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.pcId,
        input.sessionId,
        input.userId,
        input.deviceId,
        input.requestId,
        input.type,
        input.riskLevel,
        JSON.stringify(input.payload),
        JSON.stringify(input.authorization),
        input.idempotencyKey,
        input.expiresAt,
      ],
    );

    if (rows[0]) return { created: true, command: toRecord(rows[0]) };

    const existing = await this.findByIdempotencyKey(input.pcId, input.idempotencyKey, executor);
    if (!existing) {
      // The conflicting row disappeared between the insert and the read, which can only
      // happen if the PC was deleted concurrently.
      throw new Error('Command insert conflicted but the original command is gone.');
    }
    return { created: false, command: existing };
  }

  async findById(id: string): Promise<CommandRecord | null> {
    const { rows } = await this.db.query<CommandRow>(
      `SELECT ${COLUMNS} FROM commands WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(
    pcId: string,
    key: string,
    client?: DatabaseClient | Database,
  ): Promise<CommandRecord | null> {
    const executor = client ?? this.db;
    const { rows } = await executor.query<CommandRow>(
      `SELECT ${COLUMNS} FROM commands WHERE pc_id = $1 AND idempotency_key = $2`,
      [pcId, key],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Claim the commands waiting for a PC and mark them sent, in one statement, so two
   * realtime instances holding the same agent cannot deliver the same command twice.
   */
  async claimPending(pcId: string, limit = 20): Promise<CommandRecord[]> {
    const { rows } = await this.db.query<CommandRow>(
      `UPDATE commands
          SET status = 'sent', sent_at = now()
        WHERE id IN (
          SELECT id FROM commands
           WHERE pc_id = $1 AND status = 'pending' AND expires_at > now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING ${COLUMNS}`,
      [pcId, limit],
    );
    return rows.map(toRecord);
  }

  async markRunning(id: string, startedAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE commands SET status = 'running', started_at = $2
        WHERE id = $1 AND status IN ('pending', 'queued', 'sent')`,
      [id, startedAt],
    );
  }

  async complete(input: {
    id: string;
    status: Extract<CommandStatus, 'completed' | 'failed' | 'cancelled' | 'rejected'>;
    startedAt: Date | null;
    completedAt: Date;
    errorCode: string | null;
    errorMessage: string | null;
    errorIsLimitation: boolean;
    result: unknown;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE commands
          SET status = $2,
              started_at = COALESCE(started_at, $3),
              completed_at = $4,
              error_code = $5,
              error_message = $6,
              error_is_limitation = $7,
              result = $8
        WHERE id = $1
          AND status NOT IN ('completed', 'failed', 'cancelled', 'expired', 'rejected')`,
      [
        input.id,
        input.status,
        input.startedAt,
        input.completedAt,
        input.errorCode,
        input.errorMessage,
        input.errorIsLimitation,
        input.result === null || input.result === undefined ? null : JSON.stringify(input.result),
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Expire commands that never reached their agent in time.
   *
   * This is what stops a queued action from firing at an arbitrary later moment: an
   * expired command is dead, and the operator has to issue a new one.
   */
  async expireOverdue(now: Date = new Date()): Promise<CommandRecord[]> {
    const { rows } = await this.db.query<CommandRow>(
      `UPDATE commands
          SET status = 'expired', completed_at = now(),
              error_code = 'expired',
              error_message = 'The command was not delivered before it expired.'
        WHERE expires_at <= $1
          AND status IN ('pending', 'queued', 'sent', 'running')
        RETURNING ${COLUMNS}`,
      [now],
    );
    return rows.map(toRecord);
  }

  async listForPc(pcId: string, limit = 50): Promise<CommandRecord[]> {
    const { rows } = await this.db.query<CommandRow>(
      `SELECT ${COLUMNS} FROM commands WHERE pc_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [pcId, Math.min(limit, 200)],
    );
    return rows.map(toRecord);
  }

  async countPending(pcId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM commands
        WHERE pc_id = $1 AND status IN ('pending', 'queued', 'sent', 'running')`,
      [pcId],
    );
    return rows[0]?.count ?? 0;
  }
}

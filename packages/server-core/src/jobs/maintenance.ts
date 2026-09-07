import type { Logger } from 'pino';
import type { ServerContext } from '../context.js';

/**
 * Periodic maintenance.
 *
 * Nothing here is best-effort housekeeping: expiring commands is what guarantees a queued
 * shutdown never fires at an unexpected moment, and marking a silent PC offline is what
 * stops the dashboard from claiming a machine is reachable when it is not.
 */
export interface MaintenanceOptions {
  /** How often the sweep runs. */
  readonly intervalMs?: number;
  /** A PC that has not heartbeated within this window is treated as offline. */
  readonly presenceTimeoutMs?: number;
}

export class MaintenanceJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly presenceTimeoutMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly context: ServerContext,
    options: MaintenanceOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.logger = context.logger.child({ job: 'maintenance' });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    // Do not hold the process open purely for housekeeping.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.context.now();

      const expired = await this.context.repos.commands.expireOverdue(now);
      if (expired.length > 0) {
        this.logger.info({ count: expired.length }, 'Expired commands that were never delivered');
        for (const command of expired) {
          await this.context.repos.audit.record({
            category: 'pc',
            action: command.type,
            outcome: 'failure',
            riskLevel: command.riskLevel,
            userId: command.userId,
            deviceId: command.deviceId,
            pcId: command.pcId,
            sessionId: command.sessionId,
            requestId: command.requestId,
            errorCode: 'expired',
          });
        }
      }

      const expiredSessions = await this.context.repos.sessions.expireStale(now);
      if (expiredSessions > 0) {
        this.logger.info({ count: expiredSessions }, 'Expired stale sessions');
      }

      const wentOffline = await this.context.repos.pcs.markStaleOffline(
        new Date(now.getTime() - this.presenceTimeoutMs),
      );
      if (wentOffline.length > 0) {
        this.logger.info({ pcIds: wentOffline.length }, 'Marked silent PCs offline');
      }

      await this.context.repos.refreshTokens.deleteExpired(
        new Date(now.getTime() - 86_400_000),
      );

      // Keep tomorrow's telemetry partition ready before samples for it arrive.
      await this.context.repos.telemetry.ensurePartitions(3);
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Maintenance sweep failed',
      );
    } finally {
      this.running = false;
    }
  }
}

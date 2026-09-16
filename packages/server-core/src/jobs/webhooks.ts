import type { Logger } from 'pino';
import {
  WEBHOOK_FAILURES_BEFORE_DISABLE,
  WEBHOOK_MAX_AGE_MINUTES,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookBody,
} from '@wolf/protocol';
import type { ServerContext } from '../context.js';
import type { DueDelivery } from '../db/repositories/webhooks.js';
import type { WebhookSecrets } from '../webhooks/secrets.js';
import type { WebhookResult, WebhookSender } from '../webhooks/sender.js';

/**
 * Sending notifications to webhooks.
 *
 * Every few seconds: fan new notifications out into one delivery per webhook that wants them, then send the
 * deliveries that are due. Several instances are safe — a notification is fanned out once, and a delivery is
 * leased to one instance at a time.
 *
 * **Retried, a little.** A failed delivery is tried again after a minute and then after five, three attempts in
 * all, and not after the notification is half an hour old. A webhook whose last twenty deliveries all failed is
 * turned off, and the owner is told in the inbox: a receiver that is gone should not be retried forever, and an
 * owner should not have to discover that from silence.
 *
 * Logs carry counts and outcomes — never a URL, a secret, or anything from a notification.
 */
export interface WebhookJobOptions {
  readonly intervalMs?: number;
  readonly batch?: number;
}

export interface WebhookRunSummary {
  readonly fannedOut: number;
  readonly attempted: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  readonly turnedOff: number;
}

/** Minutes to wait after attempt n (1-based) fails. */
const RETRY_AFTER_MINUTES = [1, 5];
const LEASE_MS = 60_000;
const PARALLEL = 8;

export function webhookBody(delivery: DueDelivery['notification']): WebhookBody {
  return {
    type: 'wolf.notification',
    version: 1,
    id: delivery.id,
    occurredAt: delivery.occurredAt.toISOString(),
    notification: {
      kind: delivery.kind,
      severity: delivery.severity,
      title: delivery.title,
      detail: delivery.detail,
      pc: delivery.pc,
    },
  };
}

export class WebhookJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly logger: Logger;

  constructor(
    private readonly context: ServerContext,
    private readonly secrets: WebhookSecrets,
    private readonly sender: WebhookSender,
    options: WebhookJobOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.batch = options.batch ?? 200;
    this.logger = context.logger.child({ job: 'webhooks' });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<WebhookRunSummary | null> {
    if (this.running) return null;
    this.running = true;

    try {
      const { repos } = this.context;
      const now = this.context.now();
      const fannedOut = await repos.webhooks.fanOut(now, WEBHOOK_MAX_AGE_MINUTES * 60_000, this.batch);
      const due = await repos.webhooks.claimDue(now, LEASE_MS, this.batch);

      const summary = { fannedOut, attempted: 0, delivered: 0, retrying: 0, failed: 0, turnedOff: 0 };

      for (let start = 0; start < due.length; start += PARALLEL) {
        await Promise.all(due.slice(start, start + PARALLEL).map((delivery) => this.attempt(delivery, now, summary)));
      }

      if (now.getTime() - this.lastRetentionAt >= 60 * 60_000) {
        this.lastRetentionAt = now.getTime();
        await repos.webhooks.deleteExpired(now);
      }

      if (summary.attempted > 0 || summary.turnedOff > 0) this.logger.info(summary, 'Webhook deliveries');
      return summary;
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Webhook run failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  private async attempt(
    delivery: DueDelivery,
    now: Date,
    summary: { attempted: number; delivered: number; retrying: number; failed: number; turnedOff: number },
  ): Promise<void> {
    const { repos } = this.context;
    const { webhook, notification } = delivery;

    // Turned off since it was fanned out: not sent, and not counted against it.
    if (!webhook.enabled) {
      await repos.webhooks.abandonPending(webhook.id);
      return;
    }

    let result: WebhookResult;
    try {
      const url = this.secrets.decryptUrl(webhook.id, webhook.urlSealed);
      result = await this.sender.deliver({
        url,
        secret: this.secrets.signingSecret(webhook.id, webhook.secretSalt),
        body: JSON.stringify(webhookBody(notification)),
        deliveryId: `${notification.id}.${webhook.id}`,
        now,
      });
    } catch {
      // A URL that cannot be decrypted: the server key changed. Nothing will fix that by retrying.
      result = { outcome: 'network', status: null, detail: 'The stored URL could not be read with this server’s webhook key.' };
    }

    summary.attempted += 1;
    const tooOld = now.getTime() - notification.occurredAt.getTime() > WEBHOOK_MAX_AGE_MINUTES * 60_000;
    const retryable = result.outcome !== 'delivered' && result.outcome !== 'address-refused' && !tooOld && delivery.attempts < WEBHOOK_MAX_ATTEMPTS;
    const retryAt = retryable ? new Date(now.getTime() + RETRY_AFTER_MINUTES[delivery.attempts - 1]! * 60_000) : null;

    if (result.outcome === 'delivered') summary.delivered += 1;
    else if (retryAt) summary.retrying += 1;
    else summary.failed += 1;

    const turnedOff = await repos.webhooks.recordAttempt({
      webhookId: webhook.id,
      notificationId: notification.id,
      outcome: result.outcome,
      status: result.status,
      now,
      retryAt,
      disableAfterFailures: WEBHOOK_FAILURES_BEFORE_DISABLE,
    });

    if (turnedOff) {
      summary.turnedOff += 1;
      await repos.webhooks.abandonPending(webhook.id);
      await repos.webhooks.insertTurnedOffNotification({
        userId: webhook.userId,
        name: webhook.name,
        host: webhook.host,
        failures: WEBHOOK_FAILURES_BEFORE_DISABLE,
        now,
      });
      await repos.audit.record({
        category: 'configuration',
        action: 'webhook.turned-off',
        outcome: 'success',
        riskLevel: 'low',
        userId: webhook.userId,
        target: { kind: 'webhook', webhookId: webhook.id, host: webhook.host },
        errorCode: 'too-many-failures',
      });
    }
  }
}

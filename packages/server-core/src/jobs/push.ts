import type { Logger } from 'pino';
import type { ServerContext } from '../context.js';
import type { PushSender } from '../cloud/push.js';

/**
 * Waking phones when there is news.
 *
 * Every few seconds: claim the notifications nobody has considered, work out whose they are, and send each of
 * those users' active devices one content-free wake-up. Notifications are written by the alert job and the
 * automation executor and read here, so neither of them waits on a push service, and a push service that is
 * down delays nothing else.
 *
 * **At most once.** A notification is claimed before its wake-up is sent. If the send fails, it is not
 * retried: the notification is still in the inbox, and the phone shows it the next time the app looks. A
 * retry loop against a failing provider would be the wrong trade for news that is already safe.
 *
 * Several instances are safe: a notification is claimed by exactly one of them. Logs carry counts and
 * outcomes, never a token or anything from a notification.
 */
export interface PushJobOptions {
  readonly intervalMs?: number;
  /** Notifications older than this when found are not news. */
  readonly maxAgeMs?: number;
  readonly batch?: number;
}

export interface PushRunSummary {
  readonly usersWithNews: number;
  readonly devices: number;
  readonly delivered: number;
  readonly invalidTokens: number;
  readonly failed: number;
}

export class PushJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly maxAgeMs: number;
  private readonly batch: number;
  private readonly logger: Logger;

  constructor(
    private readonly context: ServerContext,
    private readonly sender: PushSender,
    options: PushJobOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
    this.batch = options.batch ?? 500;
    this.logger = context.logger.child({ job: 'push', provider: sender.provider });
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

  async runOnce(): Promise<PushRunSummary | null> {
    if (this.running) return null;
    this.running = true;

    try {
      const { repos } = this.context;
      const users = await repos.push.claimNews(this.context.now(), this.maxAgeMs, this.batch);
      const targets = await repos.push.targetsFor(users);

      let delivered = 0;
      let invalidTokens = 0;
      let failed = 0;

      for (const target of targets) {
        const outcome = await this.sender.wake({ deviceId: target.deviceId, token: target.token });
        if (outcome === 'delivered') {
          delivered += 1;
        } else if (outcome === 'token-invalid') {
          invalidTokens += 1;
          await repos.push.removeIfUnchanged(target.deviceId, target.token);
        } else {
          failed += 1;
        }
      }

      const summary = { usersWithNews: users.length, devices: targets.length, delivered, invalidTokens, failed };
      if (targets.length > 0) this.logger.info(summary, 'Push wake-ups sent');
      return summary;
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Push wake-up run failed');
      return null;
    } finally {
      this.running = false;
    }
  }
}

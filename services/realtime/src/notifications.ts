import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '@wolf/server-core';
import type { AgentRegistry } from './registry.js';

/**
 * Command delivery across instances.
 *
 * The API writes a durable command row and then issues a Postgres NOTIFY. Every realtime
 * instance listens; the one holding that PC's link claims the command and sends it. Using
 * the database we already depend on avoids adding a broker, and because the row is durable,
 * a dropped notification only delays delivery until the next sweep rather than losing it.
 */
const COMMAND_CHANNEL = 'wolf_command';
const KILL_SWITCH_CHANNEL = 'wolf_kill_switch';

export interface NotificationListenerOptions {
  readonly config: Config;
  readonly registry: AgentRegistry;
  readonly logger: Logger;
  /** Backstop sweep interval for notifications that never arrived. */
  readonly sweepIntervalMs?: number;
  readonly reconnectDelayMs?: number;
}

export class NotificationListener {
  private client: pg.Client | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly logger: Logger;

  constructor(private readonly options: NotificationListenerOptions) {
    this.logger = options.logger.child({ component: 'notifications' });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();

    this.sweepTimer = setInterval(
      () => void this.sweep(),
      this.options.sweepIntervalMs ?? 15_000,
    );
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sweepTimer = null;
    this.reconnectTimer = null;
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.end().catch(() => {});
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const client = new pg.Client({
      connectionString: this.options.config.database.url,
      ssl: this.options.config.database.ssl ? { rejectUnauthorized: true } : false,
      application_name: 'wolf-realtime-listener',
    });

    client.on('error', (error) => {
      this.logger.error({ err: error.message }, 'Notification connection error');
      this.scheduleReconnect();
    });

    client.on('notification', (message) => {
      void this.onNotification(message.channel, message.payload ?? '');
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${COMMAND_CHANNEL}`);
      await client.query(`LISTEN ${KILL_SWITCH_CHANNEL}`);
      this.client = client;
      this.logger.info('Listening for command notifications');
    } catch (error) {
      this.logger.error({ err: String(error) }, 'Failed to start the notification listener');
      await client.end().catch(() => {});
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.options.reconnectDelayMs ?? 2_000);
    this.reconnectTimer.unref();
  }

  private async onNotification(channel: string, payload: string): Promise<void> {
    let parsed: { pcId?: unknown; remoteAccessEnabled?: unknown };
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.logger.warn({ channel }, 'Ignored a malformed notification payload');
      return;
    }
    if (typeof parsed.pcId !== 'string') return;

    const link = this.options.registry.get(parsed.pcId);
    if (!link) return; // Another instance holds this PC.

    if (channel === COMMAND_CHANNEL) {
      await link.deliverPending();
      return;
    }

    if (channel === KILL_SWITCH_CHANNEL) {
      const enabled = parsed.remoteAccessEnabled === true;
      link.notifyKillSwitch(enabled);
      if (!enabled) link.close('kill-switch');
    }
  }

  /**
   * Backstop: ask every locally held link to drain its queue. This covers the window where
   * a notification was published while the listener was reconnecting.
   */
  private async sweep(): Promise<void> {
    for (const pcId of this.options.registry.connectedPcIds()) {
      const link = this.options.registry.get(pcId);
      if (!link) continue;
      try {
        await link.deliverPending();
      } catch (error) {
        this.logger.error({ pcId, err: String(error) }, 'Pending command sweep failed');
      }
    }
  }
}

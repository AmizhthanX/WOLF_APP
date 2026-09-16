/**
 * How the dashboard talks about webhooks: what a delivery's outcome means, and what the state of one is, in words.
 * Plain data, no React, so it is tested under Node.
 */

export type WebhookFormatCode = 'wolf' | 'slack' | 'discord';

export const FORMAT_LABELS: Readonly<Record<WebhookFormatCode, string>> = {
  slack: 'Slack incoming webhook',
  discord: 'Discord channel webhook',
  wolf: 'WOLF JSON (Home Assistant, your own service)',
};

/** Mirrors `suggestedWebhookFormat` in `packages/protocol`: a guess from the host, which the owner can change. */
export function suggestFormat(url: string): WebhookFormatCode {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) return 'discord';
  } catch {
    // Not a URL yet.
  }
  return 'wolf';
}

export type WebhookOutcomeCode = 'delivered' | 'http-error' | 'redirect' | 'timeout' | 'network' | 'address-refused' | 'tls';

export function outcomeText(outcome: WebhookOutcomeCode, status: number | null): string {
  switch (outcome) {
    case 'delivered':
      return status ? `Delivered (${status})` : 'Delivered';
    case 'http-error':
      return `The receiver answered ${status ?? 'with an error'}`;
    case 'redirect':
      return `The receiver answered with a redirect${status ? ` (${status})` : ''}, which WOLF does not follow`;
    case 'timeout':
      return 'No answer within five seconds';
    case 'network':
      return 'The connection failed';
    case 'address-refused':
      return 'The address now points somewhere private, so WOLF did not send to it';
    case 'tls':
      return 'The receiver’s certificate could not be verified';
  }
}

export interface WebhookState {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastOutcome: WebhookOutcomeCode | null;
  readonly lastStatus: number | null;
}

export function stateText(webhook: WebhookState): { tone: 'ok' | 'warn' | 'off'; text: string } {
  if (!webhook.enabled) {
    return webhook.disabledReason === 'too-many-failures'
      ? { tone: 'warn', text: 'Turned off by WOLF after too many failed deliveries' }
      : { tone: 'off', text: 'Off' };
  }
  if (webhook.lastOutcome === null) return { tone: 'ok', text: 'On · nothing sent yet' };
  if (webhook.lastOutcome === 'delivered') return { tone: 'ok', text: 'On · last delivery succeeded' };
  const failures = webhook.consecutiveFailures;
  return {
    tone: 'warn',
    text: `On · ${outcomeText(webhook.lastOutcome, webhook.lastStatus)}${failures > 1 ? ` · ${failures} failures in a row` : ''}`,
  };
}

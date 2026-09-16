import { z } from 'zod';
import { ALERT_SEVERITIES, type Notification } from './alerts.js';

/**
 * Webhooks: the owner's notifications, sent as a signed HTTPS request to a URL the owner chose.
 *
 * ## The danger is the server's own network
 *
 * A URL the owner types that the server then calls is a request the server makes on somebody's behalf, from
 * inside a cloud network — where the metadata endpoint hands out credentials and internal services trust
 * anything that reaches them. So a webhook is not a URL, it is a URL WOLF has checked:
 *
 * - **HTTPS only**, with the certificate verified. No `http:`, no credentials in the URL.
 * - **Every address the name resolves to must be public.** Loopback, private ranges, link-local (which is
 *   where cloud metadata lives), carrier-grade NAT, documentation and reserved ranges, multicast, IPv6
 *   unique-local, and the IPv6 forms that embed an IPv4 address are refused. If a name resolves to one public
 *   address and one private one, it is refused: that is what a rebinding attack looks like.
 * - **The connection goes to the address that was checked.** A name is resolved once per delivery, checked,
 *   and the socket is opened to that address with the name used only for TLS — so a DNS answer that changes
 *   between the check and the connect changes nothing.
 * - **No redirects are followed.** A 3xx is a failed delivery: following it would be a second request to a
 *   place nobody checked.
 * - Five seconds, a small request, and at most a kilobyte of the answer read before it is thrown away.
 *
 * The checks run when a webhook is saved, so the owner hears at once, and again before every delivery.
 *
 * ## The URL is a secret
 *
 * Slack's and Discord's webhook URLs carry their credential in the path. So the URL is stored encrypted, never
 * returned whole after it is saved — the API shows its host — and never written to a log or an audit record.
 *
 * ## What is sent
 *
 * What the inbox shows: the notification's kind, severity, title, detail, time, and which PC by id and name.
 * Nothing else about the account, and never a metric history. The request is signed so the receiver can tell
 * it came from this WOLF: `WOLF-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, with a secret
 * shown to the owner once when the webhook is made and again only when it is rotated.
 */

export const MAX_WEBHOOKS = 10;
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** Attempts per notification, a minute and then five minutes apart. */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** A notification older than this is not news to anybody's chat channel. */
export const WEBHOOK_MAX_AGE_MINUTES = 30;
/** Consecutive failed deliveries after which a webhook turns itself off and tells the owner. */
export const WEBHOOK_FAILURES_BEFORE_DISABLE = 20;
export const WEBHOOK_SIGNATURE_HEADER = 'WOLF-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'WOLF-Delivery';
/** A signature older than this should be refused by the receiver. The tolerance WOLF recommends. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export const webhookUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a URL.' });
      return;
    }
    if (url.protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A webhook must use https.' });
    }
    if (url.username || url.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A webhook URL cannot carry a user name or password.' });
    }
    if (url.hash) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A webhook URL cannot have a #fragment.' });
    }
  });

/**
 * The shape of what is sent. `wolf` is WOLF's own JSON, below. Slack's and Discord's incoming webhooks accept only
 * their own shapes — a `text` or a `content` field — and refuse anything else, so for them WOLF sends a short
 * message built from the same fields. Fixed formats, not templates: nothing the owner types is rendered into them.
 */
export const WEBHOOK_FORMATS = ['wolf', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** The format a URL's host suggests. A suggestion for the form, not a rule. */
export function suggestedWebhookFormat(url: string): WebhookFormat {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) return 'discord';
  } catch {
    // Not a URL yet: nothing to suggest.
  }
  return 'wolf';
}

export const webhookInput = z.object({
  name: z.string().trim().min(1).max(80),
  url: webhookUrl,
  format: z.enum(WEBHOOK_FORMATS).default('wolf'),
  /** Only notifications at least this severe are sent. */
  minSeverity: z.enum(ALERT_SEVERITIES).default('warning'),
});
export type WebhookInput = z.infer<typeof webhookInput>;

/** The URL cannot be changed: a different URL is a different webhook, checked and authorized as one. */
export const webhookPatch = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    minSeverity: z.enum(ALERT_SEVERITIES),
  })
  .partial();
export type WebhookPatch = z.infer<typeof webhookPatch>;

export const WEBHOOK_DELIVERY_OUTCOMES = [
  'delivered',
  'http-error',
  'redirect',
  'timeout',
  'network',
  'address-refused',
  'tls',
] as const;
export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

export const webhook = z.object({
  id: z.string().length(26),
  name: z.string(),
  /** The host only. The full URL is never returned after it is saved. */
  host: z.string(),
  format: z.enum(WEBHOOK_FORMATS),
  minSeverity: z.enum(ALERT_SEVERITIES),
  enabled: z.boolean(),
  /** Why it is off when WOLF turned it off, e.g. after too many failed deliveries. */
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastDeliveryAt: z.string().nullable(),
  lastOutcome: z.enum(WEBHOOK_DELIVERY_OUTCOMES).nullable(),
  lastStatus: z.number().int().nullable(),
  createdAt: z.string(),
});
export type Webhook = z.infer<typeof webhook>;

/** What a receiver gets. Versioned, so a receiver can refuse a shape it does not know. */
export interface WebhookBody {
  readonly type: 'wolf.notification' | 'wolf.test';
  readonly version: 1;
  readonly id: string;
  readonly occurredAt: string;
  readonly notification: {
    readonly kind: Notification['kind'];
    readonly severity: Notification['severity'];
    readonly title: string;
    readonly detail: string;
    readonly pc: { readonly id: string; readonly name: string } | null;
  };
}

/**
 * What goes on the wire for a format. Slack and Discord get one short message: severity, title, detail and the PC's
 * name, cut to what each accepts. Markdown characters from a title or detail are escaped, so a PC named
 * `*everyone*` stays text.
 */
export function webhookPayload(format: WebhookFormat, body: WebhookBody): unknown {
  if (format === 'wolf') return body;

  const escape = (text: string) => text.replace(/[\\*_~`|>@<]/g, (character) => `\\${character}`);
  const { notification } = body;
  const label = body.type === 'wolf.test' ? 'Test' : notification.severity.toUpperCase();
  const lines = [
    `${format === 'slack' ? '*' : '**'}[${label}] ${escape(notification.title)}${format === 'slack' ? '*' : '**'}`,
    notification.detail ? escape(notification.detail) : null,
    notification.pc ? `PC: ${escape(notification.pc.name)}` : null,
  ].filter((line): line is string => line !== null);

  const text = lines.join('\n');
  return format === 'slack'
    ? { text: text.slice(0, 3000) }
    // Discord's limit is 2000 characters; mentions are switched off so a name cannot ping anybody.
    : { content: text.slice(0, 2000), allowed_mentions: { parse: [] } };
}

/** The bytes a signature covers: the timestamp, a dot, and the exact body sent. */
export function webhookSignedPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

const SEVERITY_RANK: Readonly<Record<(typeof ALERT_SEVERITIES)[number], number>> = { info: 0, warning: 1, critical: 2 };

export function meetsSeverity(severity: (typeof ALERT_SEVERITIES)[number], minimum: (typeof ALERT_SEVERITIES)[number]): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

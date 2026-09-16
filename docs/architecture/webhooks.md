# Webhooks

A webhook sends the owner's notifications — alerts firing and resolving, automation reports — as a signed
HTTPS request to an address the owner chose: a Slack or Discord channel, Home Assistant, their own service.

It is also a request the cloud makes, from inside its own network, to an address somebody typed. That makes it
a server-side request forgery surface before it is anything else, and most of this document is about that.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| Schemas and limits | `packages/protocol/src/webhooks.ts` | Input, the view clients get, outcomes, the body, the signature format |
| Where a request may go | `packages/server-core/src/webhooks/egress.ts` | Address ranges, name resolution, the verdict |
| Secrets | `packages/server-core/src/webhooks/secrets.ts` | URL encryption, signing-secret derivation, signing and verifying |
| Sending | `packages/server-core/src/webhooks/sender.ts` | One pinned, signed HTTPS POST |
| Storage | `repositories/webhooks.ts`, migration `0009_webhooks.sql` | Webhooks, deliveries, fan-out |
| Job | `packages/server-core/src/jobs/webhooks.ts` | Fan out, send, retry, turn off |
| API | `services/api/src/routes/webhooks.ts` | List, add, change, test, replace secret, delete |
| Web | `apps/web/app/settings/webhooks/page.tsx` | The same, with the confirm-and-password flow |
| Android | `api/Webhooks.kt`, the Alerts screen | The same |

## Where a request may go

**HTTPS only**, with the certificate verified against the system's roots. No user name or password in the URL,
no fragment. Checked by the schema, then again by the egress check.

**Every address the name resolves to must be public.** Refused:

| | |
| --- | --- |
| Loopback, "this host" | 127/8, 0/8, `::1`, `::` |
| Private networks | 10/8, 172.16/12, 192.168/16, IPv6 unique-local `fc00::/7` |
| Link-local | 169.254/16 — **where cloud metadata services answer** — and `fe80::/10` |
| Carrier-grade NAT | 100.64/10, which some providers use internally |
| Documentation, benchmarking, protocol assignments | 192.0.0/24, 192.0.2/24, 198.51.100/24, 203.0.113/24, 198.18/15, 192.88.99/24, `2001:db8::/32` |
| Multicast, reserved, broadcast | 224/4, 240/4, `ff00::/8` |
| IPv4 in IPv6 clothing | IPv4-mapped and -compatible (`::ffff:0:0/96`, `::/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), Teredo (`2001::/32`), 6to4 (`2002::/16`) |

Names that are local by definition — `localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, a name with no
dot — are refused before anything is resolved. A name with one public and one private answer is refused: that is
what a rebinding attack looks like, and a client picking the other answer would reach the inside.

**The socket opens to the address that was checked.** The name is resolved once per delivery, judged, and the
HTTPS request is made with a `lookup` that returns only the chosen address; the name is used for SNI and
certificate verification and nothing else. A DNS answer that changes between the check and the connection
changes nothing.

**No redirects are followed.** A 3xx is a failed delivery (`redirect`). Following one would be a request to a
place nobody checked.

Five seconds, no connection reuse, and at most a kilobyte of the answer read before it is thrown away.

The check runs when a webhook is saved, so the owner hears at once (`422 webhooks.address_refused`), and again
before every delivery — an address that later starts pointing inside is not sent to (`address-refused`, not
retried).

**Defence in depth, for deployment:** the API's egress should also be restricted at the network — Cloud Run
egress settings or a firewall that blocks the metadata server and private ranges. The application check is the
one that is tested; the network rule is the one that still holds if the code is wrong. See
[deployment](../deployment/README.md).

A finding while building this: one `net.BlockList` for both families matched every IPv4 address against the
IPv4-mapped IPv6 rule, so every IPv4 address was refused. The test for a public address found it; there are two
lists now.

## The URL is a secret

Slack's and Discord's webhook URLs carry their credential in the path. So:

- stored **encrypted** — AES-256-GCM under a key derived from `WOLF_WEBHOOK_KEY`, with the webhook's id bound
  in, so a sealed URL cannot be copied to another row;
- **never returned** after it is saved: clients get the host;
- **never logged or audited**: audit records name the host and the webhook id. Tests look for the path in the
  API's answers, the database rows and the audit trail.

The URL cannot be changed. A different URL is a different webhook, checked and authorized as one.

## Signing

Each request carries:

```
WOLF-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
WOLF-Delivery: <notification id>.<webhook id>
```

A receiver recomputes the MAC over the exact bytes received, compares in constant time, and refuses a timestamp
more than five minutes away (`verifyWebhook` in `secrets.ts` is that receiver, written as code). The delivery id
is stable across retries, for de-duplication.

**The secret is not stored.** It is derived from `WOLF_WEBHOOK_KEY`, the webhook's id and a random salt that is
stored; shown to the owner once when the webhook is made, and again only by replacing it, which replaces the salt
and stops the old secret at once. The URL key and the signing root are separate HKDF derivations.

Without `WOLF_WEBHOOK_KEY` webhooks are off: the API lists `configured: false`, refuses to save one
(`409 webhooks.not_configured`), and the job does not run. Changing the key makes stored webhooks unreadable;
deliveries to them fail and they have to be made again.

## What is sent

```json
{
  "type": "wolf.notification",
  "version": 1,
  "id": "<notification id>",
  "occurredAt": "2026-09-16T10:00:00.000Z",
  "notification": {
    "kind": "fired | resolved | automation | webhook",
    "severity": "info | warning | critical",
    "title": "Disk almost full on Tower",
    "detail": "C: is at 97%.",
    "pc": { "id": "…", "name": "Tower" }
  }
}
```

That is the `wolf` format. Slack's and Discord's incoming webhooks refuse anything but their own shape, so a
webhook has a **format** — `wolf`, `slack` or `discord` — suggested from the address's host and changeable:

- `slack`: `{ "text": "*[CRITICAL] Disk almost full on Tower*\nC: is at 97%.\nPC: Tower" }`, at most 3000 characters.
- `discord`: `{ "content": "**[CRITICAL] …**\n…", "allowed_mentions": { "parse": [] } }`, at most 2000 characters, with
  mentions switched off so a PC named `@everyone` pings nobody.

Markdown characters from a title, detail or PC name are escaped. These are fixed formats, not templates: nothing
the owner types is rendered into a request. The signature header is sent with every format. Found while writing
the owner's setup guide — a first webhook pointed at Discord would otherwise have failed with 400.

What the inbox shows, and nothing else about the account — never a metric history, a command result, or anything
from a terminal, file or clipboard (none of which reaches a notification in the first place). A test delivery is
`"type": "wolf.test"`. Each webhook has a minimum severity: everything, warnings and critical, or critical only.

## Delivery

Every five seconds, on each API instance:

1. **Fan out.** One statement claims notifications nobody has fanned out and writes a pending delivery for each
   enabled webhook of that owner whose severity threshold they meet. The primary key (webhook, notification) is
   the de-duplication. Notifications older than 30 minutes are claimed and not sent; the migration marks every
   existing notification as already considered, so adding a webhook never posts the backlog.
2. **Send** due deliveries, each leased to one instance for a minute, eight at a time.
3. **Retry** a failure after a minute and after five — three attempts, and never once the notification is half
   an hour old. A refused address is not retried.
4. **Turn off** a webhook after 20 consecutive failed deliveries, abandon what is pending for it, tell the owner
   in the inbox (a `webhook` notification naming the host), and audit it. Turning it back on resets the count.

Logs carry counts and outcomes, never a URL, secret or notification content.

## Authorization

| Action | Needs |
| --- | --- |
| Add a webhook | the password entered within 5 minutes — from then on notifications go to a third party, unattended |
| Replace the signing secret | the password within 5 minutes — it shows a secret |
| Rename, change severity, turn on or off, send a test, delete | being signed in |

Every one is audited under `configuration`, with the host. At most 10 webhooks per account, counted under a row
lock. Test deliveries are rate limited to 10 per 10 minutes per account.

## Proven

- The address table, name handling and the split-answer case; URL sealing bound to its webhook and key; secret
  derivation and rotation; signatures refused for another secret, another body or an old timestamp.
- A real TLS server with a throwaway certificate made for the run: a delivery is a signed POST to the right path
  with a verifiable signature; a redirect is not followed; an untrusted certificate fails as `tls`; a name that
  resolves privately is never connected to. (The test's only concession is where the socket opens after the
  check passes — to this machine — which is exactly what the pinned lookup controls.)
- The job against Postgres: fan-out once and by severity, no backlog, the retry schedule, no retry for a refused
  address, turning off after 20 failures with the inbox notice and audit record.
- End to end through the HTTP app: the URL absent from the API, the database and the audit trail; the fresh
  password required; `http`, `localhost`, the metadata address, a name resolving to 10/8 and `[::1]` refused with
  nothing sent; a test and a real notification verified with the secret, and the old secret failing after
  rotation; turned-off and deleted webhooks sent nothing; a server without a key refusing; the limit of ten.

**Not proven:** a delivery to a real third-party service. That would send data off this machine to somewhere
the owner has not chosen, so it is left to the owner's first webhook and its Send a test button.

## Not built

- E-mail. It needs a provider, its credentials in secret management, and bounce handling.
- Templates the owner writes. The three fixed formats cover Slack, Discord and anything that takes JSON; rendering
  owner-written text into requests is its own design.
- An egress proxy with its own allow-list. The application check is enforced; the network rule is a deployment
  step.

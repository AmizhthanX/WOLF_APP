# Alert rules and notifications

A rule is a question WOLF keeps asking on the owner's behalf — "has the C: drive on STUDIO been
above 90% for half an hour?", "has the office PC been offline for fifteen minutes?" — and a
notification is what the owner sees when the answer changes.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| Schemas | `packages/protocol/src/alerts.ts` | Rule and notification shapes, bounds, coherence |
| Judgement | `packages/server-core/src/rules/engine.ts` | Pure: verdicts, the state machine, the words |
| Storage | `packages/server-core/src/db/repositories/alerts.ts`, migration `0006_alerts.sql` | Rules, per-target state, notifications |
| Evaluator | `packages/server-core/src/jobs/alerts.ts` | Once a minute, in every API instance |
| API | `services/api/src/routes/alerts.ts` | Rule CRUD (audited), inbox |
| Web | `apps/web/app/alerts/page.tsx`, unread count in `AppShell` | Inbox, rule list, new-rule form |

## Conditions

- `metric-above` / `metric-below` — a telemetry metric stayed strictly over (under) a threshold
  for **every** reading across the window. One reading back on the right side of the line
  clears it. Metrics are the rollup's `AGGREGATED_METRICS`, computed by the same
  `readingsOf` the history charts use, so a rule never fires on a number no chart shows.
  Per-device metrics (disks, GPUs, adapters) are judged per series; `seriesKey` narrows a rule
  to one.
- `pc-offline` — the PC has not been seen for the window.

A rule with no PC watches every active PC on the account, including ones enrolled later.

## Three verdicts, not two

Every evaluation is `breaching`, `clear` or **`unknown`**. Unknown — too few samples, samples
that do not reach back across 90% of the window, samples that stopped, or a hole inside the
window wider than 10% of it (floor one minute) — **never moves an alert in either direction**.

That single rule is what keeps a machine that stopped reporting from quietly resolving its own
alert. An alert about a volume that disappeared stays firing: it has not recovered, nobody knows.

## State and notifications

One state row per rule, PC and series: `ok` or `firing`, when it last changed, when the owner
was last told, and whether the current firing was announced.

| Current | Verdict | Result |
| --- | --- | --- |
| ok / none | breaching | fire; notify unless within the cooldown of the last notification |
| firing | breaching | nothing — told once is told |
| firing | clear | resolve; notify only if the firing was announced |
| any | unknown | nothing |

A firing suppressed by the cooldown is still recorded, so the alert is visibly firing and its
recovery does not produce a "back to normal" about something the owner never heard was wrong.

## Several API instances

Every instance runs the evaluator. The rollup job gets away without coordination because its
writes are idempotent upserts; a notification is not — a second one is a second message. So a
state change is a compare-and-set on the state *and* its `changed_at` as read, inside the same
transaction as the notification insert. Only the instance whose update lands writes the
notification; the others count a lost race and write nothing. Comparing `changed_at` as well as
the state closes the ABA case where a slow pass resolves a firing that another instance already
resolved and re-fired.

## Long windows

Agents sample every five seconds. Windows up to an hour read raw samples; longer ones read the
settled five-minute buckets for most of the window and raw samples only for the tail the
rollup has not reached. The substitution is exact: a metric was above its line for every
reading exactly when every bucket's **minimum** was (maximum for below rules). No threshold
decision is taken on an average. Only buckets starting inside the window are used, because a
bucket straddling the start could hold its minimum from before the window.

## Delivery

In the app; as a content-free push wake-up to the owner's phones, which then fetch the notification from WOLF
([push](push.md)); and, when the owner adds one, to a **webhook** — a signed HTTPS request to a public address,
with private and metadata addresses refused, the connection pinned to the checked address, the URL encrypted at
rest and never shown again ([webhooks](webhooks.md)).

Not built: **e-mail**, which needs a provider, its credentials in secret management, and bounce handling.

## Retention

Read notifications are deleted after 90 days, unread ones after a year, by the evaluator
hourly. The inbox is not an archive — rule changes are in the audit log.

## Limits

- 100 rules per account (checked under a row lock on the user, so two concurrent creates
  cannot both be the hundredth).
- Sustain window 1–1440 minutes; cooldown 5 minutes–7 days; the floor keeps a flapping metric
  from flooding the inbox.
- Each pass reads at most 5000 enabled rules.

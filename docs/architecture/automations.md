# Automations

An automation is: **when** something happens, **if** conditions hold, **do** these things — on these
PCs, no more often than this.

It acts when nobody is watching. That shapes everything below: the question is not only "may the
owner do this" but "may the owner decide *now* that this happens *later*, unattended".

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| Schemas | `packages/protocol/src/automations.ts` | Triggers, conditions, actions, targets, runs; the automatable allow-list |
| Judgement | `packages/server-core/src/automation/engine.ts` | Pure: schedule slots, conditions, cooldown, save and run authority |
| Storage | `repositories/automations.ts`, migration `0007_automations.sql` | Definitions, authority, cooldown state, schedule slots, events, runs |
| Alert hook | `packages/server-core/src/jobs/alerts.ts` | Writes an event in the same transaction as each alert state change |
| Dispatch | `CommandService.dispatchAutomated` in `services/api` | The unattended path onto the ordinary command pipeline |
| Executor and job | `services/api/src/automation/` | Runs automations; finds due schedules and alert events |
| API | `services/api/src/routes/automations.ts` | Save (authorizes), update, delete, run now, history |
| Web | `apps/web/app/automations/page.tsx` | List, history, builder with the confirm-and-password flow |

## Triggers

- **Schedule** — a local time on chosen weekdays in an IANA time zone. Due for five minutes after the
  minute; after that it is late, and commands in WOLF never run late. Deduplicated by local date and
  time, so several API instances run it once. Daylight saving follows the wall clock: a time skipped
  by clocks going forward does not run that day; a time repeated when they go back runs once.
- **Alert** — a rule (or any rule) firing or resolving. The alert evaluator writes an event in the same
  transaction as the state change, so each change is seen exactly once; one instance claims it.
  Events more than five minutes old when picked up are recorded as skipped, not acted on. A firing
  whose notification was suppressed by the alert cooldown still counts: that cooldown is about the
  inbox.
- **Manual** — "Run now". On the saved authority, so it can do nothing a scheduled run could not. It
  skips the per-PC cooldown (a person pressed it) and still counts to the daily limit.

## Conditions

All must hold, checked before the cooldown is claimed so a run that was never going to act does not
use up the next hour.

- **Time window** — local start and end, spanning midnight when the end is not after the start; the
  day is the day the window starts.
- **Metric** — the latest telemetry above or below a value. Telemetry older than two minutes is not
  "idle", it is unknown, and the condition is not met. With no device named, every device reporting
  the metric must satisfy it.
- **Nobody connected** — nobody is streaming the PC or holding its keyboard, terminal or files. A session opened only
  to show the PC's page does not count: it stays open for up to an hour, and counting it made the condition false
  whenever the owner had just looked at the PC.

## Actions

Up to five, in order. Each command's result is waited for before the next; the first failure skips
the rest.

- **Notify** — an in-app notification with the owner's own message.
- **Command** — only `power.action`, `service.control`, `task.control` and `startup.set-enabled`.
  Anything naming a live identifier is excluded (a PID saved today is another process tomorrow, and
  no "terminate by name" is invented here); anything the agent does not implement is excluded.

## Authority

| Risk of the riskiest action | To save or widen it |
| --- | --- |
| low | nothing |
| medium | a confirmation of exactly that risk level |
| high | the confirmation and a password entered within 5 minutes |
| critical | **never** — refused by the schema, the API, the engine and a database check |

Critical actions need a single-use privileged grant per action; an automation would turn that into a
standing permission.

Saving records the risk level, the time, and the device it was saved from. At every run:

- the authorizing device must still be active — **revoking a device turns off every automation it
  authorized**, in the same transaction, and a run that finds a revoked device turns the automation
  off and tells the owner;
- the actions are classified again and must not exceed the recorded level. A WOLF upgrade that makes
  an action riskier stops automations using it rather than grandfathering them.

Renaming or turning off needs no confirmation. Any other change — triggers, conditions, actions,
targets, cooldown, daily limit — or turning one back on re-authorizes, from the device making it.

## The unattended command path

`dispatchAutomated` is separate from the interactive `dispatch`, so nothing about unattended dispatch
can loosen the interactive one. It repeats the kill-switch, agent-support and presence checks, never
queues for an offline PC, and never takes an exclusive resource (such as power control) from a live
session. Commands carry an authorization context with no session, the capability the action needs,
and confirmation and re-authentication timestamps set to **when the owner gave them** — at save time.
Every command is audited as pending on the ordinary path with the automation and run ids; refusals
are audited as denied.

## Cooldowns and limits

- Per PC, a cooldown between runs (1 minute to 7 days), claimed by compare-and-set.
- Per automation, runs per 24 hours (1 to 96), counted under a row lock. A backstop against a
  flapping alert on a many-PC automation.
- 50 automations per account; 20 target PCs; 5 actions; 5 conditions. No "every PC" target: restarting
  every machine on the account, including next year's, is not a decision to make once.

## Runs

Recorded with trigger, PC, status (`completed`, `failed`, `skipped`, `interrupted`), a reason code,
and per-action steps (command id and a short code — never a command's result). A run whose API
instance dies has its lease lapse and is marked interrupted; it is never resumed. Failures notify
the owner, except a PC being offline. Runs are kept 90 days.

## Not built

- Triggers for a PC coming online, a process starting, or a file changing.
- Actions beyond the four commands and notify; no scripts, and no terminal — that is a separate,
  explicitly authorized feature.
- Delivery beyond the in-app inbox (see [alerts](alerts.md)).

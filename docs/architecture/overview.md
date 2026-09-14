# WOLF architecture

## The shape of the system

```
  Web / PWA            Android (later)          WOLF Control Panel (later)
      |                       |                            |
      |  HTTPS + WebSocket    |                            | local
      v                       v                            v
+---------------------------------------------+     +------------------+
|                  WOLF cloud                 |     |   Windows PC     |
|                                             |     |                  |
|  services/api        REST, auth, commands   |     |  WOLF Agent      |
|  services/realtime   agent links, telemetry |<----+   (service)      |
|                      WebRTC signaling       | out |  Session host    |
|  services/relay      TURN fallback (later)  |bound|  Privileged      |
|                                             |     |   helper (later) |
|         PostgreSQL   -- LISTEN/NOTIFY -->   |     +------------------+
+---------------------------------------------+
       ^                                                   ^
       |                                                   |
       +-- signaling only ----- WebRTC media --------------+
                (media and input never enter the cloud)
```

The PC always dials out. No inbound port is ever opened on a managed machine, which
removes the largest attack surface a remote-management tool normally has.

Remote desktop signaling lives in the realtime service rather than in a separate deployable:
that service already holds the agent's socket, so a standalone signaling service would have
to proxy every message through it anyway. Media takes a different path entirely — directly
between the PC's session host and the client, encrypted end to end, never entering the
cloud.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared-types` | Domain types, ids, risk levels, connection states, the error model |
| `packages/validation` | Runtime validation, Windows path safety, log redaction |
| `packages/protocol` | Typed commands, the command envelope, agent link messages, result schemas |
| `packages/telemetry-schema` | Telemetry samples, aggregates, retention policy |
| `packages/auth` | Password hashing, access tokens, refresh rotation, PC/device identity, lockout |
| `packages/server-core` | Config, database, migrations, repositories, shared jobs |
| `services/api` | HTTPS API: authentication, PCs, sessions, commands, telemetry, audit |
| `services/realtime` | WebSocket agent links, telemetry ingest, command delivery |
| `services/e2e` | End-to-end tests spanning API, realtime, and a protocol-level fake agent |
| `apps/web` | Next.js dashboard and PWA |
| `apps/windows-agent` | Windows Service host for the agent |
| `windows/agent` | Agent implementation, IPC, and its .NET tests |
| `windows/session-host` | Capture, encode, and WebRTC, running in the interactive session |

## Why the pieces are split this way

**`server-core` exists so the API and the realtime service can share one data layer.**
Both need the same repositories, the same migrations, and the same configuration contract.
Duplicating them would let the two services drift apart on the meaning of a command row,
which is exactly the kind of divergence that produces a command that one service thinks is
pending and the other thinks is done.

**The API never talks to an agent directly.** It writes a durable command row and issues a
Postgres `NOTIFY`. Whichever realtime instance holds that PC's link claims the command with
a single `UPDATE ... RETURNING` and delivers it. Two consequences follow:

- Delivery survives a lost notification, because a periodic sweep re-checks the queue.
- Two instances cannot deliver the same command, because claiming is atomic.

**Postgres carries the queue rather than a broker.** WOLF is a personal product with one
owner; adding Pub/Sub or Redis for a workload of a few commands a minute would buy
scalability nobody needs and cost an extra service to operate, secure, and pay for.
`LISTEN/NOTIFY` exists on Cloud SQL and on RDS, so this choice does not block the AWS
migration described in the PRD.

## Request path for a command

```
1. Browser  ── POST /api/v1/pcs/:id/commands ──►  API
2. API      validates the payload against the shared protocol schema
3. API      classifies risk from the *payload*, not the caller's claim
4. API      enforces capability, confirmation, re-authentication, privileged grant
5. API      refuses if the agent never advertised support for the command type
6. API      writes the command row + a "pending" audit record in one transaction
7. API      NOTIFY wolf_command
8. Realtime claims the row and sends it over the agent's authenticated link
9. Agent    checks expiry and idempotency, runs it, returns a typed result
10. Realtime validates the result against the schema, completes the row, audits it
```

Steps 3 to 5 all happen before anything is written. A refused command never appears as
pending work on a PC.

## State that matters

**Presence.** A PC is online only while its link is live. The link's `close` handler marks
it offline immediately, and a sweep marks silent PCs offline after ~90 seconds. The
dashboard never claims a machine is reachable once its link is gone.

**Sessions and capabilities.** An account token can browse. Acting on a PC requires a
session, which grants named capabilities (`processes`, `power`, …) and yields a token
scoped to one PC and one session. Privileged capabilities are never granted at session
start; they are obtained per action through a single-use grant.

**Exclusive resources.** Input, terminal, file operations, power, and configuration are
arbitrated independently per PC. Holding a capability does not imply holding the resource:
a lease has to be taken, only one session can hold each, and an expired lease can be taken
over so an idle operator cannot hold input forever.

## Telemetry storage

Raw samples land in `telemetry_samples`, partitioned by day. Retention drops whole
partitions rather than deleting rows, so expiry is instant and leaves nothing to vacuum.
Longer windows are answered from `telemetry_aggregates` at 5-minute, hourly, and daily
resolution; the API picks the coarsest tier that covers the requested window rather than
letting a caller ask for a year of one-second samples.

## Alerts

Alert rules are evaluated once a minute inside every API instance against the same telemetry
the charts draw. A rule answers breaching, clear or unknown, and unknown never changes an
alert, so a PC that stops reporting cannot resolve its own alert. State changes are
compare-and-set, so several instances still produce one notification. Delivery is an in-app
inbox only. See [alerts](alerts.md).

## Automations

Schedules, alert events and "Run now" start automations inside every API instance, and each claim —
a scheduled minute, an event, a cooldown — is made by exactly one instance. Their commands go
through a separate unattended dispatch path onto the ordinary pipeline, on authority recorded when
the automation was saved and tied to the device that saved it. Nothing critical can be automated.
See [automations](automations.md).

## Configuration backup

The owner's configuration — PC names and tags, remote desktop profiles, alert rules, automations —
is exported on request as a checksummed file the cloud does not keep, and restored section by section
in one transaction after the same confirmation a command of that risk needs. No credential, key or
authority is ever in a backup. See [configuration backup](configuration-backup.md).

## Cloud portability

Everything cloud-specific stays behind an interface. The application depends on Postgres,
an HTTP server, and a WebSocket server — all of which exist identically on GCP and AWS. The
mapping the PRD calls for (Cloud Run → ECS/App Runner, Cloud SQL → RDS, Secret Manager →
Secrets Manager) requires no change to business logic.

## What is deliberately not built yet

Milestone 1 covers the foundation and core management. These are *reported as unavailable*
by the agent's capability handshake rather than stubbed, so the cloud refuses commands for
them instead of queueing work that would never run:

- **Remote unlock**, which is refused rather than unbuilt: Windows has no API that unlocks a
  session, and the analysis is in [remote unlock](remote-unlock.md). What WOLF does instead is
  show the lock screen and let the operator sign in to it themselves
- Wake-on-LAN
- CPU package power, CPU temperature and thermal zones (GPU telemetry, drive health and per-process
  CPU and GPU arrived in milestone 5 — see [insights](insights.md))

The file manager is built and is described in [the file manager](file-manager.md). Delete,
rename and move are not: they are mutations that belong on the command path, where risk levels
and confirmations live.

The terminal is built and is described in [the terminal](terminal.md). What is *not* built
there is `terminal-admin`, the elevated shell: it needs a token the session host does not
have, so it is privileged-helper work and a slice of its own.

Two things that used to be on this list are not, and the correction is worth keeping: the
privileged helper exists and reads disk health, with device management running through it,
and secure-desktop capture and input turned out not to be helper work at all. They are a
session-isolation problem, solved by a second session host on `winsta0\Winlogon`. See
[the privileged helper](privileged-helper.md) and [remote desktop](remote-desktop.md).

See [the roadmap](../development/roadmap.md) for the order these land in.

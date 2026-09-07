# WOLF

**Remote PC Control & Management Platform** — a personal, secure, cross-device command center
for Windows PCs, reachable from the web, an installable PWA, and Android.

> Personal-use product. One owner account. No public registration.

## Repository layout

```
apps/
  web/                    Next.js web app + PWA
  android/                Kotlin / Jetpack Compose client
  windows-agent/          WOLF Agent Windows Service host (.NET)
  windows-control-panel/  Local WOLF Control Panel (.NET)
services/
  api/                    HTTPS REST API (auth, PCs, telemetry, audit, commands)
  realtime/               WebSocket presence / session state / command transport
  signaling/              WebRTC signaling
  telemetry/              Telemetry ingest + aggregation/retention jobs
  notifications/          Notification rule evaluation + delivery
  relay/                  TURN / encrypted relay coordination
packages/
  shared-types/           Cross-cutting domain types
  protocol/               Typed agent command protocol + envelopes
  auth/                   Tokens, password hashing, device/PC identity primitives
  telemetry-schema/       Telemetry sample + aggregate schemas
  api-client/             Typed client for the WOLF API (web + future tooling)
  validation/             Runtime validation shared by services and clients
windows/
  agent/          Agent implementation, IPC, and its .NET tests
  session-host/   Runs in the interactive session: displays, encoders, capture
  privileged-helper/ capture/ audio/ terminal/ installer/
infrastructure/
  gcp/ docker/ terraform/ monitoring/ ci/
docs/
  architecture/ security/ api/ protocol/ deployment/ development/
scripts/
```

`windows/` holds the .NET libraries and native components; `apps/windows-agent` and
`apps/windows-control-panel` hold the shippable Windows applications that consume them.

## Prerequisites

| Tool | Version | Used by |
| --- | --- | --- |
| Node.js | >= 22 | services, web, packages |
| PostgreSQL | >= 15 | API / telemetry / audit storage |
| .NET SDK | >= 8 | Windows agent, helper, control panel |
| Android Studio / JDK 17 | latest stable | Android client |

## Getting started

```bash
npm install
cp .env.example .env      # fill in local values, never commit .env
npm run db:migrate
npm run dev:api
npm run dev:web
```

See [docs/development/getting-started.md](docs/development/getting-started.md) for the full
local setup, including creating the single owner account.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Security model](docs/security/security-model.md)
- [Command protocol](docs/protocol/command-protocol.md)
- [API reference](docs/api/README.md)
- [Deployment](docs/deployment/README.md)

## Status

**Milestone 1 (Foundation and core management) is complete and verified end to end:**
enrolment, presence, live telemetry, processes, power, sessions with per-capability grants,
risk-based confirmation, the kill switch, and the audit log — from the browser, through the
cloud, to a Windows agent, and back.

**Milestone 2 (Remote desktop) is feature-complete:** you can watch a PC's screen in the browser
and drive it. The stream protocol, the signaling relay, the Windows session host, a capture
pipeline that takes the screen to hardware-encoded H.264 without a frame leaving the GPU, a
WebRTC peer connection that carries it, a dashboard that renders it with live statistics
from both ends, and keyboard and mouse input — measured at 30 fps at 2560×1440 for 0.57 ms
of encode time per frame on an RTX 3060. Control of a PC is arbitrated by the cloud, granted
to one session at a time, and expires unless it is renewed.

You can hear it too. WOLF streams what the PC is playing — never its microphone — behind a
permission granted separately from watching, and the viewer starts every stream muted.

The stream adapts: it reads congestion feedback and the receiver's reported loss, lowers the
bitrate, then the frame rate, then the resolution to keep the picture moving, raises them
again slowly, and says which of the two ends is the reason whenever it is running below the
profile you asked for.

395 tests pass (256 Node, 139 .NET), including a full web-to-agent end-to-end suite that runs
against a real Postgres engine in-process and needs no external services, and a Windows
suite that runs against the real display, GPU, input stack, and a live WebRTC peer.

Capabilities that belong to later milestones — remote desktop, terminal, files, the
privileged helper — are reported by the agent as *unavailable*, so the cloud refuses those
commands rather than queueing work that would never run. See
[docs/development/roadmap.md](docs/development/roadmap.md).

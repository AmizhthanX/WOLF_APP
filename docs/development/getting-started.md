# Getting started

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 22 or newer | services, web, shared packages |
| PostgreSQL | 15 or newer | running the API against a real database |
| .NET SDK | 9 | the Windows agent |
| Windows | 10 or 11, 64-bit | running the agent |

The test suites need neither PostgreSQL nor a Windows host: they run against an in-process
Postgres (PGlite) and a protocol-level fake agent.

## First run

```bash
npm install
npm run build
npm test
```

That builds every workspace and runs the full suite. Nothing external is required.

## Measuring performance

```bash
npm run test:windows:perf
```

Runs the performance suite, which the ordinary run excludes. It measures the real GPU,
display, and input stack, so it needs a Windows machine with a screen — on a hosted CI runner
it would measure nothing. It takes about half a minute and briefly shows a small window in
the corner of the screen, which is there to give screen capture something to do: an idle
desktop produces almost no frames, and a pipeline measured against one is not being measured
at all.

Every number it prints is a measurement, and every budget it asserts lives in one file,
`windows/agent/Wolf.Agent.Core.Tests/Performance/PerformanceBudgets.cs`.

## Running the cloud locally

```bash
cp .env.example .env
```

Fill in at least `DATABASE_URL` and `WOLF_TOKEN_SECRET`. Generate a secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Create the database and apply migrations:

```bash
createdb wolf
npm run db:migrate
```

Create the single owner account. The password is read from the environment rather than an
argument, because arguments appear in process listings and shell history:

```bash
WOLF_OWNER_EMAIL=you@example.com WOLF_OWNER_PASSWORD='a long passphrase' npm run bootstrap:owner -w @wolf/api
```

Start the services in separate terminals:

```bash
npm run dev:api
```

```bash
npm run start -w @wolf/realtime
```

```bash
npm run dev:web
```

The dashboard is at http://localhost:3000. The API defaults to port 8080; set `PORT` for
the realtime service to something else (for example `PORT=8081`) since both read the same
variable.

## Enrolling a Windows PC

1. Sign in to the dashboard and choose **Add a PC**. The enrollment token is shown once —
   only a hash of it is stored.
2. Build the agent:

   ```bash
   dotnet build windows/Wolf.sln -c Release
   ```

3. Point the agent at your local cloud by editing
   `apps/windows-agent/Wolf.Agent.Host/appsettings.json`, or by setting
   `Wolf__ApiBaseUrl` and `Wolf__RealtimeUrl` in the environment.
4. Run it once with the token in the environment:

   ```powershell
   $env:WOLF_ENROLLMENT_TOKEN = "PASTE-TOKEN-HERE"
   dotnet run --project apps/windows-agent/Wolf.Agent.Host
   ```

   The agent generates its key pair, enrols, stores the identity under
   `C:\ProgramData\WOLF` protected by DPAPI, and connects. The token is single-use and is
   never written to disk.

Running it as a Windows service instead:

```powershell
sc.exe create WolfAgent binPath= "C:\Path\To\Wolf.Agent.exe" start= auto
sc.exe start WolfAgent
```

The service needs `SeShutdownPrivilege` for power actions; LocalSystem holds it, and the
agent enables it on its own token when needed.

## What works today

Enrolment, presence, live telemetry (CPU, memory, disks, network, battery, WOLF's own
usage), the process list, process termination with PID-reuse protection, priority changes,
power actions, the kill switch, sessions with per-capability grants, risk-based
confirmation, and the audit log.

Anything not in that list is reported by the agent as unavailable, and the cloud refuses it
rather than queueing work that would never run. See
[the roadmap](roadmap.md).

## Layout of a change

WOLF is built in vertical slices. A new capability touches, in this order:

1. `packages/protocol` — the command, its risk, its result schema
2. `packages/server-core` — migrations and repositories, if it needs storage
3. `services/api` — authorization and dispatch
4. `windows/agent` — the handler, plus its capability advertisement
5. `apps/web` — the UI
6. Tests at each level, then the docs

The agent must advertise a command type before the cloud will dispatch it, so a
half-finished slice is inert rather than dangerous.

## Useful commands

```bash
npm test -w @wolf/auth                # one workspace
npm run build --workspaces            # everything
dotnet test windows/Wolf.sln          # the Windows agent
npm run typecheck -w @wolf/web        # the dashboard
```

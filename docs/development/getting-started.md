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

## Running the whole loop locally

`npm run dev:cloud` starts the real API and the real relay on 8080 and 8081, against an
in-process Postgres. Nothing external is needed — no Postgres server, no `.env`:

```bash
npm run dev:cloud
```

Its database lives only in memory, so every restart is a fresh cloud and any PC enrolled
against the previous run is gone. The owner is `owner@example.com` with the passphrase
`a-long-local-passphrase`, both overridable with `WOLF_OWNER_EMAIL` and
`WOLF_OWNER_PASSWORD`. It refuses to start with `NODE_ENV=production`.

Commands reach the agent the way they do deployed: the API writes the command and issues
`pg_notify('wolf_command', …)`. A deployed realtime service hears that through its own Postgres
`LISTEN` connection, which an in-process Postgres has no server for, so the local cloud subscribes
the same channels in-process, with the same 15-second backstop sweep. (Until that was added, a
command sent through the local cloud was written and never delivered.)

Point the agent at it with `Wolf__ApiBaseUrl`, `Wolf__RealtimeUrl`, and — unless you are
running elevated — `Wolf__DataDirectory`, since the identity store's default lives under
`C:\ProgramData` where a standard user cannot create it.

To drive a real browser at a real stream, create a session through the API and serve the
loop-test page:

```bash
WOLF_HARNESS_SESSION_TOKEN=<session token> npm run browser -w @wolf/e2e
```

It serves `http://127.0.0.1:3100/`, which drives the dashboard's own streaming state machine
— not a second implementation of it — and reports what the browser actually decoded, read
from its own WebRTC statistics rather than from what the page was told. `window.__wolf`
holds the same figures for a test driver to read back.

The dashboard's device key depends on things Node's test runner does not have — IndexedDB
keeping a non-extractable key across page loads, and Web Locks across tabs. To check them in a
real browser, build the web workspace's test output:

```bash
npm test -w @wolf/web
```

then serve the device-key page:

```bash
npm run browser:device-key -w @wolf/e2e
```

It serves `http://127.0.0.1:3110/`, which runs the dashboard's own `lib/device-key.ts`: five
concurrent key creations under Web Locks yielding one key, the key surviving a reload, its
private half refusing export, its web refresh proof verified by the API's verifier on the
harness side, and a cleared database noticed. Results appear on the page, in `window.__wolf`,
and in the harness's console. Add `?run=<label>` to the URL to name a run in the console when
checking several browsers.

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

## Building the Android app

Needs the Android SDK (platform 36) and a JDK 21–25 for Gradle; the app has no Java sources, so an
IDE's bundled runtime is enough even without `jlink`. Point `apps/android/local.properties` at the SDK
(`sdk.dir=…`) and `JAVA_HOME` at the JDK.

```bash
npm run test:android
```

With an emulator or phone connected, the Keystore tests run on it:

```bash
npm run test:android:device
```

To run the live test against a real API, start the local cloud first and pass its address and the
owner password as instrumentation arguments — see `LiveApiTest.kt`. From the emulator the development
machine is `10.0.2.2`.

**Push wake-ups** need a Firebase project of your own ([push](../architecture/push.md)). Without one the
app builds and runs with no push service and says so. With one, give the app its project settings —
not credentials, but per deployment, so in `apps/android/local.properties` (ignored by git) or as `-P`:

```properties
wolf.firebase.applicationId=1:000000000000:android:0000000000000000
wolf.firebase.projectId=your-firebase-project
wolf.firebase.apiKey=…
wolf.firebase.senderId=000000000000
```

and give the API `WOLF_PUSH_PROVIDER=fcm`, `WOLF_FCM_PROJECT_ID` and `WOLF_FCM_CREDENTIALS_FILE` (a
service-account key file; `npm run dev:cloud` reads the same three).

## Useful commands

```bash
npm test -w @wolf/auth                # one workspace
npm run build --workspaces            # everything
dotnet test windows/Wolf.sln          # the Windows agent
npm run typecheck -w @wolf/web        # the dashboard
```

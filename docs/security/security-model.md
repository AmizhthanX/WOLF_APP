# WOLF security model

WOLF can terminate processes, shut machines down, and (in later milestones) drive a
desktop and open a terminal. The security model is therefore the product, not a layer on
top of it. This document states what is enforced, where, and why.

## Identity

**One owner account.** There is no registration endpoint. The account is created by
`bootstrap:owner`, which runs against the database and refuses if an owner already exists.
A partial unique index on `users(is_owner)` makes a second owner impossible at the database
level, so even a mistakenly-added endpoint could not create one.

**Passwords** are hashed with scrypt (N=2^16, r=8), parameters stored inside the encoded
hash so they can be raised later without invalidating existing credentials. Verification is
constant-time, malformed stored hashes fail closed, and cost parameters read from storage
are bounds-checked so a tampered row cannot make the verifier allocate gigabytes.

scrypt rather than Argon2id: it is memory-hard, it ships with Node, and it therefore adds
no compiled dependency to a build that must run on Windows, Cloud Run, and CI alike.

**Every PC and every client device holds its own key pair** (ECDSA P-256). The private key
never leaves the machine — DPAPI-protected on Windows, in the platform keystore on Android.
The cloud stores only public keys, so revoking one machine never touches another.

P-256 rather than Ed25519: both Node and .NET implement it natively, which keeps a
third-party crypto library out of a privileged Windows service. A golden-vector test in
each runtime pins the encodings so neither side can drift.

## Tokens

| Token | Lifetime | Storage | Revocation |
| --- | --- | --- | --- |
| Access | 10 minutes | Browser memory only | Expiry, or device revocation on next call |
| Session | 10 minutes, PC-scoped | Browser memory only | Session end |
| Refresh | 30 days, rotating | httpOnly `SameSite=Strict` cookie | Rotation, family revocation, device revocation |

Access tokens are signed compact JWS with a pinned algorithm — the token's own `alg` is
never trusted, which is how `none` and algorithm-confusion attacks get in. Issuer and
audience are both enforced. A valid signature is not sufficient: the device must still
exist and be active, so revoking a device takes effect within one access-token lifetime.

**Refresh tokens rotate on every use.** Presenting an already-consumed token means the
token was copied, so the entire family is revoked and every session on that device ends.
Only a SHA-256 of the secret half is stored, so a database disclosure yields no usable
tokens. Consumption is an atomic `UPDATE ... WHERE consumed_at IS NULL`, so two concurrent
refreshes cannot both succeed.

The web dashboard never sees a refresh token. It posts credentials to a Next.js route that
captures the refresh token into an httpOnly cookie and returns only the access token. An
XSS bug in the dashboard can therefore reach a credential that expires in minutes, not
durable access to every PC.

## Brute force

Failures are counted per account with exponential backoff (3 free attempts, then 5s
doubling to a 15-minute cap, forgotten after an hour) and per source address by a
per-instance limiter. The account is never permanently locked: on a single-owner product
that would be a denial of service anyone could trigger. Every block is recorded as a
security event.

An unknown email and a wrong password produce the same message and comparable work, so the
response cannot be used to discover the owner's address.

## Risk-based authorization

Every command is classified from its **payload**, not from what the caller claims:

| Level | Requires | Examples |
| --- | --- | --- |
| Low | Capability only | Read processes, read telemetry |
| Medium | Explicit confirmation | Terminate an ordinary process, change priority |
| High | Confirmation + password within 5 minutes | Restart, shut down, force-terminate |
| Critical | The above + a single-use privileged grant within 2 minutes | Remote unlock, terminate a critical system process, forced shutdown |

Classification **escalates on the payload**: terminating `lsass.exe` is critical even
though `process.terminate` is nominally medium, and a forced shutdown is critical even
though shutdown is nominally high.

The confirmation carries the risk level the operator was shown, and the server requires it
to match its own classification. A UI that offered "terminate notepad" therefore cannot
confirm a command the server classifies as terminating `lsass.exe` — the mismatch is
refused, and the client is told the true level so it can re-prompt.

Privileged grants are single-use, scoped to one PC and one session, expire in minutes, and
are consumed as part of authorizing the command.

## Capabilities

Sessions grant named capabilities individually: `screen`, `audio`, `input`, `clipboard`,
`file-transfer`, `terminal`, `terminal-admin`, `processes`, `services`, `power`,
`configuration`, `privileged`. A session that can read the process list has no input, no
files, and no terminal.

`privileged` and `terminal-admin` cannot be requested at session start at all. They are
obtained per action.

## The agent link

The PC dials out over TLS. Before the socket carries anything:

1. The cloud sends a random per-connection nonce.
2. The agent signs `wolf-agent-auth v1 <pcId> <nonce>` with its private key.
3. The cloud verifies against the stored public key for that PC.

The signed payload binds both the PC id and the nonce, so a captured signature cannot be
replayed on a later connection or for a different machine. Both properties are covered by
tests. A message sent before authentication closes the link.

## The session host

Remote desktop needs a process inside the interactive session, because a service in
session 0 cannot see a desktop or inject input. That process is launched by the service
with the signed-in user's token, so it runs **as that user** and holds no more privilege
than the person at the keyboard.

The control channel between them is a named pipe whose ACL allows only SYSTEM,
Administrators, and the user the host runs as. Without that restriction, any local user
could connect and drive the capture pipeline of whoever happens to be signed in.

Media and input do not cross that pipe. They travel directly between the session host and
the remote peer over WebRTC, which keeps frame data and keystrokes out of the most
privileged process on the machine and avoids a copy per frame.

Captured frames live on the GPU and are never written to disk. Disposing the pipeline stops
the capture thread and releases the frame pool, and a test asserts that no frame arrives
after disposal — a pipeline that kept running would be capturing somebody's screen after
the session that authorised it had ended.

Capture does not begin at all until the remote peer is connected. A stream that is
negotiated but never answered leaves nothing running.

Clipboard content moves on the same direct channel and is **never stored anywhere** — not in
the cloud, which never receives it, and not in a log, which never records it. It is gated on
the `clipboard` capability, and without that grant the PC's clipboard is not read at all. The
host keeps only a hash of the last content that crossed, to stop the two machines trading the
same string forever, and forgets even that when the stream ends.

Audio is **loopback only** — the sound the PC is producing, never a microphone. Nothing in
the agent can hear the room a machine is sitting in. It is gated on the `audio` capability,
which is granted separately from `screen`: the relay decides and the session host enforces,
defaulting to silent when the decision is missing. Audio is never stored, in the cloud or on
the PC — the samples are encoded and sent, and nothing is written to disk.

Media is encrypted end to end by DTLS-SRTP between the session host and the client. A TURN
relay, where one is configured, forwards packets it cannot read; it learns session metadata
and transport addresses and nothing else. The relay is chosen by the cloud, never by the
client: TURN credentials are minted server-side from a secret the agent does not hold, and
attached to the relayed stream request rather than carried inside a payload the client
controls.

## Remote control

Watching a PC and driving it are separate grants. `screen` lets a session receive frames;
`input` is an *exclusive* resource, held by one session at a time, and a session granted only
`screen` cannot acquire it by asking on a different channel.

The relay is the only party that decides who holds it. `input.control` — the message saying
who is driving — is in neither direction list, so neither a client nor an agent may send one;
a client that could would be granting itself the keyboard. It is delivered to both ends,
because the PC needs it to gate injection and the browser needs it to decide whether to
capture the operator's keyboard, and the two must not disagree.

The grant expires after two minutes and is renewed by the client holding it. The session host
enforces that expiry itself, so a cloud that becomes unreachable mid-session cannot leave a
machine controllable by whoever held it last. Losing control releases every modifier, so a
client that vanishes mid-chord does not leave the keyboard stuck.

Input events do not pass through the cloud — they travel on the data channel directly, so a
keystroke does not take a server round trip. The consequence is that the session host is the
only component that validates them, and it does: coordinates, key codes, text length, and
batch size are all re-checked there, and anything outside its bounds is refused rather than
clamped into something adjacent.

Windows boundaries are reported, not worked around. Input to a window running at a higher
integrity level is refused by the OS and reported as a limitation; Ctrl+Alt+Delete and Win+L
are refused with the reason rather than sent as keystrokes that do nothing.

## Signaling

The relay standing between an authenticated user and a live desktop enforces, on every
message rather than once at connect time:

- The socket authenticated with a **session token**, not an account token, and the session
  is re-checked against live state — an ended session cannot signal because its token has
  not expired yet.
- The session holds the `screen` capability.
- The PC's kill switch is not engaged.
- `envelope.sessionId` matches the authenticated session; aiming at another session closes
  the link and is recorded as a security event.
- The payload is one the sender's role may send. A client cannot publish `stream.stats`; an
  agent cannot send `stream.request`; an agent cannot address a session belonging to a
  different PC.

Nothing is forwarded as opaque bytes: every message is parsed, validated, and re-serialized.

TURN credentials are minted per request from a shared secret, expire on their own, and are
only issued to a session that already holds the `screen` capability.

## The kill switch

Two levels, and both are one-way from the cloud:

- **Remote:** disables remote access, ends every session, and makes the API refuse commands
  before they reach the PC. The endpoint's schema only accepts `false`; there is no request
  shape that re-enables access.
- **Local:** the agent's own switch, stored locally, which refuses commands even if the
  cloud dispatches them.

Re-enabling requires local authentication on the PC. An attacker who reaches the cloud
cannot undo an operator's shutdown of remote access.

## What never leaves the machine, and what is never stored

The cloud **must not** store: screen or audio recordings, clipboard contents, transferred
file contents, terminal output, Windows credentials, or the WOLF unlock credential.

Enforcement is structural rather than a convention. Every audit record and every log line
passes through a shared redactor that blanks any field whose name matches a secret pattern
(`password`, `token`, `secret`, `clipboard`, `stdout`, `fileContent`, …) at any depth. A
new payload field cannot leak by being forgotten; it has to be deliberately named around
the filter. There is a test asserting that clipboard text, terminal output, and file
content are redacted while the surrounding metadata survives.

## Windows path safety

Two gates guard every file path, and only the first is in shared code:

1. **Syntactic** (`@wolf/validation`): rejects traversal, relative paths, device-namespace
   and extended-length prefixes (`\\?\`, `\\.\`), reserved device names (`CON`, `NUL`,
   `COM1`…), alternate data streams, wildcards, and trailing dots or spaces — which Windows
   silently strips, making `evil.exe.` and `evil.exe` the same file but different strings.
2. **Filesystem** (the agent): symlink, junction, and reparse-point resolution, which
   cannot be decided without touching the disk.

A pass at gate 1 is never authorization to act. 22 tests cover the syntactic gate.

## PID reuse

Windows recycles process ids quickly. Every mutating process command carries the name the
operator believed they were acting on, and the agent refuses if the live process does not
match — reported as `target-changed`, with nothing terminated. Without this, a confirmation
approved seconds earlier could kill an unrelated process that inherited the number. Covered
by a test that runs against a real process.

## Commands never run late

A command carries an absolute `expiresAt`. Both sides enforce it: the API expires overdue
rows, and the agent refuses a command that arrived after its deadline. Scheduled power
actions store an absolute instant and are **discarded** if that instant passed while the
agent was not running — a shutdown must never fire simply because a machine came back
online.

Idempotency keys are enforced by a unique index, so two concurrent retries cannot both
insert, and the agent keeps its own record of completed command ids so a redelivery returns
the original outcome instead of acting twice.

## Honest capability reporting

The agent advertises exactly the command types it can execute. The API refuses anything
absent from that list with a specific error, rather than queueing work that would never
run. Capabilities the current build cannot deliver — secure-desktop capture, the privileged
helper, remote unlock, hardware encoders — are reported as unavailable, and the dashboard
shows them as such with the reason.

Where Windows itself prevents an operation, the result is marked `limitation: true` and the
UI says so, rather than presenting a WOLF failure or, worse, a success that did not happen.

## Web hardening

Content-Security-Policy without remote script origins, `frame-ancestors 'none'`,
`nosniff`, `Referrer-Policy: same-origin`, and a restrictive `Permissions-Policy`. CORS is
an explicit origin allow-list; `*` is rejected at startup in production, as is a non-HTTPS
production origin. State-changing dashboard routes require a custom header that a
cross-origin form post cannot set, with `SameSite=Strict` as the second layer.

## Logging

Structured logs carry a request id, a WOLF error reference id, and the user, device, and PC
involved — never payloads. Every user-visible failure carries a `WOLF-<AREA>-<HEX>`
reference that also appears in the logs, so an operator can quote it and find the exact
request.

## Test coverage of the above

| Area | Where |
| --- | --- |
| Password hashing, tokens, rotation, replay, lockout | `packages/auth/src/*.test.ts` |
| Path traversal and Windows path tricks | `packages/validation/src/windows-path.test.ts` |
| Redaction | `packages/validation/src/redact.test.ts` |
| Risk classification and escalation | `packages/protocol/src/commands/registry.test.ts` |
| Authorization pipeline | `services/api/src/services/command-service.test.ts` |
| Agent handshake, impersonation, replay | `services/realtime/src/agent-link.test.ts` |
| Schema-level guarantees | `packages/server-core/src/db/schema.test.ts` |
| Full path, web to agent | `services/e2e/src/vertical-slice.test.ts` |
| Signaling authorization and direction | `services/e2e/src/remote-desktop.test.ts` |
| Stream availability reasoning | `windows/agent/Wolf.Agent.Core.Tests/RemoteDesktopAvailabilityTests.cs` |
| Capture stops when the pipeline does | `windows/agent/Wolf.Agent.Core.Tests/CapturePipelineTests.cs` |
| Stream negotiation, delivery, and teardown | `windows/agent/Wolf.Agent.Core.Tests/StreamSessionTests.cs` |
| ICE credential minting and scoping | `packages/server-core/src/ice.test.ts` |
| Browser signaling contract and stream isolation | `apps/web/lib/remote-desktop.test.ts` |
| Input authorization, expiry, and bounds | `windows/agent/Wolf.Agent.Core.Tests/InputChannelTests.cs` |
| Input arbitration between sessions | `services/e2e/src/remote-desktop.test.ts` |
| Adaptation policy under congestion | `windows/agent/Wolf.Agent.Core.Tests/RateControllerTests.cs` |
| Audio capture, and the grant that gates it | `windows/agent/Wolf.Agent.Core.Tests/AudioCaptureTests.cs` |
| Clipboard grant, loop prevention, and bounds | `windows/agent/Wolf.Agent.Core.Tests/ClipboardTests.cs` |
| Session host bridge and ACL'd IPC | `windows/agent/Wolf.Agent.Core.Tests/SessionHostSupervisorTests.cs` |
| Cross-runtime signature interop | `packages/auth/src/interop.test.ts`, `windows/.../IdentityInteropTests.cs` |
| PID reuse, critical process refusal | `windows/agent/Wolf.Agent.Core.Tests/CommandRouterTests.cs` |

## Known gaps

Stated plainly rather than left to be discovered:

- **The per-instance rate limiter is per-instance.** Across several API instances it bounds
  abuse per instance, not globally. The per-account lockout is shared through Postgres and
  cannot be bypassed that way, which is why authentication relies on it rather than on the
  limiter. A shared limiter is a drop-in replacement for the interface.
- **The privileged helper does not exist yet**, so every operation needing elevation is
  refused with a stated limitation.
- **Lock-state detection is an inference** (the presence of `LogonUI.exe` in the console
  session), because Windows exposes no supported query for it from a service. When the
  console session cannot be resolved, the state is reported `unknown`, never optimistically
  as `desktop`.
- **No penetration test has been run.** The security tests here are the author's, not an
  independent assessment.

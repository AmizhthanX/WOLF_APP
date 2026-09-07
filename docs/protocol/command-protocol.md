# Command protocol

The contract between the cloud and an agent. `packages/protocol` is the source of truth;
the Windows agent mirrors it in `Wolf.Agent.Core/Protocol`, and golden-vector tests on both
sides catch drift.

Protocol version: **1**.

## Agent link

The PC dials out over TLS. The handshake, in order:

```
cloud  → agent   cloud.challenge      { nonce, serverTime }
agent  → cloud   agent.auth           { pcId, agentVersion, nonce, signature }
cloud  → agent   cloud.auth-accepted  { pcId, heartbeatSeconds, telemetryUploadSeconds, … }
             or  cloud.auth-rejected  { reason, retryAfterSeconds }
agent  → cloud   agent.hello          { info, capabilities, sessionState, … }
```

The signature covers exactly:

```
wolf-agent-auth v1 <pcId> <nonce>
```

ECDSA P-256 with SHA-256, DER-encoded, base64url. Binding both the PC id and the nonce
means a captured signature cannot be replayed on a later connection or for another machine.

Any message sent before `agent.auth` closes the link.

### Steady state

| Direction | Message | Purpose |
| --- | --- | --- |
| agent → cloud | `agent.heartbeat` | Presence and Windows session state |
| agent → cloud | `agent.telemetry` | Batched samples, flagged when replaying an offline buffer |
| agent → cloud | `agent.command-result` | Terminal outcome for a command |
| agent → cloud | `agent.command-progress` | Progress for long-running work |
| agent → cloud | `agent.event` | Something that was not the result of a command |
| cloud → agent | `cloud.command` | A command envelope |
| cloud → agent | `cloud.cancel` | Withdraw a non-terminal command |
| cloud → agent | `cloud.kill-switch` | Remote access was disabled |
| cloud → agent | `cloud.ping` | Liveness |

## The command envelope

```ts
{
  protocolVersion: 1,
  commandId, pcId, requestId,
  issuedAt, expiresAt,        // absolute; a late command is refused, never run
  idempotencyKey,             // repeated key runs at most once
  authorization: {            // proof of what was checked, never secrets
    userId, deviceId, sessionId, route,
    grantedCapabilities, riskLevel,
    confirmedAt, reauthenticatedAt, privilegedGrantId
  },
  command: { type, payload }  // discriminated union, validated by schema
}
```

`authorization` carries no confirmation token, password, or credential — only the fact that
each check was satisfied and when, so every audit record can answer "on what basis was this
allowed?" without replaying the request.

## Results

```ts
{
  protocolVersion: 1,
  commandId, status,
  startedAt, completedAt,
  failure: { code, message, limitation, recommendedAction } | null,
  result: <schema for the command type> | null,
  agentVersion
}
```

Results are validated against the schema for their command type. An agent returning
something off-contract produces a recorded failure, not a stored blob a UI cannot read.

`limitation: true` marks a Windows platform constraint rather than a WOLF fault, and the UI
says so.

### Error codes

`unsupported-command`, `unsupported-on-this-windows-version`, `capability-unavailable`,
`not-found`, `target-changed`, `access-denied`, `requires-elevation`,
`privileged-helper-unavailable`, `blocked-by-policy`, `blocked-by-kill-switch`, `timeout`,
`expired`, `cancelled`, `agent-error`, `invalid-payload`.

## Commands in version 1

| Type | Risk | Capability | Mutating |
| --- | --- | --- | --- |
| `system.info` | low | processes | no |
| `system.capabilities` | low | processes | no |
| `system.telemetry-snapshot` | low | processes | no |
| `system.session-state` | low | processes | no |
| `process.list` | low | processes | no |
| `process.tree` | low | processes | no |
| `process.details` | low | processes | no |
| `process.terminate` | medium ↑ | processes | yes |
| `process.set-priority` | medium ↑ | processes | yes |
| `process.start` | medium | processes | yes |
| `power.action` | high ↑ | power | yes |
| `power.schedule` | high ↑ | power | yes |
| `power.cancel` | medium | power | yes |
| `power.pending` | low | power | no |
| `power.wake` | medium | power | yes |
| `power.unlock` | critical | privileged | yes |

**↑ escalates on payload:**

- `process.terminate` → **critical** for a critical Windows process, **high** for a WOLF
  process or when forced or applied to a tree
- `process.set-priority` → **high** for realtime priority, which can starve the very
  threads carrying the session
- `power.action` / `power.schedule` → **critical** when forced

## Design rules

**Typed commands, never arbitrary JSON.** `process.start` takes an application id and an
argument *vector*, never a shell string, so nothing gets re-parsed by a shell.

**A PID is never enough.** Every mutating process command carries `expectedName`, and the
agent refuses if the live process does not match.

**A schedule names an instant.** `power.schedule` requires an absolute `runAt`. A missed
schedule is abandoned on agent restart, never caught up.

**Capability handshake gates dispatch.** `agent.hello` advertises `supportedCommands`, and
the API refuses anything absent from it.

## Adding a command

1. Define the payload schema in `packages/protocol/src/commands/`
2. Add it to `COMMAND_REGISTRY` with risk, capability, mutating flag, and audit category
3. Add its result schema to `RESULT_SCHEMAS` — the `satisfies` check fails the build if you
   forget
4. Add payload-based escalation to `classifyRisk` if it needs any
5. Implement the handler in the agent and add the type to its `SupportedTypes`
6. Tests at each level

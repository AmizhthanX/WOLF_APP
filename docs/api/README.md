# WOLF API

Base path: `/api/v1`. All responses are JSON. All timestamps are UTC ISO-8601.

## Authentication

`Authorization: Bearer <access token>` on every endpoint except sign-in, agent enrolment,
and the health checks.

Two token kinds reach these endpoints:

- **Account token** — issued at sign-in. Can browse PCs, read audit and telemetry, manage
  devices and enrolment tokens.
- **Session token** — issued by `POST /pcs/:pcId/sessions`. Scoped to one PC and one
  session and carries the capabilities that session was granted. Required to dispatch
  commands.

## Errors

Every failure returns the same envelope:

```json
{
  "error": {
    "code": "command.confirmation_required",
    "problem": "Terminate a process needs to be confirmed.",
    "cause": "This action is classified medium risk.",
    "currentState": "Nothing was changed.",
    "recommendedAction": "Confirm the action to proceed.",
    "referenceId": "WOLF-CMD-8F2C",
    "httpStatus": 428,
    "context": { "riskLevel": "medium", "action": "Terminate a process" }
  }
}
```

`referenceId` also appears in the structured logs. `context` carries machine-readable,
non-secret facts a client needs to react — the risk level to confirm, a retry-after — and
never payload values.

## Endpoints

### Authentication

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` | Email, password, device descriptor. Rate limited. No registration endpoint exists. |
| POST | `/auth/refresh` | Rotates the refresh token. Requires the device id. A replayed token revokes the family. |
| POST | `/auth/logout` | Always 204. |
| POST | `/auth/reauthenticate` | Refreshes `auth_time` for high and critical actions. |
| GET | `/users/me` | Account, current device, and how long ago the password was proven. |

### Devices

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/devices` | Public keys are truncated in the response. |
| PATCH | `/devices/:deviceId` | Toggle LAN authorization. |
| DELETE | `/devices/:deviceId` | Revokes tokens and ends sessions in one transaction. A device cannot revoke itself. |

### PCs

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/pcs` | Every PC with capabilities, hardware, session and pending-command counts. |
| GET | `/pcs/:pcId` | Detail, active sessions, latest telemetry sample. |
| PATCH | `/pcs/:pcId` | Rename, favourite, tags. |
| POST | `/pcs/:pcId/kill-switch` | Accepts `remoteAccessEnabled: false` only. Re-enabling requires local authentication on the PC. |

### Enrolment

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/pcs/enrollment-tokens` | Returns the token once; only a hash is stored. |
| GET | `/pcs/enrollment-tokens` | Outstanding, unconsumed tokens. |
| DELETE | `/pcs/enrollment-tokens/:tokenId` | Revoke an unused token. |
| POST | `/agents/enroll` | Called by the installer. Unauthenticated but token-gated and rate limited. Single use. |

### Sessions

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/pcs/:pcId/sessions` | Grants named capabilities and returns a session token. `privileged` and `terminal-admin` are refused here. |
| POST | `/pcs/:pcId/sessions/:sessionId/token` | Re-issues the token after a password re-entry, keeping the session and its leases. |
| DELETE | `/pcs/:pcId/sessions/:sessionId` | End a session. |

### Commands

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/pcs/:pcId/commands` | Dispatch. Optional `waitSeconds` (≤30) waits for a result. |
| GET | `/pcs/:pcId/commands` | Recent commands. |
| GET | `/pcs/:pcId/commands/:commandId` | One command with its result. |
| POST | `/pcs/:pcId/privileged-grants` | Single-use grant for a critical action. Needs a password re-entry within 120 seconds. |

Dispatch body:

```json
{
  "command": { "type": "process.terminate", "payload": { "pid": 4821, "expectedName": "notepad.exe" } },
  "confirmedRiskLevel": "medium",
  "idempotencyKey": "optional-client-key",
  "waitSeconds": 8
}
```

Responses: `202` queued, `200` when a repeated idempotency key resolved to an existing
command (`deduplicated: true`), `428` when confirmation, re-authentication, or a privileged
grant is needed, `403` for a missing capability, `409` for offline, kill-switched, or
unsupported.

### Telemetry

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/pcs/:pcId/telemetry/latest` | Latest sample. A null sample on an online PC means telemetry has not arrived yet — not zero usage. |
| GET | `/pcs/:pcId/telemetry` | `from`, `to`, `metrics`, `resolution`. The server picks the coarsest tier covering the window unless one is pinned. |

### Audit

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/audit` | Account-wide, filterable by PC, category, outcome, and time. Cursor paginated. |
| GET | `/pcs/:pcId/audit` | The same, scoped to one PC. |

### Remote desktop

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/pcs/:pcId/ice-servers` | STUN and short-lived TURN credentials. Requires the `screen` capability, so credentials are only minted for a session authorized to view that PC. |
| GET | `/pcs/:pcId/streams` | Streams currently running on a PC, including ones started by another session. |
| GET | `/remote-desktop/profiles` | Built-in profiles plus the account's saved ones. |
| POST | `/remote-desktop/profiles` | Create. Validated against the profile schema. |
| PATCH | `/remote-desktop/profiles/:profileId` | Update. |
| DELETE | `/remote-desktop/profiles/:profileId` | Delete. |

The ICE response carries a `reachability` field. When no STUN or TURN server is
configured it reads `lan-only`, with a `note` explaining that streaming will work on the
same network and nowhere else — stated up front rather than discovered by a connection
that never completes.

### Signaling (WebSocket)

Not part of the REST API. Browsers and Android clients connect to the realtime service at
`wss://relay.<domain>/client` and authenticate with a **session token** — an account token
is refused. The first message must be `client.auth`; nothing else is accepted until it
succeeds.

Every signaling message is validated, bound to a session, and checked for direction before
being relayed. A client cannot publish `stream.stats`, an agent cannot send
`stream.request`, and neither can address a session belonging to a different PC. See
[the command protocol](../protocol/command-protocol.md) and
[the remote desktop architecture](../architecture/remote-desktop.md).

### Health

`GET /healthz` (liveness) and `GET /readyz` (database reachable). Both unauthenticated and
deliberately free of anything that would help profile the deployment.

## Rate limits

| Class | Limit |
| --- | --- |
| Sign-in | 10 per 5 minutes per address |
| Refresh | 60 per 5 minutes per address |
| Commands | 120 per minute per user and PC |
| Enrolment | 20 per hour per address |

These are per-instance. The per-account lockout in `@wolf/auth` is shared through Postgres
and is what actually bounds credential guessing.

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
| POST | `/auth/login` | Email, password, device descriptor. Rate limited. No registration endpoint exists. A `publicKey`, when sent, must be an ECDSA P-256 SPKI, DER, base64url; anything else is a 400 `validation.failed` and creates no device. |
| POST | `/auth/refresh` | Rotates the refresh token. Requires the device id and, from a device that registered an identity key, `proof`: its signature and the time. What is signed is fixed by the device's kind: from `web` and `pwa` devices, the device id, this token's binding and the time (`webRefreshProofPayload`, `refreshTokenBinding`); from every other kind, the device id, this token and the time (`refreshProofPayload`). A missing or wrong proof, like a replayed token, revokes the family; a correct one by a clock more than five minutes off is a 400 `auth.device_clock` and revokes nothing. |
| POST | `/auth/logout` | 204 whether or not the token existed. Optional `reason` — `signed-out` or `device-key-lost` — is kept on the audit record. |
| POST | `/auth/reauthenticate` | Refreshes `auth_time` for high and critical actions. |
| GET | `/users/me` | Account, current device, and how long ago the password was proven. |

### Dashboard session broker

Not API routes: the web dashboard's own Next.js handlers (`apps/web/app/api/auth`), which hold the
refresh token in an httpOnly cookie so page JavaScript never sees it. All are POST and all reject a
request without the `x-wolf-csrf: 1` header before doing anything else.

| Path | Notes |
| --- | --- |
| `/api/auth/login` | Credentials, device name, and the browser's device `publicKey`. Without a P-256 key it is a 400 `WOLF-AUTH-WEBKEY` and the API is not called. Returns the access token, never the refresh token. |
| `/api/auth/refresh/binding` | `{ deviceId, binding, publicKey }` for the cookie's token: what the page signs next, and the key it must sign with (`null` for a sign-in made before keys were registered). |
| `/api/auth/refresh` | `{ binding, proof }`. A binding that is no longer the cookie's is a 409 `auth.refresh_superseded` and nothing is sent to the API. A malformed body is a 400 `WOLF-AUTH-PROOFBODY`. An empty body is forwarded unsigned, and the API applies its rule. Only a 401 from the API clears the cookie. |
| `/api/auth/logout` | Optional `reason`, forwarded to the API. Always clears the cookie. |

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

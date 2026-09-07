# WOLF — Engineering Rules

The product requirements document is the source of truth. This file distills the rules that
must hold for every change.

## Non-negotiable rules

1. Never ship a fake or mock implementation where a real one is required. If a capability
   cannot work under a Windows limitation, expose the limitation explicitly — never report
   success for an operation that did not happen.
2. Never silently downgrade security. No "temporary" auth bypasses, no disabled validation.
3. Never hard-code credentials, keys, or tokens. Use env vars + secret management.
4. Never bypass authorization for convenience, including in dev builds.
5. Never expose an unrestricted administrative HTTP endpoint.
6. Never write secrets, passwords, tokens, clipboard contents, or Windows credentials to logs.
7. Never persist transferred file contents in cloud storage by default.
8. Never store clipboard content in cloud history.
9. The privileged helper exposes a narrow, allow-listed, typed command surface — never
   arbitrary command execution. Generic terminal execution is a separate, explicitly
   authorized feature with its own capability grant.
10. Write tests alongside major functionality.
11. Update `docs/architecture` when structure changes.
12. Keep shared protocol types centralized in `packages/protocol` and `packages/shared-types`.
13. Prefer typed commands over arbitrary JSON execution.
14. Keep GCP-specific functionality behind adapters in a `cloud/` provider interface.
15. Preserve future AWS portability — business logic stays cloud-agnostic.

## Development workflow

Implement in vertical slices, never the whole product at once:

```
Requirement -> Architecture -> Types/schema -> Backend -> Windows agent -> Web -> Android
            -> Tests -> Security review -> Documentation
```

Keep a working build after every milestone.

## Definition of done

A feature is complete only when all of the following hold:

- backend implemented
- Windows behavior implemented
- web UI implemented
- Android UI implemented
- authorization implemented
- audit behavior implemented
- error handling implemented (Problem / Cause / Current state / Recommended action / Reference ID)
- tests implemented
- offline and reconnect behavior considered
- documentation updated
- no secrets exposed
- production logging implemented

## Conventions

- **Language/runtime:** TypeScript (ESM, NodeNext) for cloud services and web; C#/.NET for
  Windows; Kotlin for Android.
- **Package manager:** npm workspaces.
- **IDs:** ULID-style sortable identifiers (`packages/shared-types` → `WolfId`).
- **Errors:** every user-visible failure carries a stable `referenceId` (`WOLF-<AREA>-<HEX>`).
- **Risk:** every mutating command declares a `RiskLevel`; the API enforces the confirmation
  requirements for that level (see `packages/protocol`).
- **Audit:** every privileged or mutating action writes an audit record — never the payload
  secrets, only metadata and safe before/after values.
- **Time:** all timestamps are UTC ISO-8601 strings at API boundaries.

## Testing

- `npm test` runs unit tests via the Node built-in test runner.
- Security tests (authz, traversal, injection, replay) live beside the code they protect.

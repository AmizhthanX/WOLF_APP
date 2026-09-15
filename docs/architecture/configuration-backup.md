# Configuration backup and restore

The owner's configuration, in a file they keep, and back again.

## What is in a backup

| Section | Contents |
| --- | --- |
| `pcs` | Each enrolled PC's id, name, tags, favourite flag |
| `remoteDesktopProfiles` | Saved profiles: id, name, settings, default flag |
| `alertRules` | Each rule's id and definition |
| `automations` | Each automation's id and definition |

## What is never in one

- **Anything that grants access.** No password hash, token, device key, PC key, enrollment token or
  privileged grant, and no automation's recorded authority. The snapshot selects named columns, never
  `*`, so a column added later does not end up in files by accident. A test asserts none of these
  strings appear in a backup.
- **History.** No telemetry, audit, notifications, sessions, commands or automation runs.
- **PC identity.** A PC is its enrollment key; a file cannot recreate one.
- **Settings nothing reads yet.** `retention_settings` and PC groups have tables but no code that uses
  them; backing them up would imply they take effect.

Because nothing in it grants access, a backup is plaintext JSON. It is built on request and returned
to the browser; the cloud stores no copy. Taking one is audited with counts only.

## The file

```json
{ "format": "wolf.configuration", "version": 1, "createdAt": "…", "checksum": "<sha256>", "content": { … } }
```

The checksum is SHA-256 of the content serialized with sorted keys. It catches a damaged or
hand-edited file. It is **not a signature** — anyone can recompute it — and nothing relies on it being
one. Signing with a server key was rejected: rotating the key would invalidate every backup, and
disaster recovery is exactly when that bites.

## Restore

1. **Verify:** format, version (a newer format is refused as such), checksum, then every item against
   the schema it was saved with. A critical action in a doctored automation is refused here exactly as
   it would be from the API. A file that fails any step restores nothing.
2. **Preview:** what each chosen section will create, update, delete and skip, the warnings, and the
   risk level the restore needs.
3. **Authorize:** at least medium (a confirmation) because configuration is replaced wholesale. If the
   owner chooses to turn restored automations on, the level rises to the riskiest of them, and a
   high-risk restore needs a password within five minutes. Refusals are audited.
4. **Apply** in one transaction, with the plan recomputed inside it. If the account changed so that
   the restore would need more than was confirmed, it stops.

### Semantics

- Each chosen section **replaces** the account's: items in both are updated in place, keeping their
  ids — so an automation's run history and a rule's notifications stay attached — items only in the
  backup are created, items only on the account are deleted. Sections not chosen are untouched.
- **PCs** are only renamed, retagged and (un)favourited, and only if still enrolled. A name held by
  another PC, including a revoked one, is not taken; the PC keeps its name and the owner is told.
  Names go through a temporary value first, so a backup that swaps two names does not fail on the
  uniqueness constraint halfway.
- **Alert rules** about a PC that is not enrolled are not restored, rather than widened to every PC.
  A restored rule starts with no alert state.
- **Automations** lose targets that are not enrolled; one with no targets left, or triggered by a rule
  that will not exist, is not restored. They come back **turned off** unless the owner chose otherwise
  at restore. Their recorded authority is the restoring device and time; for one restored off it is
  inert, because turning it on re-authorizes it. Restoring only alert rules turns off existing
  automations waiting for a rule the restore removes.
- An id that belongs to another account aborts the whole restore.

The audit record of a restore holds sections, counts and warning codes — never names, rules or
actions from the file.

## Clients

The web dashboard downloads the file through the browser. The Android app saves it through the system
document picker and restores from a file picked the same way, with no storage permission; it checks only
size and format before sending and leaves verification to the server. See
[the Android client](android.md#configuration-backup).

## Not covered

- Agent settings stored on the PC itself (its local options and store) stay on the PC.
- Scheduled automatic backups: a backup the cloud made on its own would have to be stored by the
  cloud, which is what this design avoids.

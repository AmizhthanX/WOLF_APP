# The privileged helper

## What it is for

Some things WOLF needs to do require administrative rights: reading a drive's SMART data,
managing devices, capturing the secure desktop, and eventually authenticating a remote
unlock. The agent already runs as `LocalSystem`, so it *could* do all of them itself.

It does not, and the reason is worth being precise about.

**This is a boundary of surface, not of privilege.** Both processes run as `LocalSystem`. The
helper cannot do anything the agent could not have done, and nothing here stops an attacker
who is already SYSTEM and can replace a binary. What it does is keep the process holding the
network connection away from raw device handles and, later, a credential provider — so a bug
in the agent's message parsing turns into *at most* the operations on an allow-list, rather
than into arbitrary privileged action.

That distinction is the PRD's rule 9 read literally: a narrow, allow-listed, typed command
surface, never arbitrary execution. There is no "run this" operation and there is not going
to be one.

The same rule says what to do with the thing that genuinely *is* arbitrary execution: make it
a separate feature with its own capability grant. That is [the terminal](terminal.md), and it
does not go through this helper at all — its shell runs as the signed-in user, with no more
rights than the person sitting at the machine. An elevated terminal would need this helper,
which is why it is not built yet rather than quietly approximated.

```
Wolf.Agent (LocalSystem)                  Wolf.Agent.Helper (LocalSystem)
┌────────────────────────────┐            ┌──────────────────────────────┐
│ cloud link (TLS)           │  named     │ allow-list:                  │
│ telemetry, processes       │◄──pipe────►│   helper.describe            │
│ command router             │  ACL'd     │   disk.smart-health          │
│ session host supervision   │            │   device.list                │
│                            │            │   device.set-enabled         │
│                            │            │                              │
│                            │            │ no network, no configuration │
└────────────────────────────┘            └──────────────────────────────┘
```

The helper holds no network connection and reads no configuration file. Everything it will
ever do is compiled into it.

## Three guards, answering three questions

| Guard | Question | What it stops |
| --- | --- | --- |
| Pipe ACL | Who may connect? | Anyone but SYSTEM and Administrators. A standard account cannot open the pipe at all |
| Caller verification | Which program is connecting? | Another SYSTEM process driving the helper. The client's process id comes from the pipe, not from the client, and its image path must be the agent beside the helper |
| Nonce and sequence | Is this request fresh? | A captured request being replayed, on this connection or a later one |

The nonce is generated per connection and never reused. The sequence must strictly increase
within a connection, and a **refused** request does not advance it — otherwise anything that
could inject one malformed message would lock the real agent out of its own channel for the
rest of the connection.

A caller that fails verification is disconnected without being told why. A probe learns only
that the door closed.

## What it does today

Disk health, device management, and one operation that describes the helper itself.

### Devices, and the things WOLF will not do to them

Listing hardware is read-only and needs nothing special. Turning a device off or on needs
SetupAPI and administrative rights, and is the most dangerous thing WOLF does short of
destroying data — disable the wrong device on a machine nobody is sitting at and there may be
no way to put it back.

Three layers, doing three different jobs:

1. **The cloud classifies risk.** Enabling a device is `medium`. Disabling one is `critical`
   — confirmation, re-authentication, and a single-use privileged grant. The asymmetry is the
   point: enabling gives function back and can be undone by disabling again.
2. **The helper refuses outright** the devices whose loss it could not undo remotely.
   A confirmation dialog asks the operator to accept a risk; it is the wrong tool when
   accepting it removes their ability to do anything about it.
3. **The name is checked before acting**, the same way terminating a process checks the name
   against the pid. Instance ids are stable, but a dashboard can be minutes out of date.

| Refused | Because |
| --- | --- |
| A connected network adapter | It could be the link WOLF is managing this PC over, and nothing could turn it back on remotely |
| Any storage device or controller | It can stop the PC booting. WOLF does not try to work out which controller carries the system volume — treating all of it as boot-critical costs the ability to disable a spare disk, which is a much smaller loss than a machine that does not come back |
| Display adapters | Disabling one ends the session WOLF captures, so the screen could not be used to put it back |
| Windows' own system devices | Processors, buses, firmware. Disabling one does not remove a feature, it removes the machine. `SecurityDevices` is here for the TPM: without it BitLocker may not unlock the volume at boot |

A *disconnected* network adapter is deliberately allowed. Refusing every network device would
make the class useless for what it is most often wanted for — switching off an adapter that
is misbehaving — and an idle one can be re-enabled over whatever link is actually carrying
WOLF.

Every refusal carries its reason. "WOLF will not do that" without one is the kind of answer
that gets worked around with a script rather than understood.

The rules live in `DeviceProtection`, apart from the code that talks to Windows and free of
I/O, so they can be checked against the device list of any machine rather than by disabling
hardware to see what happens. Running them against a real one immediately earned its keep: a
virtual camera came back classified `system-critical`, because `SoftwareDevice` had been put
in the system list. That would have been a confident, permanent refusal of something entirely
safe, and no synthetic fixture would have contained one.

### Disk health

`disk.smart-health` reads what the drives say about their own health. It is a good first
thing to put through the helper because it is entirely read-only: a mistake in the plumbing
cannot damage anything, while still needing the elevation that is the whole point.

**`unknown` is a real answer and a common one.** A USB enclosure that does not pass SMART
through, a RAID member behind a controller, a virtual disk in a VM — none of them will
answer. Reporting "healthy" because nothing said otherwise would be inventing reassurance
about somebody's data, so the status is `unknown` and the summary says which of those it is.

The verdict is ordered deliberately. An attribute at or below its vendor threshold is the
drive itself saying it is going, and that outranks Windows' own summary status, which is
coarse and has been known to stay "OK" while attributes are already failing. Wear that has
not yet crossed a threshold is a warning, because it is the thing somebody wants notice of
rather than a surprise.

Only the handful of SMART attributes with universally agreed meanings are named. There are
hundreds of vendor-specific ids and no authority on them; a confident label on a number that
means something else is worse than no label, so the rest are reported by id.

## Reading it needs elevation, and so does testing it

`MSStorageDriver_FailurePredictData` is refused to a standard user, and so is the helper's
own pipe. That has a consequence for the tests, and it is worth stating rather than working
around:

- The **decisions** the helper makes about a request — the allow-list, the nonce, the
  sequence, the version — live in `HelperRequestGuard`, which has no I/O and is tested
  directly. If they lived inside the pipe loop they could only be tested by an elevated run
  that most people will never do.
- The **decoding** of a drive's attribute table is a pure function over bytes, tested against
  buffers built to the ATA layout. The failing cases — an attribute past its threshold, a raw
  value that needs all six bytes — are exactly the ones a healthy development machine will
  never produce, so capturing a real drive would not have covered them.
- The **channel** tests — describe, caller verification, a real SMART read — state that they
  need elevation and skip without it, rather than passing on nothing.
- That an unelevated process is **refused the pipe** is itself asserted, and passes precisely
  because the ordinary developer session is not elevated.

## Adding an operation

1. Name it in `HelperProtocol.Operations` and in `IsAllowed`. Both, deliberately: the
   allow-list is the security property of this process and adding to it should be a visible
   act.
2. Implement it in `HelperServer.Perform`. A name on the list with no implementation returns
   `not-implemented` rather than a successful empty answer.
3. Add the command to `packages/protocol`, with its risk level. Risk drives whether a
   privileged grant is required — elevation and danger are different questions, and a
   read-only health check does not need a single-use critical grant to justify itself.
4. Route it from an agent command handler. The handler translates a command into one helper
   operation and its answer back; it does not do privileged work itself.

## What does *not* belong here

Remote lock, which was refused for a while with "install the privileged helper". That was
wrong, and the correction is the useful part: locking the console session needs a process
*inside* the interactive session, not more privilege. The agent service is already
`LocalSystem` and still cannot do it, because `LockWorkStation` affects only the caller's own
session and a service's is session 0.

The session host is already running in the interactive session for screen capture, so it is
what carries out the lock — over one service-to-host message that expects an answer,
correlated by request id and bounded by a timeout. The helper is not involved.

The general rule this suggests: something being *refused* is not evidence that it needs
elevation. Session isolation and privilege are different walls, and putting an operation
behind the wrong one buys a privileged code path that did not need to exist.

## What is not built yet

- **Device management** — enabling and disabling hardware.
- **Secure-desktop capture** for the lock and sign-in screens. Needs a component in the
  Winlogon desktop, and is the point at which remote unlock becomes possible.
  `secureDesktopCaptureAvailable` stays `false` until it exists.
- **Remote unlock** using a dedicated WOLF credential, never the Windows password.

The capability handshake answers `privilegedHelperAvailable` by opening the pipe and closing
it again, at call time rather than from a cached assumption: the helper is a separate service
and can be stopped, and a PC that claims it can do privileged work when it cannot is one the
cloud will offer operations that then fail.

# The file manager

Browsing a PC's disks, and moving files off them and onto them.

## Everything rides the data channel — contents *and* names

The rule about contents is written down: WOLF must never persist transferred file contents.
A directory listing is not innocent either. `Divorce settlement.docx`, `resignation draft.docx`,
`2019 tax return.pdf` — each is a fact about somebody whether or not the file is ever opened.

So the whole feature goes between the browser and the PC and nowhere else:

```
browser ──data channel──▶ session host ──▶ the signed-in user's own disks
        ◀──────────────────────────────────
                  (the relay never sees a path or a byte)
```

The cloud decides *who may browse and transfer*, and records that a transfer happened. It never
learns what was in it or what it was called. A server that never receives a listing cannot
store one, log one, or be compelled to produce one — a stronger promise than a retention
policy, because it does not depend on anybody honouring it later.

The same reasoning applies to the agent's own log. Nothing in `FileChannel` writes a path,
including in refusals — the easiest place to leak one by accident. What it logs is the
operation, the outcome, and how many bytes. There are tests that put a tellingly-named file
through a listing, a read and a refusal and assert the name appears nowhere.

**The cost, stated:** the data channel belongs to a stream, so the file manager needs a
running stream. Browsing a PC nobody is watching would need a second channel.

## Three permissions, none implied by another

| | What it grants |
| --- | --- |
| `file-transfer` capability | This session may reach the PC's files at all |
| `file-operations` lease | This session has them *right now*, exclusively |
| Windows' own ACLs | What the signed-in user could open sitting at the machine |

The third is the one doing most of the work, and it is free: **the session host runs as the
signed-in user**, so a folder they cannot read is a folder WOLF cannot read, with no extra code
and nothing to get wrong. An operator does not gain access by coming in remotely.

Not even the terminal capability implies file transfer, and there is an end-to-end test that
says so. A terminal could copy a file out by other means — which is exactly why the capability
is about intent and audit rather than about what is theoretically reachable.

The lease is exclusive for a plain reason: two sessions writing into one destination produce a
file that is neither of the things either of them sent. Losing it abandons every transfer in
flight and deletes the part files.

## The path gate

Two halves, and the split is not cosmetic.

**`FilePathGuard.Check`** is arithmetic on a string and is tested exhaustively. Every refusal
is a shape that means something other than it looks like, and each is a real Windows behaviour
rather than a hypothetical:

- `..` and `.` segments — refused rather than collapsed, so the path WOLF checked and the path
  WOLF opens are never produced by two different pieces of code
- `\\?\` and `\\.\` — prefixes that exist precisely to bypass the normalisation every other
  rule relies on
- reserved device names (`CON`, `NUL`, `COM1`…) at any depth and with any extension —
  `C:\temp\CON.txt` is not a file, it is the console device
- alternate data streams — `notes.txt:secret` is not `notes.txt`
- trailing dots and spaces — Windows strips them silently, making `evil.exe.` and `evil.exe`
  the same file and different strings
- wildcards, control characters, relative paths, anything not on a drive letter

**`FilePathGuard.Resolve`** touches the disk, because whether a path is a junction pointing
somewhere else is not a question a string can answer. A reparse point is followed and its
target goes back through the whole gate — a link is only ever as acceptable as the place it
points.

Passing the first is never authorisation to act. It is permission to ask the second.

This mirrors `packages/validation/src/windows-path.ts`, which guards the same paths on the
command path. Two implementations of one rule set is a real cost; the alternative — letting the
agent trust a check the cloud performed — is worse here than anywhere, because file traffic
never goes through the cloud at all.

### Network paths are refused, deliberately

`\\fileserver\finance` is reported as unsupported rather than browsed. The session host holds
the signed-in user's credentials, so reaching a share from a remote session would let WOLF be
used to touch machines the operator was never granted — with that user's rights, and none of
WOLF's audit trail on the far end.

This is stricter than the shared validator, which accepts UNC for other purposes. It is an
additional restriction on this feature, not a contradiction of that one.

## Chunked, checksummed, resumable

A transfer is a sequence of offsets, not a stream. That is what makes it resumable across a
reconnect — and reconnects are the normal case, because the thing carrying these bytes is a
data channel on somebody's home internet.

Every chunk carries its own SHA-256. Not for security — the channel is already DTLS-encrypted
and authenticated — but because a file that arrives subtly wrong is worse than one that fails:
nobody notices until they try to use it, and by then the source may be gone. Both ends check:
the browser verifies chunks it reads, and the agent verifies chunks it is sent **before**
anything reaches the disk, because a part file with a corrupt middle is indistinguishable from
a good one until the whole transfer fails at the end.

### Uploads land in a part file

Chunks accumulate in `<destination>.wolfpart` and are renamed into place on the last one, after
the declared size is checked.

The rename is the moment the file exists. Writing straight to the destination would mean a
half-finished transfer looks exactly like a finished one, and somebody double-clicking a
40%-complete installer is a worse outcome than a transfer they have to start again. The part
file is also the record of how far a transfer got, which is what a resume reads.

Everything expensive to get wrong is decided when the transfer *starts*, not when it finishes:
whether something is already there, whether the drive has room, whether the destination is
somewhere WOLF writes at all. An operator who finds out they overwrote a file after sending
3 GB has been told too late to do anything about it.

Overwriting is off unless the transfer asks for it, and writing into Windows' own folders is
refused outright rather than confirmed — a confirmation dialog is the wrong tool for something
whose failure mode is an unbootable machine.

## Bounds

| | |
| --- | --- |
| Chunk | 64 KB — sized for the data channel's message limit, not for throughput |
| Directory listing | 2000 entries, and it *says* when it truncated |
| Transfers per stream | 4 — each holds an open handle and a growing part file |
| One transfer | 8 GB |

A folder that shows 2000 of its 40000 files with no indication is one an operator concludes
does not contain what they are looking for. Saying so is the difference.

## What is not built

- **Delete, rename, move, and new folders.** They are mutations with real blast radius, they
  belong on the command path where risk levels and confirmations live, and putting them on
  this channel would route them around the machinery that exists to make them accountable.
- **Search.** A recursive search across somebody's disks is a different feature with different
  costs, and the obvious naive version is a session host reading every file on the machine.
- **Directory transfers.** One file at a time. Recursion turns "did that work" into a report
  rather than an answer, and the resume story for a half-copied tree is its own design.
- **Browsing without a stream.** See above — the data channel belongs to one.

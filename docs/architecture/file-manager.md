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
file that is neither of the things either of them sent. Losing it puts every transfer in flight
aside — see [Interrupted is not stopped](#interrupted-is-not-stopped).

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

### Interrupted is not stopped

The stream ending and the file lease lapsing are interruptions. Pressing Stop — `file.cancel` —
is a decision. They used to be treated the same, which meant every part file was deleted the
moment the data channel dropped, and every interrupted upload started again from nothing over
the next stream. What happens now:

- **An interruption keeps the part file for 30 minutes** (`PARTIAL_UPLOAD_KEPT_SECONDS`). The
  session host records it, with its expiry, in `%LOCALAPPDATA%\WOLF\session-host\partial-uploads.json`
  — the signed-in user's own profile, the same user who can already see the part file — so a
  session host that restarts still clears up after the one before. Nothing is logged but a count.
- **Resuming claims it back.** A new stream sends `file.stat`, reads `partialBytes`, and writes
  from there under a new transfer id. The session host re-reads the part already on disk into
  its checksum, so the whole-file digest it reports covers the whole file, not just this stream's
  share of it.
- **Expiry deletes it.** Every new stream, every lease grant, and a five-minute timer sweep
  records past their time. The sweep deletes files ending `.wolfpart` and nothing else, whatever
  a record says.
- **Stopping and refusals still delete at once.**

A resume joins bytes one stream wrote to bytes another wrote, so it is where a wrong file is
most likely to be assembled — a part file something else touched, a source that changed. So the
final chunk may carry `fileSha256`, the client's own checksum of the whole file, and **a file
that does not match is refused `corrupt` and not put in place**. Checking after the rename would
find the problem with the wrong file already where the owner expects the right one. Both clients
send it: Android always (it checksums as it reads), the web for files up to 512 MB (the browser's
digest is not incremental; above that the tab says the file was not compared end to end).

A download needs nothing from the PC to resume: what arrived stays with the client, which checks
the file on the PC still has the same size and modification time before asking for the rest,
and starts again rather than join the second half of a different file to the first half of this
one.

A finding while building this: resuming across streams could never have worked. The part file
was opened for writing with no sharing and then opened a second time to re-hash its prefix,
which Windows refused — so a resumed upload was refused `failed`. The tests only ever resumed
within a stream from offset zero. The prefix is now read through the same handle, and
`A_resumed_upload_produces_the_same_file_as_an_uninterrupted_one` resumes across two channels.

## Bounds

| | |
| --- | --- |
| Chunk | 64 KB — sized for the data channel's message limit, not for throughput |
| Directory listing | 2000 entries, and it *says* when it truncated |
| Transfers per stream | 4 — each holds an open handle and a growing part file |
| One transfer | 8 GB |

A folder that shows 2000 of its 40000 files with no indication is one an operator concludes
does not contain what they are looking for. Saying so is the difference.

## Clients

The web dashboard assembles a download in the tab and hands it to the browser's save dialog. The Android
app puts it together in its own cache and copies it into a document the owner picks only once it is whole;
it sends from a document picked the same way, and compares the PC's whole-file checksum with its own. See
[the Android client](android.md#files).

Both offer **Resume** and **Discard** for a transfer the connection interrupted, once the new stream holds
file access. The record is kept in memory only — in the tab (`lib/file-transfer.ts`), or in the app process
per PC (`InterruptedTransfers`) — because it holds a path on the PC, and nothing about a PC's files is
written down on the client. While one is waiting, starting another transfer is disabled rather than
silently dropping it. A resume is offered only for the connection ending; a lease revoked while the stream
stays up ends the transfer as a refusal, and the PC clears its part file when its time is up.

Proven live on Android (`LiveResumeTransferTest`): a 400 KB upload whose stream was stopped after two
chunks resumed from 131072 bytes over a new stream, and a download stopped the same way carried on over a
third; both compared byte for byte. The web client's resume is tested against a fake PC, not yet live.

Both learned the same thing about the channel: the file lease can be granted while the PC's data channel
is still opening. A client that sends the first listing the moment access is granted can find the channel
not ready; the Android client holds requests until the channel opens, bounded by their timeout.

## What is not built

- **Delete, rename, move, and new folders.** They are mutations with real blast radius, they
  belong on the command path where risk levels and confirmations live, and putting them on
  this channel would route them around the machinery that exists to make them accountable.
- **Search.** A recursive search across somebody's disks is a different feature with different
  costs, and the obvious naive version is a session host reading every file on the machine.
- **Directory transfers.** One file at a time. Recursion turns "did that work" into a report
  rather than an answer, and the resume story for a half-copied tree is its own design.
- **Browsing without a stream.** See above — the data channel belongs to one.

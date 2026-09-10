# The terminal

This is the one feature in WOLF that is arbitrary command execution, and it is built as its
own thing for exactly that reason.

Everything else the agent does is a typed, allow-listed operation — terminate *this* pid,
disable *that* device, read disk health. That narrowness is the security property: it bounds
what a bug in the network-facing process can turn into. A terminal has no such bound by
definition. So rather than pretending otherwise, the design says plainly what it is and
surrounds it with the things that make it accountable.

Rule 9 of the engineering rules puts it directly: the privileged helper never executes
arbitrary commands, and *generic terminal execution is a separate, explicitly authorized
feature with its own capability grant.* This is that feature.

## Three separate permissions

| | What it grants | Who decides |
| --- | --- | --- |
| `terminal` capability | This session may have a shell at all | The cloud, at session start |
| `terminal` lease | This session has the shell *right now* | The relay, arbitrating between sessions |
| `terminal-admin` capability | An elevated shell | **Not built.** Asked for, refused as a limitation |

None of these is implied by any other capability. A session with `screen` and `input` can
already type into whatever window is on the screen — and still cannot open a shell, because
opening one is a different act with a different audit trail and a different blast radius.
There is an end-to-end test that asserts exactly this, because it is the kind of thing that
quietly stops being true.

The lease is arbitrated the same way keyboard control is, and for a sharper reason: two
operators typing into one shell produce a command line neither of them wrote, and it runs.

## Where the bytes go

**On the WebRTC data channel, never through the cloud.**

```
browser ──data channel──▶ session host ──▶ ConPTY ──▶ cmd.exe / powershell.exe
        ◀──────────────────────────────────────────
                  (the relay never sees any of this)
```

The cloud decides *who may open a terminal* and records that one was opened. It never sees a
byte of what was typed or printed.

That is the same routing as input and the clipboard, with a stronger justification than
either. Terminal output routinely contains secrets nobody meant to disclose: a connection
string echoed by a script, a token in an environment dump, a password typed into a prompt
that was not hiding it. Content that never reaches a server cannot be retained by one,
accidentally logged by one, or subpoenaed from one — and that is the only way to make the
promise mean anything.

**The cost of that choice, stated rather than hidden:** the data channel belongs to a stream,
so a terminal needs a running stream. Opening a shell on a PC nobody is watching would need
a second channel, which is a different feature and is not built.

## What runs on the PC

A **pseudo console** — the ConPTY API, the same mechanism Windows Terminal and VS Code use.
The alternative, redirecting `stdout` of `cmd.exe` through a pipe, produces a shell that knows
it is not on a terminal: no prompt colouring, no line editing, no cursor movement, and
programs behaving differently from how they would on the machine itself. An operator
troubleshooting a PC needs the shell that PC actually has.

It runs **in the session host**, as the signed-in user. Not as SYSTEM, not elevated, and not
through the privileged helper. A remote shell that silently had more rights than the person
sitting at the machine would be a different product.

### Shells are named, never pathed

`cmd`, `powershell`, `pwsh`. The agent resolves each to a fixed executable it finds itself.

A caller that could supply a path would turn "give me a shell" into "run this program as the
signed-in user" — a materially larger grant than the capability describes, and one that
happens *before* any shell exists to be audited as one. PowerShell 7 is an optional install,
so a PC without it says so rather than failing to start a process nobody can see.

### The detail that decides whether any of it works

The shell is started with `STARTF_USESTDHANDLES` and **all three standard handles null**.

A console child with no standard handles of its own falls back to `CONOUT$` and `CONIN$` —
its console, which is the pseudo console. Left unset, it inherits the *parent's* standard
handles instead, and those are whatever the agent was started with: pipes to a service host,
or nothing at all. The shell then attaches to the pseudo console correctly, reports the right
size from `mode con`, and writes every byte of its output somewhere the operator will never
see.

That is exactly what happened the first time this ran, and it is invisible from a terminal:
run the same code with a console attached and the output goes to the console, so it looks
like it works. It was caught by a test that asserted a real shell echoed a real marker, which
is the reason that test exists rather than a mock.

### Two threads, watching two different things

A shell ending and its output ending are not the same event, and conflating them loses the
last thing it printed — which, for somebody debugging a failing script, is the only line that
mattered.

- The **pump** reads the output pipe until end-of-file.
- The **watcher** waits for the process, then closes the pseudo console.

Closing the console is what makes conhost flush what it still holds and let go, so the pump
drains and *then* reports the exit. Without the watcher there is no end-of-file at all:
conhost outlives its client and keeps the pipe open, so a shell that exited on its own would
never be reported as having exited. Also caught by a test, which hung for twenty seconds
until it was fixed.

## The gate

`TerminalChannel` sits where `InputChannel` does and does the same job. Terminal traffic
arrives on the data channel straight from the browser, so **nothing upstream has looked at
these bytes**. Three checks, in this order:

1. **Was this session granted a terminal at all?** Checked before anything else is parsed.
2. **Does it hold the lease, and has it expired?** Enforced on the PC as well as in the
   cloud, because a cloud that becomes unreachable must not leave a shell open to whoever
   held it last.
3. **Is the message within its bounds?** Sizes, geometry, how many shells one stream may have
   at once. Each shell is a process on somebody's machine, and opening them without bound is
   a denial of service against the PC the operator is trying to fix.

**Losing the lease closes every shell the stream had open.** That is the difference between a
lease and a suggestion: a shell left running after the lease lapsed would be inherited by
whoever takes it next, half-typed command and all.

**Elevation is refused, not approximated.** `terminal-admin` is not built, and asking for an
elevated shell is answered as an unsupported limitation. Handing back an unelevated shell
that claims to be elevated would fail on the first thing it was opened to do, in a way that
looks like a permissions problem on the machine rather than a missing feature in WOLF.

## What is logged

Which shell, which stream, its process id, how many bytes it produced, and how it ended.

**Never a byte of what was typed or printed**, including in refusals — a refusal that quoted
the message it refused would put a half-typed password in the log of every PC that ever
refused one. There are tests that assert a distinctive string echoed through a real shell
does not appear anywhere in the log.

The process id is reported to the client on purpose: an operator should be able to find the
shell in the process list, so an audit trail in WOLF lines up with one on the machine itself.

## The browser side

There is no terminal emulator here. `xterm.js` exists because a full one is not a weekend's
work, and adding it is a decision rather than an oversight.

What WOLF has instead is a **scrollback renderer**: it keeps a growing list of lines and
applies the sequences that make ordinary command output correct — colour, carriage returns,
backspace, erase-to-end-of-line, clear screen. That covers what people actually do in a remote
shell: run a command, read what it printed, run another.

**What it cannot do it reports rather than approximates.** Anything that paints a full-screen
interface — an editor, a pager, a progress display that redraws in place — needs a grid this
renderer does not have. When it sees a sequence that addresses one, it says so above the
output, so an operator reading a partial screen knows it is partial rather than concluding
the machine is misbehaving.

Ctrl+C reaches the shell as `0x03`, because the first thing anybody does to a runaway command
is interrupt it. Ctrl+Shift+anything and the platform modifier are deliberately left to the
browser: a terminal that swallowed the operator's own copy and paste would be worse than one
that misses a keystroke.

## What is not built

- **`terminal-admin`.** An elevated shell needs a token the session host does not have, which
  makes it privileged-helper work and a slice of its own.
- **Opening a shell without a stream.** The data channel belongs to a stream; a terminal-only
  connection is a second channel and a second negotiation.
- **A real terminal grid.** See above — stated in the UI rather than approximated.
- **Terminal output in the audit trail.** Deliberately, and permanently: the whole routing
  exists so that no server ever holds it.

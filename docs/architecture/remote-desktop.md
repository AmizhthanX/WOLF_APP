# Remote desktop architecture

## The constraint everything else follows from

The WOLF agent runs as a Windows Service, in **session 0**. Session 0 has no desktop. It
cannot see the user's screen and it cannot inject input into their session. This is not a
permissions problem that elevation solves — it is the session isolation boundary Windows
has enforced since Vista, and it exists precisely to stop services from driving user
desktops.

Concretely, from session 0:

| Operation | Works? |
| --- | --- |
| `Windows.Graphics.Capture` of the user's desktop | No |
| `SendInput` into the user's session | No |
| WASAPI loopback capture of the user's audio | No |
| Reading the user's clipboard | No |
| `LockWorkStation` | No |
| Shutdown, restart, sign-out, sleep | Yes |
| Reading process, disk, network, and memory counters | Yes |

Milestone 1 lived entirely in the right-hand column, which is why the agent has been a
single service until now. Remote desktop lives entirely in the left-hand column.

## The answer: a session host

WOLF gains a second process, **`Wolf.Agent.SessionHost`**, which runs *inside* the active
interactive session. The service launches it there and supervises it.

```
Session 0 (services)                    Session 1+ (the signed-in user)
┌──────────────────────────┐            ┌────────────────────────────────┐
│ Wolf.Agent (service)     │            │ Wolf.Agent.SessionHost         │
│                          │  named     │                                │
│  cloud link              │◄──pipe────►│  Windows.Graphics.Capture      │
│  telemetry               │  ACL'd     │  D3D11 → hardware H.264        │
│  processes, power        │            │  WebRTC peer (SIPSorcery)      │
│  supervises the host ────┼───launch──►│  SendInput                     │
│                          │            │  WASAPI loopback               │
└──────────────────────────┘            └────────────────────────────────┘
        │                                            │
        │ signaling (SDP/ICE) over the cloud link    │ media + input
        ▼                                            ▼
    WOLF cloud ◄────────── WebRTC (LAN / P2P / TURN) ──────────► browser
```

The service brokers **signaling only**. Media and input never pass through it, and never
pass through the cloud when a direct route exists.

### Why the media path bypasses the service

Two reasons, and the second is the important one:

1. Piping every frame across a named pipe between two processes costs a copy and latency
   for no benefit.
2. The service is the component with the most privilege. Keeping frame data and input
   events out of it means a bug in the capture or input path cannot be leveraged from
   inside a `LocalSystem` process.

### Supervision

The service owns the lifecycle because only it survives sign-out, fast user switching, and
the lock screen:

- On `WTS_SESSION_LOGON` / console connect, launch a host in the new session.
- On `WTS_SESSION_LOGOFF` / disconnect, the host dies with the session; the service reports
  the transition and the stream moves to a `LOGIN` or `LOCKED` state.
- If a host exits unexpectedly, restart it with backoff, and report `RECONNECTING` rather
  than pretending the stream is healthy.

The host is launched with the user's token via `WTSQueryUserToken` +
`CreateProcessAsUser`, so it runs **as the signed-in user**, not as `LocalSystem`. It gets
no more privilege than the person sitting at the machine.

## What the lock screen and sign-in screen actually cost

The secure desktop (`Winlogon`) is a separate desktop within the session, and a normal
user-session process cannot capture it or inject into it. Honest consequences:

| PC state | Stream | Input |
| --- | --- | --- |
| Desktop, user signed in | Full | Full |
| Locked | State reported as `LOCKED`; **no frames** | Refused |
| Sign-in screen | State reported as `LOGIN`; **no frames** | Refused |
| Restarting | `RESTARTING` | Refused |
| Signed out | `LOGIN` | Refused |

**How the state is known.** Not by inference any more. The session host runs inside the
session and asks Windows whether it may open the desktop that currently has the input. Being
refused is the answer: the secure desktop has it. That is a question put to Windows rather
than a symptom observed from outside, and it catches the two cases the old guess got wrong —
`LogonUI.exe` lingering for a moment after an unlock, and a UAC prompt raising the secure
desktop without starting it at all.

The one thing it cannot do is name the desktop it was refused. Windows does not tell an
unprivileged caller which desktop it just declined to open, so "something this process is not
allowed to see" is the honest limit, and telling a lock screen from a UAC prompt is left to a
component that can attach to it.

WOLF reports these states rather than sending a black frame that looks like a broken
stream. Capturing the secure desktop needs a process running *on* the Winlogon desktop as
`LocalSystem` — not the privileged helper, which is a separate service on a pipe and has no
desktop of its own. It is a second session host, launched by the service with a SYSTEM token
whose session id has been set to the console session, and `lpDesktop` naming
`winsta0\Winlogon` at creation, because there is no supported way to move a process between
desktops afterwards.

That is the same mechanism Windows' own accessibility and remote-assistance components use,
and it weakens nothing: the child has exactly the access SYSTEM already had, and nothing
running as the signed-in user gains anything.

### The secure-desktop host

A second session host, on its own channel, started only while the secure desktop has the
input and stopped when it does not. The policy is two lines: the user host reports which
desktop has the input, and that turns into a host on the secure one existing or not.

It is a separate supervisor rather than a mode of the existing one. The two hosts have
different lifetimes — the user host lives as long as the session, this one as long as the
lock screen — different tokens, different desktops, and different pipes. Folding them
together would produce one class with two of everything and a flag deciding which half is
real.

Three details that are decisions rather than incidentals:

- **It captures through Desktop Duplication, never Graphics Capture.** Graphics Capture works
  from a `GraphicsCaptureItem` for a monitor, and creating one needs a window station and
  desktop it can reach; the Winlogon desktop is neither. Duplication asks DXGI for the output
  the *calling process's desktop* is showing, which is the lock screen when the caller is
  sitting on it. This is reasoning, not an observation — see the caveat below.
- **Its pipe admits SYSTEM only.** The user host's pipe also admits the interactive user,
  which is right for a channel carrying that user's own screen. This one carries the lock
  screen, and the signed-in user has no business reaching it.
- **It is not kept running.** It holds a duplication of the display and runs as SYSTEM.
  Starting it costs a couple of seconds when the screen locks; the alternative is a SYSTEM
  process watching a desktop nobody is looking at for however long the PC sits unlocked.

`secureDesktopCaptureAvailable` now answers whether a host *could* be started here — the
agent is SYSTEM, there is a console session, the host is installed — asked at call time
rather than cached, because a PC that claims it can capture the lock screen and then cannot
is one the cloud will offer that and then fail.

### What has not run

**None of the secure-desktop path has ever executed.** It needs the agent installed as a
Windows service, so that it is SYSTEM and can duplicate a SYSTEM token into the console
session, and a machine whose screen is locked while somebody watches what happens. The
machine this was written on is neither, and the tests say which of the two they are waiting
for rather than passing on nothing.

What that means in practice, for whoever runs it first:

- Every failure carries a distinct code — `not-system`, `no-console-session`, `not-installed`,
  `duplicate-token`, `set-session`, `create-process`, `no-connection` — because those messages
  are the diagnostic. They name which of the three preconditions the implementation got wrong.
- The likeliest thing to be wrong is the capture API on that desktop. If Graphics Capture
  turns out to work there, this is a missed opportunity rather than a fault: the duplication
  path is the one whose fallback is already tested against real hardware.
- Frames from the secure host do not yet reach a running stream. The host captures; carrying
  those frames onto the peer connection the user host already holds is the next piece, and it
  reuses the resolution-change machinery that already exists for switching display.

This is the PRD's §14 requirement read literally: the system "must not falsely claim that
every Windows security boundary can be controlled identically to an ordinary desktop."

## Capture pipeline

```
Windows.Graphics.Capture (GraphicsCaptureItem for a display)
        │  Direct3D11CaptureFramePool, free-threaded
        ▼
  ID3D11Texture2D (BGRA, on the GPU)
        │  no CPU round trip when the encoder accepts D3D surfaces
        ▼
  Media Foundation H.264 encoder (hardware where present, software fallback)
        │
        ▼
  Encoded H.264 access units → RTP → WebRTC video track
```

Frames stay on the GPU from capture to encoder. The fallback path — when no hardware
encoder is present — copies to system memory and uses the Media Foundation software
encoder, which is slower and is *reported as such* in the stream stats rather than silently
degrading.

### Two ways to capture, and why the order is not a toss-up

1. `Windows.Graphics.Capture` (Windows 10 1903+). Handles DPI, HDR tone mapping, and
   occluded windows correctly, and does not require a compatible legacy driver.
2. Desktop Duplication (DXGI), for the builds that do not have it.

Both sit behind one interface, so everything above the capture — the colour converter, the
encoder, adaptation, the transport — cannot tell which is running. What the agent advertises
in the capability handshake is what it will actually use, including when that is `none`,
because a PC that says it cannot stream is better than one that offers to and then sends a
black screen.

Graphics Capture is preferred rather than merely listed first, and the two differences are
both things the operator would notice:

- **The pointer.** Graphics Capture composites it into the frame. Duplication hands back the
  desktop without it and offers the cursor separately as a shape to blend in — three bitmap
  formats, per frame. That is not done, so on the fallback the operator sees the desktop
  move and not the cursor. It is reported as an adjustment on the negotiation
  (`cursor`, requested `shown`, applied `hidden`), because somebody whose pointer has
  vanished will suspect their own machine or the network long before they suspect the
  capture API.
- **The indicator.** Windows draws a coloured border around a display being captured through
  Graphics Capture, which is how the person sitting at the PC knows. Duplication draws
  nothing, and `BorderShown` is false rather than assumed — claiming an indicator is showing
  when it is not would be a lie to the operator about somebody else's privacy.

Duplication also has a tighter contract: exactly one frame may be outstanding, and the next
`AcquireNextFrame` is refused until it is released. The lease returns it, so a dropped lease
stops capture in one frame rather than two — and losing access, which happens for ordinary
reasons like a mode change or the secure desktop appearing, is answered by duplicating the
output again rather than by ending the stream.

The choice is made per display and re-made when the display is switched, so a stream never
silently changes API — and with it, silently gains or loses a cursor — halfway through.

`WOLF_FORCE_DESKTOP_DUPLICATION=1` forces the fallback. It is there for the one case the
automatic choice cannot detect: a machine where Graphics Capture reports itself supported,
starts without error, and then produces nothing usable, which some virtual display drivers
do. It is opt-in, logged as a warning every time it takes effect, and answered by the
capability handshake, so the cloud is never promising a cursor that will not arrive.

### Three things the pipeline has to get right before it produces a single frame

**DPI awareness, set before any display API is touched.** A DPI-unaware process is told a
scaled monitor is smaller than it is. On a 2560×1440 display at 125% scaling the process
sees 2048×1152, and the reported resolution, the captured frame, and the pointer
coordinates become three different things. `Wolf.Agent.SessionHost` sets per-monitor
awareness V2 in `Main`, before the display enumerator runs.

**The Media Foundation platform, started explicitly.** `MFStartup` is not implied by
creating a transform. Without it every `ProcessInput` fails with
`MF_E_UNSUPPORTED_D3D_TYPE` — an error that points at the texture and is really about the
platform, and which cost a round of investigation into surface formats that were all
correct. It is reference-counted here, because the encoder probe and a running encoder can
overlap and the probe used to shut the platform down underneath one.

**Codec properties go through `ICodecAPI`, never the transform's attribute store.**
`IMFTransform.Attributes.Set` accepts any GUID and returns success, so setting
`CODECAPI_AVEncVideoForceKeyFrame` there compiles, runs, reports success, and does nothing
to the bitstream. The failure is invisible: a client joining mid-stream simply waits for
the encoder's own key frame interval, which usually arrives soon enough to look like it
worked. Measured on an RTX 3060, the request now produces a key frame **46 ms later, on the
second frame**; through the attribute store it produced nothing at all.

### Capability probes measure rather than ask

`ICodecAPI` exposes `IsSupported` and `IsModifiable`, and the second one cannot be trusted.
NVIDIA's H.264 MFT reports `CODECAPI_AVEncCommonMeanBitRate` as *not modifiable*, then
accepts a change to it and reports the new value back. Believing the encoder's own
description would switch adaptive bitrate off on hardware where it works.

So live bitrate support is determined by performing it: once streaming has begun, the
encoder is set to the bitrate it already has and the value is read back. Writing the
current value changes nothing about the stream, which is what makes it usable as a probe.
Forced key frames come from `IsSupported`, which is accurate for that property and verified
by a test that asserts the key frame arrives within a few frames of the request — a
one-second window would have been satisfied by the regular key frame interval.

### Pacing

Capture and encode run on one dedicated `AboveNormal` thread rather than the thread pool:
this is a continuous real-time job, and borrowing pool threads for it would both starve
other work and subject the frame cadence to pool scheduling.

A 165 Hz display hands over frames far faster than any stream needs, so the pipeline paces
itself to the requested frame rate and does not collect the frames in between. Measured at
2560×1440: 30 fps sustained, 0 dropped, **0.47 ms per frame of encode time** against a
33 ms budget.

## Codec negotiation

The PRD is explicit that no codec may be assumed. The agent enumerates Media Foundation
transforms at startup and reports what it *actually has*:

```
hardwareVideoEncoders: ["h264-qsv", "h265-qsv"]     ← what this machine can do
preferredVideoCodec:   "h264"                        ← the best mutually supported choice
```

The browser reports what it can decode through WebRTC's own capability negotiation. The
intersection decides, in this order:

1. AV1, then H.265, where both sides have hardware for it
2. H.264 — universally supported, the safe default
3. VP8 — last resort, software both ends

H.264 is the default rather than the fallback of last resort because every browser and
every Windows GPU of the last decade handles it in hardware, and a remote desktop that is
merely *good* everywhere beats one that is excellent on one machine and broken on the next.

## Transport

The session host runs a real WebRTC peer connection (SIPSorcery), and the host is the
**offerer**. It is the side that knows which encoder this machine has and at what profile
and level it is actually producing pictures, so an offer from here describes reality; an
offer from the browser would describe a hope.

### The SDP describes the encoder, not a guess

`profile-level-id` is read out of the encoder's own sequence parameter set rather than
written as a constant. A browser takes that field at its word: advertise constrained
baseline 3.1 (`42e01f`, the value most examples use) while sending high-profile 1440p and
Chrome either refuses the format or accepts it and renders nothing. On the development
machine the true value is `640032` — High profile, level 5.0 — and the first three bytes
after the SPS NAL header are exactly the three the field encodes, so the honest value is a
transcription rather than a calculation.

### Ordering, and what gets dropped

Two ordering rules exist because getting either wrong produces a stream that looks broken
for reasons the logs do not explain:

- **Candidates wait for the offer.** ICE gathering on a machine with several interfaces
  regularly finishes inside the same call that starts it, so candidates — and `ice.complete`
  — can be ready before the offer has been sent. They are held and released immediately
  after it, because a client has nowhere to put candidates for a session it has not been
  offered yet.
- **Frames before connect are dropped, not queued.** A queue would hand the client a burst
  of stale pictures the moment it connected, and the newest frame is the only one worth
  having.

The capture pipeline does not start when the stream is negotiated. It starts when the peer
reaches `connected`, because a pipeline running before there is anywhere to send pictures is
a process reading somebody's screen for no reason — and it stops on disposal, which a test
asserts by watching for frames that must not arrive.

A key frame is requested the moment the peer connects. A client that has just joined has no
reference picture, so without one it sees nothing until the encoder's own interval comes
round.

### What it costs, measured

Numbers from the performance suite on the development machine — an RTX 3060 driving a
2560×1440 display. They are measurements, not targets; the budgets the suite asserts are
looser, because a test that passes only on the machine it was written on gets deleted the
first time somebody runs it on a laptop.

| | Measured | Budget |
| --- | --- | --- |
| Request to first picture | 751 ms | 2000 ms |
| Encode, mean | 0.55 ms | 8 ms |
| Encode, 99th percentile | 4.64 ms | 16 ms |
| Sustained frame rate | 55 fps, 0 dropped | 20 fps |
| Freeze across a resolution change | 15 ms | 500 ms |
| Input handling | 1222 batches/s | 500 batches/s |

The tail is budgeted separately from the mean on purpose. A stream that encodes in half a
millisecond and then takes forty once a second feels broken while its average looks
excellent, so the ninety-ninth percentile is what decides whether it is smooth.

### Recovering from loss

A client that loses part of a key frame cannot decode anything until it gets another one. It
says so with a Picture Loss Indication, and the host answers by asking the encoder for a key
frame immediately — without which the viewer sits on a frozen or smeared picture until the
encoder's own interval comes round, which is seconds of a stream that looks broken and is
trivially recoverable.

A browser only sends the feedback the offer said it may send, and SIPSorcery advertises
`transport-cc` and nothing else. The line is added to the offer text on its way out; the
local description is left alone, because `rtcp-fb` describes what the *far end* may send and
nothing in the local stack gates RTCP parsing on it.

**Only `nack pli` is advertised.** Generic `nack` asks the sender to retransmit specific lost
packets, and this host keeps no packet history to retransmit from. Advertising it would be a
promise WOLF cannot keep, and the browser would spend the stream asking for packets that are
never coming.

Requests are answered at most twice a second. A client losing packets steadily sends
indications steadily, and a key frame is the largest thing the encoder produces — answering
every one would push a burst of them into a link that is already dropping packets, which is
the cure making the disease worse.

### Route preference

Route preference is LAN, then direct P2P, then TURN relay — the same ladder the rest of
WOLF uses.

- **LAN**: host candidates on the same subnet win ICE naturally, so no special case is
  needed beyond making sure LAN candidates are gathered and not filtered out.
- **P2P**: STUN-discovered server-reflexive candidates.
- **Relay**: TURN, with short-lived credentials minted by the API. The relay carries
  encrypted media it cannot read; it learns session metadata and transport information and
  nothing else.

The negotiated route is surfaced in the UI, because "why is this laggy" is almost always
answered by "you are on relay". It is read from the nominated ICE candidate pair rather than
inferred: either end on a relay candidate means the media is relayed, and it takes *both*
ends on host candidates for the traffic to be staying on the local network.

### Who gives the agent its ICE servers

The agent holds no TURN secret and cannot mint credentials, so it has to be given them. The
realtime service attaches them to the `stream.request` it relays:

```
client ──stream.request──► realtime ──cloud.signal { envelope, iceServers }──► agent ──pipe──► host
```

Attached to the message rather than placed inside the payload, because the client must not
be able to choose the relay this PC's media will use — a test asserts that a client-supplied
server list never reaches the agent. Sent with the request rather than at connect, because
TURN credentials last an hour and an agent link stays up for days. Both the API endpoint
clients call and the relay use one shared builder, so the two ends of a connection are
pointed at the same relay.

With nothing configured — the shipped default — the list arrives empty, and the stream
connects on the local network only. The field still being present is what distinguishes
"no relay is configured" from "the relay was never delivered".

## Signaling

SDP and ICE candidates flow over links that already exist and are already authenticated:

```
browser ──WebSocket──► realtime service ──existing agent link──► service ──pipe──► host
```

Signaling lives in the realtime service rather than in a separate `services/signaling`
deployable. The realtime service is the process holding the agent's socket; a separate
signaling service would have to proxy every message through it anyway, which adds a hop and
a second thing to secure for no isolation benefit. The PRD's logical "signaling" component
maps onto the realtime service's signaling module.

Every signaling message is bound to a session id, and the realtime service checks that the
session is live, belongs to the caller, and holds the `screen` capability before relaying a
single byte. Signaling is not a tunnel: the payload is validated, not forwarded blind.

## The web client

The dashboard answers the offer; it never makes one. The state machine lives in
`apps/web/lib/remote-desktop.ts`, deliberately outside React: a WebSocket and an
`RTCPeerConnection` both outlive any render, and a component that re-mounts must not tear
down a live stream. Keeping them apart also means the negotiation can be tested without a
browser — the tests drive it with recorders in place of the two globals and assert the exact
messages that go out, because a message shape this client gets wrong is one the relay
rejects in production.

Unmounting the viewer stops the stream. Without that, navigating away leaves a PC encoding
its screen for a viewer who has gone.

### Two sets of statistics, because neither side can see the other's

| Measured on the PC | Measured in the browser |
| --- | --- |
| Capture rate, encode time per frame | Frame rate and bitrate actually received |
| Encoder name and whether it is hardware | Round-trip time, jitter, packet loss |
| Key frames sent | Decode time per frame, frames dropped |

Round-trip time, jitter, and loss are properties of the path, and only the receiving end
sees them — which is why the agent reports them as `null` rather than as zero, and why the
browser fills them in from `RTCPeerConnection.getStats()`. Shown side by side, they turn
"it feels laggy" into a specific answer: a high encode time is the PC, high jitter is the
network, high decode time is the viewing device.

Rates are derived from the change between samples rather than displayed as running totals,
because a total is not something an operator can read a problem out of.

### What the client says it can decode

`clientCodecs` comes from `RTCRtpReceiver.getCapabilities('video')`, not from a constant.
Where the browser will not say, the client claims H.264 and nothing more — every WebRTC
implementation is required to decode it, so it is a floor rather than a guess, and claiming
AV1 without evidence would negotiate a stream that renders nothing.

### Signaling reaches the realtime service, media does not

The dashboard opens a WebSocket to the realtime service (`NEXT_PUBLIC_WOLF_REALTIME_URL`)
and authenticates it with a session token before sending anything; the relay closes a socket
that speaks first. That origin has to be in the page's `connect-src`, or the stream fails
with a console error and no product-level explanation. WebRTC media is not subject to
`connect-src` and never passes through the cloud at all.

## Audio

WOLF streams **what the PC is playing** — the samples on their way to the speakers, captured
through WASAPI loopback. It is not a microphone. An operator watching a remote desktop hears
the video playing on it and the sound its applications make; they do not hear the room the
machine is sitting in. Microphone capture would be a different feature with a different
consent question, and WOLF does not have it.

### A separate grant from watching

`screen` and `audio` are separate session capabilities, because watching a machine and
listening to it are different intrusions and somebody may reasonably be given one and not
the other. The PC cannot know what a session was granted, so the relay attaches the decision
to the stream request the same way it attaches ICE servers:

```
client --stream.request--> realtime --cloud.signal { envelope, iceServers, audioAllowed }--> agent
```

It defaults to false, so a message that lost the field on the way through produces a silent
stream rather than an unauthorised one. A session that asks for audio without the capability
gets a stream with an adjustment saying exactly why it is silent.

The dashboard holds the capability but starts every stream muted, behind an explicit toggle.
Holding a permission is not the same as exercising it, and beginning a stream is not a
decision to start listening.

### A silent PC delivers nothing at all

This is the fact the whole pipeline is shaped around: WASAPI loopback produces *no packets*
while a machine is quiet — not packets of silence, nothing. Anything that treated an empty
read as a fault would report a broken stream on a quiet desktop, and anything paced by
arriving packets would stop producing audio the moment the music stopped and never restart
cleanly, because a receiver whose jitter buffer starves takes a second or more to recover.

So the encoder runs on its own 20 ms clock and fills gaps with silence. Opus in
discontinuous mode compresses those silent frames to almost nothing: measured on the
development machine, **a quiet second costs 1.2 kbps**. That is what makes it reasonable to
leave audio on.

### Format

The device chooses the format, and it is read rather than assumed. It is 48 kHz stereo float
on most machines — exactly what Opus wants, so nothing has to be converted — but Windows
lets the user pick the endpoint's mix rate, and 44.1 kHz is a common choice. Opus accepts
only 8, 12, 16, 24, and 48 kHz, so anything else is resampled; encoding 44.1 kHz samples as
though they were 48 kHz would play back a few percent slow and a semitone flat, which sounds
like a broken stream rather than a configuration mismatch.

Audio runs at a fixed 96 kbps and is not adapted. It is a rounding error beside a video
stream measured in megabits, so when the link gets tight the picture is what gives.

The WASAPI interop is written out rather than taken from a library: it is four interfaces,
and this process already runs as the signed-in user with access to their screen — every
dependency added here is more code with that access. Opus comes from Concentus, which is
pure managed code, so no native codec binary enters the process either.

## Multiple displays

A stream shows one display. Which one is chosen at the start and can be changed while it
runs — switching in place rather than restarting, because tearing the stream down would cost
a fresh negotiation, an ICE exchange, and several seconds of black screen just to look at
the other monitor.

Switching costs what a resolution change costs: a new capture, converter, and encoder, built
between frames on the thread that owns them, and a key frame so the client can decode what
follows. The replacements are constructed before anything is torn down, so a display that
cannot be captured — unplugged in the moment between choosing it and starting — leaves the
stream exactly as it was rather than ending it.

The agent answers a switch with a fresh `stream.ready`. The new display is usually a
different size, and a viewer that kept showing the old dimensions would be describing a
picture that is no longer arriving.

Two things follow the display and would be wrong if they did not:

- **Pointer coordinates.** They are normalised against the display being streamed and mapped
  onto its rectangle in the virtual desktop, so the injector is retargeted with the stream.
  Without that, every click after a switch would land on the old monitor.
- **The resolution cap.** A profile that capped the size fits the new display the same way,
  rather than reverting to native because the monitor changed.

### When a monitor is unplugged

Windows Graphics Capture closes the item, and the pipeline reports it rather than stopping
quietly — a viewer left on a frozen picture with nothing to explain it is the worst outcome
available. The stream falls back to the primary display and says so, so unplugging a monitor
interrupts the picture instead of ending the session.

## Clipboard

Clipboard content travels on the data channel and never through the cloud. That is not an
optimisation — **WOLF must never store clipboard contents**, and the surest way to keep a
promise about not retaining something is for it never to arrive. Nothing about it is logged
either: a clipboard routinely holds a password, and lengths and formats are enough to
diagnose anything that can go wrong here.

`clipboard` is a session capability of its own, decided by the relay and enforced by the
host, alongside `audio` and `input`. A session that can watch a screen has not thereby been
given the contents of whatever the person at that machine last copied. Without the grant the
clipboard is not read at all — not read and withheld.

### Neither side takes without being asked

Opening a stream does not hand over whatever was already on the PC's clipboard: the watcher
starts from the current state and only shares what is copied afterwards. In the other
direction WOLF never writes to the operator's own clipboard on its own — content the PC
offers is surfaced with a button, because a remote machine silently replacing what you
copied is not something to do without being asked. Browsers gate both reads and writes
behind a permission prompt anyway, which the panel explains rather than working around.

### Not looping

Applying content from the client changes the PC's clipboard, which looks exactly like the
user copying something. Without remembering what was just applied, the two machines would
trade the same string forever, so a hash of the last content to cross in either direction is
kept — a hash rather than the text, because holding somebody's clipboard in memory for the
life of a stream is not necessary to notice that nothing has changed.

### Text, and saying so

Text only, up to 256 KB. Past that the content is refused with a stated reason rather than
truncated: a silently shortened paste is worse than one that did not happen, because the
operator does not find out until whatever they pasted is broken. Images and files are named
but not carried — somebody who copies a screenshot and finds nothing on the other machine is
told WOLF does not move images, rather than concluding clipboard sharing is broken.

Change detection polls `GetClipboardSequenceNumber` twice a second rather than running a
clipboard-listener window. A message-only window and a pump would be a hundred lines of
interop to learn something one call answers.

## Input

Input events travel on a WebRTC data channel, not through the cloud, and are a **typed,
bounded union** — never arbitrary bytes handed to `SendInput`:

- Pointer coordinates are normalised `0..1` against the captured display, so the agent is
  the only component that needs to know the real resolution, and a malformed coordinate
  cannot address something off-screen.
- Keys are Windows virtual-key codes in `1..254`, not strings.
- Text input is a bounded string, for IME and mobile keyboards.
- Modifier state is explicit rather than inferred from key history, so a dropped key-up
  cannot leave a stuck Ctrl.

Ctrl+Alt+Del is a Secure Attention Sequence. A user-session process cannot synthesise it;
it needs `SendSAS` from a service, which is milestone 3. The agent refuses it with that
reason rather than sending three keystrokes Windows discards. Win+L is refused for the same
kind of reason: Windows handles it itself and does not accept it from injected input.

### The browser side

`KeyboardEvent.code` is used, not `KeyboardEvent.key`. The first is the physical key and the
second is the character it produced under the *local* layout — and since the remote machine
applies its own layout to a virtual-key code, sending the physical key is what makes a
German keyboard driving a US machine behave the way the remote user expects.

Coordinates are normalised against the *picture*, not the element. The video renders with
`object-fit: contain`, so there are black bars whenever the aspect ratios differ; normalising
against the element's rectangle puts every click off by the size of those bars — by nothing
in the middle and by a lot at the edges, which is the pattern that gets diagnosed as input
lag and never as a mapping bug. A click on a bar is not a click at the edge of the screen,
so it is not sent at all.

Events are batched to one animation frame. Pointer movement arrives far faster than it is
worth putting on the wire, and a batch per frame is both fewer messages and a more faithful
record of what the operator did.

### Input arbitration

`input` is one of the exclusive resources the session layer arbitrates. One session holds
it; others watch.

**The relay decides, and it is the only party that can.** The PC cannot see two sessions
competing for it, and a client deciding for itself is not a decision. So `input.request` and
`input.release` are handled by the realtime service rather than forwarded, and the answer —
`input.control` — is sent to *both* ends. `input.control` sits in neither direction list,
which means neither a client nor an agent may author one: a client that could would be
granting itself the keyboard, and an agent that could would be telling a dashboard that
somebody else is driving when nobody is.

**The grant expires, and the PC enforces the expiry.** A lease lasts two minutes and the
client renews it while it holds control. The session host stops injecting when the lease
lapses whether or not anything arrives to tell it to — which is the property that survives
the cloud becoming unreachable mid-session. An operator who closes their laptop stops
holding somebody else's keyboard within two minutes without anyone having to notice.

**Losing control releases the keys.** Whenever the host loses the lease, or the stream ends,
it sends key-ups for every modifier — both sides of each, because Windows resolves a generic
`VK_CONTROL` to the left one and a stuck *right* Ctrl would otherwise stay stuck. Without
this, a client that disconnects mid-chord leaves the person sitting at that machine finding
every keystroke turned into a shortcut.

### Where the checks are

Input is the one path where the cloud is not in the middle: events go from the browser
straight to the session host over the data channel, deliberately, because a keystroke that
took a round trip through a server before reaching the machine would feel like a machine
thinking about it. The consequence is that **the host is the only validator**. Nothing
upstream has looked at those bytes, so bounds — coordinates in `0..1`, keys in `1..254`,
text length, batch size — are all checked again there, and an event outside them is refused
rather than clamped into something else.

### What Windows will not allow

The session host runs as the signed-in user, not elevated. Windows refuses injected input to
a window at a higher integrity level, so a UAC prompt or an elevated Task Manager silently
swallows everything sent to it. `SendInput` says so — zero events accepted, with
`ERROR_ACCESS_DENIED` — and WOLF passes that on as a limitation rather than leaving an
operator clicking at a window that will never respond. Reaching those windows needs the
privileged helper, which is milestone 3.

## Adaptation

The stream is driven by measurements, on a one-second interval. Nothing is inferred from how
long it has been running or from how the picture looks.

### What it listens to

| Signal | Where it comes from | Who else could know it |
| --- | --- | --- |
| Bandwidth estimate | Transport-wide congestion control (`transport-cc`, which the offer advertises and browsers send) | Nobody — only the transport sees per-packet arrival times |
| Packet loss | The receiver's RTCP report | Only the far end; it is the one counting what failed to arrive |
| Round-trip time | Derived from the receiver report's LSR/DLSR timestamps, per RFC 3550 | Both ends, but this is the sender's view |
| Encode time per frame | The encoder itself | Only the PC |
| Captured frames per second | The capture pipeline | Only the PC |

Loss and the estimate are `null` until something has actually reported them. A stream that
assumed zero loss before the first receiver report would spend its first seconds climbing
into congestion that was already there.

### What it does about it

| Condition | Response |
| --- | --- |
| Loss ≥ 2% | Bitrate × 0.85 |
| Loss ≥ 10% | Bitrate × 0.6 |
| Estimate below the current rate | Clamp to 95% of the estimate |
| Encode time over 80% of the frame budget | Step the frame rate down: 60 → 48 → 30 → 24 → 15 |
| Capture falling behind | Report it; neither lever fixes it |
| Bitrate at the floor *and* frame rate at the bottom | Step the resolution down: full → 75% → 50% |
| A lever the operator pinned | Left where they put it, and counted as already spent |
| Three clean intervals in a row | Raise the bitrate 8%, capped by the estimate |
| Bitrate back at the ceiling, still clean | Restore one step of resolution, then of frame rate |

**Bitrate first, frame rate second, resolution last.** A bitrate change is invisible; a frame
rate change is noticeable but harmless; a resolution change costs a new encoder, a key frame,
and a visible re-layout of everything the operator is looking at. So resolution is only
touched when lowering the bitrate has reached the floor *and* the frame rate has reached the
bottom of its ladder — it is what is left, not a first response.

Scaling happens in the video processor that is already converting every frame from BGRA to
NV12. It is reading every pixel regardless, so producing a smaller output costs essentially
nothing extra, and it is a better scaler than anything hand-written because it is the
fixed-function block the display pipeline uses. Changing size does mean building a new
converter and a new encoder, which happens between frames on the thread that owns them: the
replacements are constructed before anything is torn down, so a GPU that refuses the new size
leaves the stream running at the size it had.

The ladder stops at half size. Below that the text on a remote desktop stops being readable,
and an unreadable desktop is not a degraded stream — it is a useless one.

**Coming back, resolution is restored before frame rate.** A remote desktop is mostly read:
text too soft to make out cannot be worked around, while a slower refresh can. Bitrate still
comes first, because the other two need the headroom to be worth restoring.

A profile that caps the resolution is now honoured from the start rather than reported as a
setting WOLF ignores. The cap is fitted to the display's aspect ratio and rounded to even
dimensions — a desktop squeezed into the wrong shape is worse than a smaller one, and an odd
dimension has no representation in NV12 at all.

**Down fast, up slow.** Congestion recovers in steps, and probing after the first quiet
second produces a stream that oscillates between sharp and unwatchable — which is worse to
use than one that settles slightly low. Recovery also restores bitrate before frame rate: a
smooth soft picture is easier to work in than a sharp stuttering one.

**There is a floor.** Below 200 kbps a 1440p stream is not a picture, so the controller stops
there rather than halving until nothing is left. Running under the profile's own minimum is
allowed — a working low-quality stream beats a broken high-quality one — but it is reported
as degraded, because the profile the operator chose is not currently possible.

Lowering the frame rate changes the pacing loop, not the encoder's configuration:
reconfiguring the encoder mid-stream would cost a key frame. Feeding a 60 fps-configured
encoder 15 frames a second also lowers the bitrate it produces, which is the direction
congestion wants anyway. Measured on the development machine, the change takes effect
immediately: 55 fps before, 14.5 fps after.

### Every request is answered

A stream request forwarded to the session host is remembered by the agent until something
comes back for it. That is not belt and braces: writing to the host's named pipe succeeds
for a host that is already exiting — the bytes reach the buffer and nobody ever reads them —
so a successful send is not evidence that anything will happen.

Two things end the wait. Losing the host fails every request still outstanding, and every
stream it was serving, immediately. Anything else — a host that is running but wedged, a
message lost in a pipe that was closing — is answered by a sweep after twenty seconds, which
is generous because a cold start really does take a second or two to build a capture device,
an encoder and a pipeline.

The alternative was what the browser test found: a viewer showing `requesting` for as long
as somebody was willing to watch it, with nothing on either side saying why. The supervisor
now also logs the exit code of a host that has gone, which is the only evidence of why it
went.

### More than one monitor

One display is streamed at a time, chosen by the client and switchable without a fresh
negotiation. Two things about that are easy to get wrong, and both fail quietly.

**The switch is asynchronous, and the client is told when it has happened.** Building a new
capture and encoder from another thread while the capture thread is mid-frame is how a
pipeline ends up encoding from a texture that has been disposed, so the request is queued and
applied between frames. Which means the new size is not knowable when the request returns:
anything reading it there reads the *old* display's. The pipeline raises an event once the
switch has actually happened — or failed — and that is when `stream.ready` goes out and when
the base size that pinned resolutions scale from is updated. A failed switch is reported as
well, because a client waiting for a `stream.ready` that is never coming has nothing to act
on.

**Pointer coordinates are relative to the display being streamed; `SendInput` wants a
fraction of the whole virtual desktop.** A monitor to the left of the primary starts at a
negative X, one above it at a negative Y, and half the absolute range belongs to the other
screen. Mapping that ignores the display's origin still produces a click — on the wrong
monitor, which gets reported as lag or as the remote desktop being broken. The injector is
retargeted before the switch rather than after, so input arriving in between belongs to the
display the operator is now looking at.

The mapping is a static function given its display and its desktop, rather than one that
reads the metrics itself, so the layouts can be stated in a test. That is the only way the
arithmetic can be checked at all on a machine with one monitor — which is what this was
written on, and why the end-to-end two-display switch test skips there rather than passing
on nothing.

### Saying so

A stream running below its profile is `DEGRADED`, with one of the protocol's reasons
attached — `bandwidth`, `packet-loss`, `encoder-overloaded`, `capture-slow`. The distinction
is the point: "your network", "this PC's encoder", and "the PC is not producing frames" are
three different problems, and a single "degraded" badge would send somebody to investigate
the wrong one. The state change is sent immediately; the statistics confirm it two seconds
later.

**The rates describe the last second, not the whole stream.** Frames per second, captured
frames per second, and encode time per frame are all measured over a one-second window. That
matters to both things that read them. The adaptation controller lowers the frame rate when
encoding stops fitting inside its budget, and a lifetime mean would hide an encoder that had
only just started struggling behind every healthy second before it — then drag the number
back down once it had adapted. The operator reading the statistics panel is asking the same
question: a stream taken from 30 fps to 15 reported neither for minutes, drifting between
them. Measured on the development machine, a pipeline moved from a 60 fps target to 10 now
reports 55.6 fps and then 10.0; the lifetime figure at that moment was 35.7.

The counts beside them — frames captured, frames encoded, bytes sent, key frames — stay
lifetime totals, which is what a count should be. The window is closed on the capture thread
rather than when the statistics are read, so reading them has no side effect and two callers
on different intervals cannot cut each other's windows short.

The operator can pin a profile by turning adaptation off. A pinned profile is left exactly
as it was asked for, even on a link that cannot carry it — but the shortfall is still
reported, because staying silent while the stream visibly struggles would leave them blaming
the wrong thing.

### Pinning one lever at a time

Turning adaptation off is all or nothing, and the useful cases are mixed. Holding the
resolution steady so text stays readable while the frame rate takes whatever the link does
to it is a reasonable thing to want, and so is holding a frame rate for something being
demonstrated while the bitrate does what it must.

So each lever can be pinned on its own. `profile.overrides` carries three nullable values —
`bitrateBps`, `frameRate`, `resolutionScale` — where null means "this one adapts". They sit
alongside `adaptive` rather than replacing it: switching adaptation off still pins
everything at the profile's own numbers.

Four rules follow from "honour the setting, never hide what it costs":

- **A pinned lever is never moved.** Not to recover from loss, and not to give quality back
  when the link improves. Handing quality back to a lever the operator is holding is not
  generosity, it is ignoring them slowly.
- **A pinned lever counts as exhausted, not as a reason to wait.** Resolution normally comes
  down only once the bitrate has reached its floor and the frame rate the bottom of its
  ladder. If either of those is pinned it can never reach its own bottom, so a pin is
  treated as spent — otherwise pinning the bitrate would quietly disable the two levers
  underneath it.
- **The stream still says it is degraded.** A pinned bitrate does not make the packet loss
  stop; it makes it the operator's to know about. The causal reason is reported exactly as
  it would be without the pin.
- **A pin is used as typed.** The frame-rate ladder exists to make automatic steps feel
  gradual; somebody who typed 45 asked for 45, not for the nearest rung.

A pin replaces the profile's range for that lever rather than fighting it. A bitrate pinned
under the profile's own minimum is the same person saying something more specific, so it is
not reported as failing to meet the profile. A pin *above* what the profile allows has no
such reading, and the schema rejects it instead of resolving it by guesswork.

What cannot be met is clamped and reported as an adjustment, so the operator sees the number
they typed next to the number they got: pinning 60 fps on a 30 fps profile comes back as
`overrides.frameRate`, requested 60, applied 30.

A pinned resolution is applied before the offer goes out, so `stream.ready` describes the
picture the client will actually receive. A pin that only took effect on the first adaptation
interval would have the viewer laying itself out for a stream that never arrives.

Pins can be changed on a running stream. `stream.set-profile` now carries policy — the
bitrate ceiling, adaptation, and the pins — and all of it takes effect on the next frame; the
host answers with a fresh `stream.ready` because a pinned resolution changes the picture's
size. Resolution beyond that, and codec, still need a new negotiation, and a profile that
changes them is answered with what could not be done rather than half-applied.

## Stream states

```
STARTING → STREAMING ⇄ DEGRADED
              │  ▲
              ▼  │
         RECONNECTING
              │
   LOCKED / LOGIN / RESTARTING / OFFLINE
```

`DEGRADED` is a real state, not a cosmetic one: it means the stream is running below the
requested profile, and the UI shows why.

## Build order

1. **Protocol and cloud** — *done.* Stream types, typed input, signaling messages, the
   relay with its direction and session checks, ICE credentials, profiles, stream records.
2. **Session host** — *done.* The process, service supervision, the ACL'd named pipe,
   display enumeration, and Media Foundation encoder discovery.
3. **Capture and encode** — *done.* Windows Graphics Capture into a hardware H.264 encoder,
   frames staying on the GPU throughout, with on-demand key frames and live bitrate control.
   Desktop Duplication behind the same interface for the builds without Graphics Capture,
   with the cursor it cannot capture reported rather than quietly missing.
4. **WebRTC on the host** — *done.* Peer connection, H.264 video track, control data
   channel, ICE servers delivered from the cloud, live statistics.
5. **Web client** — *done.* The dashboard answers the offer, renders the stream, shows both
   sides' statistics, switches quality profile on a running stream, and sends keyboard and
   mouse input once the cloud has granted control.
6. **Input injection** — *done.* Typed, bounded events injected through `SendInput`, gated
   on a lease the relay arbitrates and the host enforces.
7. **Adaptive bitrate, frame rate, and resolution** — *done.* Driven by congestion
   feedback, receiver reports, and the encoder's own cost, with degradation reported rather
   than merely felt.
8. **Audio** — *done.* Loopback capture, Opus, and a grant separate from `screen`.
9. **Clipboard** — *done.* Text both ways on the data channel, behind its own grant.
10. **Multi-monitor** — *done.* One display at a time, switchable live, with a fallback when
    the streamed one is unplugged.
11. **Manual quality overrides** — *done.* Any of the three levers can be pinned on its own
    and changed on a running stream, with what cannot be met clamped and reported rather
    than silently ignored.

Each step leaves the build working, and the agent only advertises a capability once it can
genuinely deliver it — so a half-finished slice is inert rather than dangerous.

### Why "can it stream" is its own field

A PC can own a hardware H.264 encoder and still be unable to stream: nobody is signed in,
the workstation is locked, or the agent build cannot capture. Early on the dashboard
inferred availability from the encoder list, which meant it offered a connection that could
never start.

The agent now answers the question directly — `remoteDesktopAvailable`, with a reason code
when the answer is no — and one shared function computes it, so the capability handshake and
the status command can never disagree. The reason codes separate "wait, this resolves on its
own" (locked, signing in, restarting) from "this will not resolve" (no encoder, no display,
capture unsupported), because those call for different responses from the person at the
other end.

Capturing is tracked separately from delivering, for the same reason. The two fields are
independent because they fail independently: a machine can capture and have no way to send,
or have a transport and no way to capture, and an operator needs to know which. Capture is
reported first when both are missing, because it is the one that might be a property of
their machine rather than of the build.

`activeStreams` is answered the same way. The host reports each running stream with the
session that opened it, built from the live sessions rather than from a counter kept
alongside them — so a stream that failed to tear down cleanly appears in the answer instead
of being invisible, and a client asking what is running on their PC can tell whether it is
looking at its own stream.

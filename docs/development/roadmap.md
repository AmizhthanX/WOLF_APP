# Roadmap

WOLF is built in vertical slices, and the build stays working after each one. A capability
the agent has not implemented is *advertised as unavailable*, so the cloud refuses those
commands rather than queueing work that would never run — a half-finished slice is inert,
not dangerous.

## Milestone 1 — Foundation and core management (done)

- Monorepo, shared types, protocol, validation, telemetry schema
- Authentication: owner account, scrypt hashing, access tokens, rotating refresh tokens,
  device trust, lockout
- PC enrolment with per-machine key pairs; authenticated outbound agent link
- Typed command protocol with payload-based risk classification and enforcement
- Sessions, per-capability grants, exclusive resource arbitration, privileged grants
- Telemetry ingest, day-partitioned storage, aggregate tiers, retention policy
- Processes: list, tree, details, terminate (PID-reuse guarded), priority
- Power: lock, sign out, sleep, hibernate, restart, shut down, schedule, cancel
- Kill switch, one-way from the cloud
- Forensic audit log with structural redaction
- Web dashboard and PC workspace (overview, processes, power, audit), PWA manifest
- Windows agent as a Windows Service, with local SQLite state and offline buffering
- Tests: a full web-to-agent end-to-end suite, plus unit and schema coverage

## Milestone 2 — Remote desktop (feature-complete)

The largest single piece, and the reason the capability handshake exists.

**Done — protocol and cloud**

- Stream types, profiles with built-ins, codec negotiation that refuses rather than guesses
- Typed, bounded input events; normalised coordinates; virtual-key codes, not strings
- Signaling relay in the realtime service, with per-message session, capability, and
  direction checks
- ICE endpoint with short-lived TURN credentials, and an honest `lan-only` answer when no
  STUN or TURN is configured
- Stream records holding what was negotiated and how it performed — never a frame

**Done — session host detection**

- `Wolf.Agent.SessionHost`, launched into the interactive session by the service and
  supervised there, because session 0 has no desktop
- ACL'd named pipe between the two, reachable only by SYSTEM and the signed-in user
- Real display enumeration and Media Foundation encoder discovery, verified against actual
  hardware
- `remoteDesktopAvailable` reported directly rather than inferred, with reason codes

**Done — capture and encode**

- Windows Graphics Capture into a hardware H.264 encoder, frames staying on the GPU from
  capture through colour conversion to encode
- Per-monitor DPI awareness, so the reported resolution, the captured frame, and pointer
  coordinates describe the same pixels
- On-demand key frames and live bitrate control through `ICodecAPI`, with both capabilities
  measured on the actual encoder rather than taken from its self-description
- Verified on an RTX 3060 at 2560×1440: 30 fps sustained, 0 frames dropped, 0.47 ms per
  frame of encode time, key frame 46 ms after a request

**Done — WebRTC on the host**

- A real peer connection in the session host, offering H.264 on a send-only video track,
  with a control data channel for the input that arrives in the next slice
- `profile-level-id` read from the encoder's own SPS, so the offer describes the pictures
  that are actually coming rather than a constant that is wrong on somebody's machine
- ICE servers minted by the cloud and attached to the relayed stream request; a client
  cannot choose the relay its PC's media will use
- Route reported from the nominated candidate pair — `lan`, `p2p`, or `relay`
- Live statistics: frame rate, resolution, encoder, encode time per frame, key frames.
  Round-trip time, jitter, and loss are reported as *not measured* rather than as zero
- Capture starts when the peer connects and stops when the stream does, verified by a test
  that watches for frames which must not arrive after teardown
- `transportAvailable` is now true, and `activeStreams` reports the streams that are really
  running rather than a placeholder
- Verified end to end against a real WebRTC peer: 2560×1440 at 30 fps over `lan`,
  0.57 ms per frame of encode time, and a 120 KB frame fragmented and reassembled intact

**Done — web client (viewing)**

- The dashboard answers the agent's offer and renders the stream, with the negotiation,
  the codec, and whether the encoder is hardware stated on the page
- Settings the PC could not honour are shown as a table of what was asked for, what was
  applied, and why — rather than being applied silently
- Live statistics from both ends: the PC reports what capture and encode cost, the browser
  reports round-trip time, jitter, and loss, which only the receiving end can measure
- Quality presets that change the profile on a running stream
- The viewer states that control is unavailable rather than letting an operator find out by
  clicking on the picture
- Leaving the page stops the stream, so a PC never keeps encoding for a viewer who has gone

**Done — input**

- Keyboard and mouse injected through `SendInput`: absolute pointer positioning across the
  virtual desktop, wheel and horizontal scroll, virtual-key codes with scan codes and the
  extended flag, and Unicode text for IMEs and phone keyboards
- Arbitration in the relay, because only the cloud sees two sessions competing for one PC.
  The grant goes to both ends, expires in two minutes, and is renewed by the client holding
  it
- The expiry is enforced on the PC, so a cloud that becomes unreachable cannot leave a
  machine controllable by whoever held it last
- Losing control releases both sides of every modifier, so no chord is left stuck
- Combinations Windows reserves — Ctrl+Alt+Delete, Win+L — are refused with the reason
  rather than sent as keystrokes Windows discards
- Input blocked by UIPI, as it is for a UAC prompt, is reported as a limitation instead of
  disappearing
- Verified against the real Windows input stack: the tests inject and observe through a
  low-level hook that swallows the event, so nothing reaches the machine's own windows

**Done — adaptive bitrate, frame rate, and resolution**

- Driven by real feedback: the transport-wide congestion estimate, the receiver's reported
  loss, round-trip time derived from RTCP timestamps, and the encoder's own cost per frame
- Bitrate first, frame rate second, resolution last, in the order the PRD sets out —
  resolution only once the bitrate is at its floor and the frame rate at the bottom of its
  ladder, because the change costs a new encoder, a key frame, and a visible re-layout
- Scaling runs in the video processor that already converts every frame, so it costs almost
  nothing beyond the conversion that was happening anyway
- A profile that caps the resolution is honoured from the start, fitted to the display's
  aspect ratio, instead of being reported as a setting WOLF ignores
- Down fast and up slow — three clean intervals before probing, and bitrate restored before
  frame rate — because a stream that oscillates is worse to use than one that settles low
- A floor below which the picture is not worth sending, and an honest `DEGRADED` state with
  the reason attached whenever the profile is not being met
- A pinned profile is left alone, and its shortfall reported rather than silently overridden
- Picture loss indications are advertised and answered, so a client that drops part of a key
  frame gets a new one instead of sitting on a frozen picture. Only `nack pli` is offered:
  generic `nack` promises a retransmission this host cannot perform
- Verified on real hardware: changing the pacing target took a running pipeline from 55 fps
  to 14.5 fps; halving the encoded resolution on a running pipeline swapped in a new encoder
  and kept streaming, with a key frame so the client could decode what followed; and a real
  picture loss indication over a live connection produced a key frame request

**Done — audio**

- WASAPI loopback capture: what the PC is playing, never its microphone
- Opus at 48 kHz stereo in 20 ms frames, on a fixed clock — a silent machine delivers no
  packets at all, so the encoder fills the gaps rather than stopping
- Discontinuous transmission makes silence nearly free: a quiet second measured at 1.2 kbps
- `audio` is a separate grant from `screen`, decided by the relay and enforced by the host;
  the dashboard holds the capability but starts every stream muted behind an explicit toggle
- A machine with no audio endpoint, or a session without the grant, gets a working silent
  stream and an adjustment saying which
- Verified against the real audio stack, using a tone at -60 dBFS so the tests make no
  audible noise: loopback captured it at 0.0037, and Opus packets reached a live peer

**Done — clipboard**

- Text in both directions on the data channel, never through the cloud, so there is nothing
  for a server to store or log
- `clipboard` is its own grant, like `audio` and `input`; without it the clipboard is not
  read at all
- Neither side takes without being asked: a stream does not ship what was already copied,
  and WOLF never writes to the operator's own clipboard without a click
- Loop prevention, so applying content from the client is not offered straight back
- 256 KB of text, refused rather than truncated past that; images and files are named but
  not carried

**Done — multiple displays**

- The streamed display can be switched while the stream runs, without a renegotiation
- Pointer coordinates and the profile's resolution cap follow the display, so clicks land on
  the monitor being watched and a capped stream stays capped
- Unplugging the streamed monitor falls back to the primary and says so, rather than leaving
  the viewer on a frozen picture
- A display that cannot be captured leaves the stream exactly as it was

Every capability this milestone set out to build now works: watch a PC, hear it, drive it,
share a clipboard with it, and switch between its monitors — adapting to the link as it goes.

**Done — a performance suite**

- Measures what somebody experiences: time to first picture, encode cost including the tail,
  sustained frame rate, bandwidth against each profile's ceiling, what a resolution change
  costs in freeze time, and how fast input is handled
- Excluded from the ordinary run and from CI, which has no GPU: `npm run test:windows:perf`
- Budgets live in one file. They are derived from what the architecture already commits to,
  not transcribed from the PRD's matrix, which is not recorded in this repository
- Measured on an RTX 3060 at 2560×1440: first picture 751 ms, encode mean 0.55 ms and p99
  4.64 ms, 55 fps sustained with nothing dropped, a resolution change costing a 15 ms gap,
  and input handled at 1222 batches a second

**Done — manual quality overrides**

- Bitrate, frame rate, and resolution can each be pinned on their own, leaving the other two
  adapting. Switching adaptation off entirely still works and still means all three
- A pinned lever is never moved: not to recover from loss, and not to give quality back when
  the link improves
- A pinned lever counts as spent rather than as something to wait for, so pinning the bitrate
  does not quietly disable the two levers underneath it
- The stream still reports itself degraded, with the same causal reason it would have given
  without the pin. A pinned bitrate does not make the packet loss stop
- A pin is used as typed rather than snapped to the adaptation ladder
- What the display or the encoder cannot meet is clamped and reported as an adjustment, so
  the operator sees the number they typed next to the number they got
- A pinned resolution is applied before the offer goes out, so `stream.ready` describes the
  picture that will actually arrive
- Pins can be changed on a running stream, and the viewer offers each lever as a short list
  of values the agent can genuinely hold

**Fixed along the way — a suite that answered differently each run**

- The capture, encode, and stream tests only see frames when something on screen changes,
  so on an idle desktop they failed at random: runs of the same unchanged tree failed six,
  three, one and zero of twelve
- They now share the performance suite's `ScreenActivity` — a small labelled window that
  repaints while those classes run — as a class fixture. Three consecutive full runs pass
  150 of 150, and the suite went from 2m41s to 52s because nothing waits out a timeout

**Done — the whole loop, against a real browser**

Run with `npm run dev:cloud`, the agent pointed at it, and `npm run browser -w @wolf/e2e`.
Chromium, the shipping client state machine, the real relay, the real agent: 2560x1440 at 30
fps over a direct p2p connection, 1945 frames decoded with no loss, encoded by the NVIDIA
H.264 MFT at 0.38 ms a frame and decoded at 0.36. Control was requested and granted with a
two-minute lease. Pinning 15 fps at half size took the stream to 1280x720 at exactly 15.00
fps and unpinning put it back — the manual overrides, end to end.

It found six defects that every layer's own tests had passed over, which is the argument for
having done it:

1. **The agent could never connect.** The cloud built the signing payload with NUL
   separators and the agent with spaces, so enrolment succeeded and every handshake after it
   was refused with `bad-signature`. Both interop suites checked their own crypto against a
   payload string carried inside the shared vector, and neither compared the two functions.
   They do now
2. **The session host was never shipped beside the agent.** Nothing copied
   `Wolf.Agent.SessionHost.exe` into the agent's output, so a built agent reported itself
   healthy and failed every stream request for want of a host
3. **Enrolment locked itself out of its own identity store.** The directory ACL was set to
   SYSTEM and Administrators with inheritance off, and then written to — which works as
   LocalSystem and fails with access-denied for the documented development run
4. **A machine with many NDIS filter drivers could not stay connected.** Windows lists every
   filter bound to an adapter as its own interface; this PC reported 42 where the protocol
   accepts 32, and the relay closed the link over it, taking the stream signaling with it.
   Adapters are now told apart by whether they have an address of their own, and the count is
   capped before it is sent
5. **The relay logged how many validation issues a message had, not which.** A count is not
   diagnosable; finding defect 4 took a change to log the field paths
6. **A stream requested while the session host is restarting was dropped**, and the
   supervisor never logged why the previous host had exited. The agent now remembers every
   request it forwards until something comes back: losing the host fails them at once, and a
   sweep answers anything still unanswered after twenty seconds. Verified by killing the
   real host mid-stream — the client is told in about a second — and by holding it down
   across a fresh request, which is refused in four milliseconds instead of hanging
7. **The agent's reported frame rate was a lifetime mean**, so after any adaptation it gave a
   number that was neither the old rate nor the new one — to the operator reading the
   statistics panel, and to the adaptation controller deciding what to do next. Now measured
   over a one-second window: a pipeline moved from a 60 fps target to 10 reports 55.6 then
   10.0, where the lifetime figure said 35.7

**Done — the Desktop Duplication fallback**

- A second capture path behind the same interface, for the builds that have no Windows
  Graphics Capture. Everything above it — converter, encoder, adaptation, transport — cannot
  tell which one is running
- Graphics Capture stays preferred, and the choice is re-made per display so a stream never
  silently changes API halfway through
- The two things duplication cannot do are reported rather than left to be discovered: the
  mouse pointer is not in the picture, which arrives as an adjustment on the negotiation, and
  Windows draws no capture indicator for the person at the PC
- Exercised on a machine that *does* have Graphics Capture, by forcing it — a fallback only
  run by the people who cannot report bugs is one that has already rotted. Five tests,
  including a whole encode pipeline on the fallback producing real H.264
- Verified through a real browser: 2560x1440 at 30 fps, 485 frames decoded over a direct
  connection, with the cursor adjustment showing in the negotiation
-  forces it, for machines where Graphics Capture reports
  itself supported and then produces nothing usable

**Still open, and worth doing before this is called finished**

- Switching between two physical monitors is untested: the development machine has one

## Milestone 3 — The privileged helper

Everything blocked on elevation, built without weakening any Windows boundary.

- Separate helper service with an allow-listed, typed command surface
- Authenticated, ACL-protected named-pipe IPC with anti-replay
- Remote lock; SMART disk health; device management
- Secure-desktop capture for the lock and sign-in screens
- Remote unlock using a dedicated WOLF credential, never the Windows password

## Milestone 4 — Administration

- Terminal: CMD, PowerShell, tabs, streaming output, script execution
- Administrative terminal behind an elevated grant
- File manager and chunked, resumable transfers with checksums
- Clipboard sync, never persisted in cloud history
- Services, scheduled tasks, startup items
- Network diagnostics, Windows event logs, hardware inventory

## Milestone 5 — Intelligence

- Long-term telemetry rollups and the aggregation job
- Process, GPU, and storage intelligence
- Notifications and the rule engine
- The automation engine: triggers, conditions, actions, cooldowns
- Configuration backup and restore

## Android

Kotlin and Jetpack Compose, native WebRTC, platform keystore for tokens and device
identity, signed APK through CI. Scheduled after milestone 2, so the client arrives when
there is a desktop to stream to it.

## Infrastructure

- Terraform for GCP, behind the cloud-provider interface
- Staging and production pipelines with migrations and rollback
- Signed agent packages, staged rollout, health check, and rollback on failure

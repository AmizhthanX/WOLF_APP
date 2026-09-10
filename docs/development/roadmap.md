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
- Power: sign out, sleep, hibernate, restart, shut down, schedule, cancel. Lock was refused
  until milestone 3, for a reason worth keeping: it needs a process *in* the interactive
  session, not more privilege
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

**Done — the multi-monitor arithmetic, and a switch that reports when it finished**

- Pointer mapping is now tested against stated two-monitor layouts: a second monitor to the
  right, to the left (negative origins, which a single-display machine can never produce),
  above, portrait beside landscape, and two of different resolutions. The property asserted
  is the one that matters — neither display's coordinates reach into the other's part of the
  absolute range, so a click lands on the monitor being watched
- Those tests were checked by breaking the code on purpose: dropping the display origin fails
  four of eight, dropping the virtual-desktop origin fails two. They are not vacuous
- Found and fixed while working through the two-monitor path: `RequestDisplay` only *queues*
  the switch, but the session read the new encoded size immediately afterwards — so on two
  monitors of different resolutions the client was told to lay out for the old display's
  dimensions, and a pinned resolution scaled from the wrong base. The pipeline now reports
  when the switch actually happened, and the client is told then
- A switch that fails is reported too, rather than leaving the client waiting for a
  `stream.ready` that is not coming

**Still open, and worth doing before this is called finished**

- **Switching between two physical monitors has still never been run.** The development
  machine has one display, and the end-to-end test skips with that reason rather than
  passing on nothing. What *is* now covered is the arithmetic underneath it — see below —
  and what is not is the hardware itself

## Milestone 3 — The privileged helper

Everything blocked on elevation, built without weakening any Windows boundary.

**Done — the helper, its channel, and the first operation through it**

- `Wolf.Agent.Helper`: a separate service with an allow-listed, typed command surface. No
  network connection, no configuration file, and no "run this" operation — everything it will
  ever do is compiled into it
- Three guards on the channel, each answering a different question: the pipe ACL (SYSTEM and
  Administrators only), caller verification (the client's process id comes from the pipe, not
  from the client, and its image must be the agent beside the helper), and a per-connection
  nonce with a strictly increasing sequence. A refused request does not advance the sequence,
  so injecting one malformed message cannot lock the real agent out of its own channel
- Stated plainly in the architecture: this is a boundary of **surface**, not of privilege.
  Both processes run as `LocalSystem`, and it stops nothing an attacker who is already SYSTEM
  could not do
- `disk.smart-health` end to end — command, helper operation, and the drive's own verdict.
  Read-only on purpose for a first operation: a mistake in the plumbing cannot damage anything
- `unknown` is a real status and a common one. A USB enclosure, a RAID member, a virtual disk
  — none of them answer, and "healthy" because nothing said otherwise would be inventing
  reassurance about somebody's data
- `privilegedHelperAvailable` is answered by opening the pipe at call time rather than
  assumed, because the helper is a separate service and can be stopped

**Done — remote lock, through the session host rather than the helper**

- The old refusal said remote lock needed the privileged helper. It does not, and the
  correction matters: `LockWorkStation` affects only the caller's own session, and the agent
  service runs in session 0, which has no desktop to lock. It is already `LocalSystem` and
  still cannot do it. The session host is already inside the interactive session for screen
  capture, so it is what gets asked
- One new service-to-host message that expects an answer, correlated by request id and
  bounded by a timeout — everything else the service sends concerns a stream that reports its
  own state, while an action either happened or did not and the operator is owed which
- Losing the host fails every outstanding request at once rather than leaving them to time
  out, so a command completes with the real reason
- Nobody signed in is reported as a limitation rather than a failure: there is no session to
  lock, and a PC at the sign-in screen is already in the state that was wanted
- Reported as *requested*, not as done. Windows queues the lock and returns; there is no
  supported way to observe it completing, and inferring one from the presence of LogonUI
  would be a guess about somebody's privacy that WOLF cannot check
- The test that really locks the screen is opt-in behind `WOLF_TEST_ALLOW_LOCK=1`. It locks
  the machine running it and takes every capture test after it with it, which is too much to
  do to somebody who typed `npm test`. Everything around it — the allow-list, the host's
  refusal of an unknown action, the answer when no host is connected — runs normally

**Done — device management**

- `device.list` reads what is attached, what is disabled, and what has a driver problem.
  `error` is its own state rather than folded into `disabled`: a driver fault and a
  switched-off device look identical in a two-state list and call for different responses
- `device.set-enabled` turns one off or on, through SetupAPI in the helper
- Risk is asymmetric and the schema says so. Enabling is `medium`; disabling is `critical` —
  confirmation, re-authentication, and a single-use privileged grant
- Some devices are refused outright rather than confirmed: a connected network adapter, any
  storage, display adapters, and Windows' own system devices. A confirmation dialog asks
  somebody to accept a risk, and it is the wrong tool when accepting it removes their ability
  to do anything about it
- A *disconnected* network adapter is deliberately allowed, or the class would be useless for
  what it is most often wanted for
- The device's name is checked before acting, the same way terminating a process checks the
  name against the pid
- Running the rules against real hardware caught one immediately: a virtual camera came back
  classified `system-critical`, because `SoftwareDevice` had been put in the system list.
  That would have been a confident, permanent refusal of something entirely safe

**Done — the secure-desktop host**

- A second session host, launched as SYSTEM onto `winsta0\\Winlogon`, on its own channel,
  started only while the secure desktop has the input and stopped when it does not
- The launch is the mechanism Windows' own accessibility components use: duplicate the
  service's token, set its session id to the console session, and name the desktop at
  creation — there is no supported way to move a process between desktops afterwards
- Its pipe admits SYSTEM only. The user host's also admits the interactive user, which is
  right for a channel carrying that user's own screen and wrong for one carrying the lock
  screen
- It captures through Desktop Duplication, because Graphics Capture has no item to create on
  that desktop. That is reasoning rather than an observation, and it is labelled as such
- Not kept running: it holds a duplication of the display and runs as SYSTEM, and the
  alternative to a two-second start is a SYSTEM process watching a desktop nobody is looking
  at for hours
- `secureDesktopCaptureAvailable` answers whether a host could be started here, asked at call
  time rather than cached
- Its frames reach the client on the connection the user host already holds: the secure host
  encodes, the service relays, the user host puts them on its existing track. A second peer
  connection would have to be negotiated by a process that disappears when the screen unlocks
- That is the one place media crosses the agent service, and the exception is argued rather
  than assumed: the frames are the lock screen, produced by a SYSTEM process and relayed by
  another, and a pipe directly between the two hosts would put that channel where a user-mode
  process could squat on the name
- Captured modestly on purpose — 1080p, 10 fps, 2 Mbps — and not at all until somebody is
  actually watching

**Done — input on the secure desktop**

- Authorisation stays in the user host and only the injection moves: `InputChannel` checks the
  control lease, its expiry, the stream id and every event's bounds exactly as it always does,
  then forwards the batch instead of injecting it
- `SecureInputSink`, on the other side, injects what it is handed and is deliberately
  incapable of deciding whether input is allowed — it has no session to decide with, and must
  not pretend to
- Forwarding is not a way round the lease, and that is what the tests are for: no control, a
  lapsed lease, a batch for another stream, or an event outside its bounds all forward nothing
- Everything is checked *before* it crosses the pipe, because the far end runs as SYSTEM and
  has no route back to the client. The bounds live in one place and both paths read them
- The service drops input that arrives after the screen has unlocked, rather than redirecting
  it — it would otherwise land on the operator's own desktop, typing a password into whatever
  has focus
- System combinations are refused with a stated limitation rather than forwarded into silence
- The batch crosses both pipes verbatim, as the JSON the browser sent
- What this gives the operator is a lock screen they can sign in to themselves, with the
  password typed as keystrokes over the encrypted stream — never stored, never logged, and
  indistinguishable to WOLF from any other keystroke. It is **not** remote unlock, and
  `power.unlock` stays unimplemented and refused

**Done — reaching a PC that is already locked**

- `locked` is a fall-through in `RemoteDesktopAvailability` rather than a refusal. It needs
  both halves: a host that can be put on the secure desktop for the pixels, and the user host,
  because that is what holds the connection they travel on. Missing either still reports
  `locked`, and a locked PC with no encoder is still refused for the encoder
- Locking the machine and walking away is the normal thing to do. Refusing that case made the
  whole secure-desktop path reachable only by having predicted needing it
- **The sign-in screen is still refused**, and stated as a limit rather than caution: with
  nobody signed in there is no user host and no peer connection, so the secure host could
  capture the sign-in screen and would have nowhere to send it
- Somebody starting to watch is now an event. Until it existed, the only thing that could
  begin a capture was the desktop *changing* — so a stream begun on an already locked PC would
  have shown the user host's view of a desktop it cannot see: a black picture, no explanation.
  The first viewer starts the capture and the last one stops it; the host stays while the
  screen is locked, because nothing else would start it again
- `stream.state` carries `showing` — `desktop` or `secure-desktop`. The stream does not stop,
  restart or renegotiate when a PC locks, so nothing else in the protocol would say so, and
  the message is published on a change of `showing` alone. An agent that predates the field is
  read as showing the desktop
- The web turns that into a standing notice rather than a badge: what is typed there reaches
  the lock screen and nothing else, and system combinations are refused until sign-in

**Still open in this milestone**
- **None of the secure-desktop path has ever run.** It needs the agent installed as a Windows
  service and a machine whose screen is locked while somebody watches. Every failure carries
  a distinct code, because those messages are what the first person to run it will be reading
  to find out which assumption was wrong. `WOLF_TEST_SECURE_DESKTOP=1` runs the end-to-end
  test in a context that has both. Both ends of the input path do run and are tested for real;
  the relay in the middle — and with it the drop-after-unlock rule — is the part waiting on
  that context, and it is the rule whose failure would be worst
- **Remote unlock is blocked on a Windows constraint, not on effort.** Investigated rather
  than attempted: see [remote unlock](../architecture/remote-unlock.md). There is no Windows
  API that unlocks a session — Winlogon needs credentials LSA accepts — and on a workgroup PC
  the only route that avoids the Windows password is a custom LSA authentication package,
  which lsass will not load without Microsoft-attested signing (`RunAsPPL = 2` is the Windows
  11 default). `power.unlock` stays unimplemented and refused rather than being redefined to
  mean something weaker
- **The elevated half of the helper's tests has never run here.** Reading SMART and opening
  the helper's own pipe both need administrator, and this development session is not
  elevated. The guard logic and the attribute decoding are tested directly and do run; the
  channel tests state that they need elevation and skip. That an unelevated process is
  *refused* the pipe is asserted, and passes for the same reason the others skip

## Milestone 4 — Administration

**Done — the terminal**

- The one feature in WOLF that is arbitrary command execution, built as its own thing for
  exactly that reason. Its own capability, its own exclusive lease, and a separate capability
  again for elevation — none of them implied by any other. A session with `screen` and
  `input` can already type into whatever is on screen and still cannot open a shell, and
  there is an end-to-end test that says so
- A real pseudo console — the ConPTY API — running as the signed-in user in the session host.
  Not SYSTEM, not elevated, not through the privileged helper. Redirecting a shell's stdout
  through a pipe instead would produce a shell that knows it is not on a terminal, which is
  not the shell the operator is there to see
- Shells are **named**, never pathed: `cmd`, `powershell`, `pwsh`, resolved to fixed
  executables by the agent. A caller that could supply a path would turn "give me a shell"
  into "run this program as the signed-in user", before any shell exists to be audited as one
- Terminal traffic rides the data channel and **never reaches the cloud**. The same routing
  as the clipboard with a stronger reason: terminal output routinely carries a connection
  string a script echoed, a token in an environment dump, or a password typed into a prompt
  that was not hiding it. The cloud decides who may open a shell and records that one was
  opened; it never sees a byte of what was typed or printed
- Losing the lease closes every shell the stream had open — the difference between a lease
  and a suggestion. So does the stream ending
- Elevation is refused as a stated limitation rather than served with an unelevated shell
  that claims to be elevated
- What is logged is which shell, which stream, its pid, how many bytes, and how it ended.
  Never content, including in refusals — a refusal that quoted what it refused would put a
  half-typed password in the log of every PC that ever refused one. Asserted by test
- **Two real bugs came out of testing against a real shell rather than a mock.** Without
  `STARTF_USESTDHANDLES` and null standard handles the shell attaches to the pseudo console,
  reports the right size, and writes every byte of its output to the parent's handles where
  nobody will ever see it — invisible from a terminal, because there the parent's handles
  *are* a console. And a shell that exits on its own never produces an end-of-file, because
  conhost outlives its client and keeps the pipe open, so the exit has to be watched for
  separately and the console closed to flush the last line
- The browser side is a **scrollback renderer**, not a terminal emulator, and says so: colour,
  carriage returns, backspace and clear-screen are applied, and anything that paints a
  full-screen interface is reported as unrendered rather than approximated

**Done — the file manager**

- Browsing this PC's disks, and moving files off them and onto them, all on the data channel —
  **contents and names alike**. The rule about contents is written down; a directory listing is
  not innocent either, and a server that never receives one cannot store it, log it, or be
  compelled to produce it
- The agent's own log carries no path either, including in refusals — the easiest place to leak
  one by accident. Tests put a tellingly-named file through a listing, a read and a refusal and
  assert the name appears nowhere
- `file-transfer` is its own capability and `file-operations` its own exclusive lease. Not even
  the terminal capability implies it, and an end-to-end test says so: a terminal could copy a
  file out by other means, which is exactly why the capability is about intent and audit rather
  than about what is theoretically reachable
- **Windows does most of the access control, for free.** The session host runs as the signed-in
  user, so a folder they cannot read is a folder WOLF cannot read — no extra code, nothing to
  get wrong, and no access gained by coming in remotely
- A two-part path gate: a string half tested exhaustively (traversal, `\\?\`, device names at
  any depth, alternate data streams, trailing dots and spaces, wildcards) and a filesystem half
  that follows reparse points and puts the target back through the same rules. Passing the
  first is permission to ask the second, never authorisation to act
- **Network paths are refused deliberately**, and reported as unsupported rather than broken:
  the session host holds the signed-in user's credentials, so browsing a share would let WOLF
  reach machines the operator was never granted, with none of WOLF's audit trail on the far end
- Transfers are offsets rather than a stream, which is what makes them resumable across the
  reconnects a home-internet data channel produces as a matter of course. Every chunk carries a
  SHA-256 and **both ends check** — the agent before anything reaches the disk, because a part
  file with a corrupt middle is indistinguishable from a good one until the end
- Uploads land in a `.wolfpart` file and are renamed into place only after the declared size is
  verified. The rename is the moment the file exists: somebody double-clicking a 40%-complete
  installer is a worse outcome than a transfer they restart
- Everything expensive to get wrong is decided when a transfer *starts* — whether something is
  already there, whether the drive has room, whether the destination is somewhere WOLF writes.
  Overwriting is off by default, and Windows' own folders are refused outright rather than
  confirmed
- A directory listing that hits the cap **says it was truncated**. A folder showing 2000 of its
  40000 files with no indication is one an operator concludes does not hold what they want

**Done — services**

- Listing, starting, stopping, restarting and reconfiguring Windows services, through the
  privileged helper. `ServiceController` covers the first four; start types need `advapi32`
  directly, because `ServiceController` cannot read or set one
- **On the command path rather than the data channel, and deliberately.** The terminal and the
  file manager go peer-to-peer because they carry content no server should hold. A service
  change carries no content — it is a name and a verb — and what matters about it is the
  reverse: risk classification, confirmation, re-authentication, and an audit record. All of
  that lives in the cloud
- **WOLF never creates or deletes a service.** `CreateService` and `DeleteService` are not
  called and no operation reaches them: installing a service is a persistence mechanism, and a
  remote-management tool that can do it is a remote-persistence tool
- `ServiceProtection` refuses outright the services whose loss cannot be undone from the other
  end of a network: WOLF's own, the RPC and COM core, and everything the connection depends on.
  `BFE` earns its place by not looking dangerous — stopping the base filtering engine takes the
  firewall, IPsec and often the network stack with it
- Starting anything is allowed, whatever it is. The asymmetry is the same one the device rules
  make: starting restores function and can be undone by stopping; the reverse is not true
- Disabling is `critical` where stopping is `high`, because it survives a reboot. A service
  stopped by mistake comes back when the machine does; a disabled one does not
- The display name is checked against the live service before anything happens, the way a pid
  is checked against a process name before it is terminated
- Every result reports **the state Windows is in afterwards, never the state that was asked
  for**. A service that was told to stop and did not is the case that exists to be made visible
- `boot` and `system` start types are readable but not settable: they belong to drivers that
  load before the service control manager exists

**Done — scheduled tasks and startup items**

- The other two ways something runs without anybody asking. With services they are the three
  places anybody investigating a machine looks first, which is why the read commands exist and
  why they are audited despite changing nothing
- **WOLF creates neither, and that is the security argument.** A scheduled task and a `Run` key
  are the two mechanisms every piece of Windows malware reaches for. `RegisterTaskDefinition`
  and `DeleteTask` are never called; no operation adds or removes a startup entry. A protection
  list can be incomplete — "there is no code path that registers a task" cannot be, and there is
  a test that walks the helper's operations to prove it
- Disabling a startup entry writes the same `StartupApproved` flag Task Manager writes, so the
  entry survives. An operator can put back what they turned off, and somebody who has taken over
  a session cannot use WOLF to remove the evidence of what was there
- Per-user entries are read from hives already mounted under `HKEY_USERS`, which needs no token
  and covers every user signed in at once. Users who are *not* signed in have no mounted hive
  and are not listed — stated rather than worked around, because loading somebody's hive to read
  it is a much larger thing to do to a machine
- The task scheduler is reached late-bound through `Schedule.Service`: the alternative was
  several hundred lines of `ComImport` interop for six members, each a vtable offset that fails
  silently when wrong. One consequence, caught by the first test that asked for a task that did
  not exist: the binder turns HRESULTs into the nearest .NET exception, so a missing task
  arrives as `FileNotFoundException` rather than `COMException`
- Hidden tasks are listed. A task hidden from the Task Scheduler UI is *more* interesting to
  somebody investigating a machine, not less
- What a task actually runs is in the listing rather than behind a click, because it is the
  first thing anybody reads
- Refusals cover WOLF's own work, and the servicing, recovery and security folders. Enabling and
  running stay allowed everywhere — the same asymmetry the service and device rules make
- Running a task is `high` where enabling one is `medium`: it is not creating anything, but what
  it executes was decided by whoever registered the task rather than by the operator

**Still open in this milestone**
- **Task and startup changes have not been run against a real machine.** They need an elevated
  test host, and a suite that switched off scheduled tasks on whatever machine it happened to
  run on would be worse than an untested path. `WOLF_TEST_AUTORUN_CONTROL=1` cycles one
  third-party task and puts it back. Both enumerations, every refusal, and the missing-task and
  missing-entry paths *are* exercised against the real machine
- **Service start and stop have not been run against a real machine.** They need an elevated
  test host, and a suite that stopped services on whatever machine it happened to run on would
  be a worse idea than an untested path. `WOLF_TEST_SERVICE_CONTROL=1` runs it elevated against
  the print spooler. The read-only half, the refusals, and the path through `advapi32` for start
  types *are* exercised against the real service control manager
- **Delete, rename, move and new folders are not built.** They are mutations with real blast
  radius and belong on the command path, where risk levels and confirmations live; putting them
  on the data channel would route them around the machinery that makes them accountable
- **No search, and no directory transfers.** One file at a time: recursion turns "did that
  work" into a report rather than an answer, and the naive recursive search is a session host
  reading every file on the machine
- **`terminal-admin` is not built.** An elevated shell needs a token the session host does
  not have, which makes it privileged-helper work and a slice of its own
- **A terminal needs a running stream**, because the data channel belongs to one. Opening a
  shell on a PC nobody is watching would need a second channel
- **No terminal grid.** Editors, pagers and in-place progress displays are not rendered
  correctly. Stated in the UI above the output rather than approximated, so an operator
  reading a partial screen knows it is partial
- Network diagnostics, Windows event logs, hardware inventory
- Clipboard sync is done (milestone 2) and is never persisted in cloud history

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

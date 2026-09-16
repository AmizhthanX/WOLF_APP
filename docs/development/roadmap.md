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
- **Delete, rename, move and new folders — since built**, on the data channel by the owner's choice so no file
  name reaches the cloud: delete to the Recycle Bin, nothing overwritten, and a path-free `file.activity` audit
  record for every change. See *Since the milestones* below and [changing files](../architecture/file-manager.md#changing-files)
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
**Done — network diagnostics, event logs and hardware inventory**

- The three questions an operator asks when something is wrong and nothing has crashed: what
  is the network doing, what has Windows been complaining about, and what is inside this
  machine
- All three run in the agent rather than the privileged helper. None needs administrator beyond
  what the agent already is, and the helper exists to keep a *narrow* surface — adding four
  reads to it that do not need its rights would widen it for nothing
- **A network test is not a read, and is classified as an action.** It makes somebody else's
  machine send packets to a destination the operator chose. WOLF does not try to tell a
  legitimate destination from an illegitimate one, because it cannot: "can this PC reach the
  file server" and "can this PC reach the internet" are the two most common diagnostics there
  are, and a rule blocking private or public ranges would break one of them
- What is bounded is the **shape**, not the destination: one host per command, never a range or
  a list; a handful of packets; one port, never a range — a port range is a port scan with a
  different name; and a short timeout. Broadcast and multicast are refused outright, because
  one packet to either reaches every listener on a segment
- A name that *resolves* to a multicast address is caught after resolution. A name is not a
  shape, and that is the case a string check cannot catch
- Every test is audited with its target recorded. The bounds stop a sweep; the trail catches
  somebody assembling one out of many commands
- **Event log text is the one diagnostic read whose content crosses the cloud**, and it is
  written down rather than discovered. An event message can carry an account name, a command
  line, or — from software that should know better — a credential. Bounded rather than blocked:
  a count, a window, a level, and a cap on each message
- The Security log is included, deliberately. It is the most sensitive and the one an
  investigation actually needs; leaving it out would mean WOLF can tell you a machine was
  compromised but not by whom. It is escalated past the other logs so the confirmation says
  what is being opened, and an agent without the rights reports that rather than failing
- The event log query is built from numbers and names checked against fixed lists; the only
  operator string that reaches XPath is the provider, quote-escaped. An XPath concatenated from
  network input would be an injection surface into a SYSTEM process
- Hardware inventory leaves serial numbers out unless asked for, and says which it did — a
  blank field then reads as "not asked for" rather than "not there". They are what an inventory
  is *for*, and also a stable identifier for a physical object
- A missing WMI class is ordinary: a virtual machine with no `Win32_PhysicalMemory`, a server
  with no monitors. Each query fails on its own rather than taking the inventory with it

**Everything milestone 4 set out to build is built.** What remains from it is listed under
"still open" above: `terminal-admin`, the file manager's destructive operations, and the
elevated test runs that several of these paths are waiting on. Clipboard sync landed in
milestone 2 and is never persisted in cloud history.

## Milestone 5 — Intelligence

**Done — telemetry rollups and the aggregation job**

- An agent produces a sample every few seconds. Kept forever that is unbounded growth on
  somebody else's bill and useless besides: nobody asks what the CPU was doing at 14:03:07 last
  March, they ask whether it has been getting worse. Raw samples live for days, five-minute
  buckets for a month, hourly for six, daily for a year
- **The rollup cascades — 5m from raw, 1h from 5m, 1d from 1h — rather than computing every
  resolution from raw.** Raw samples are dropped after a couple of days, so an hourly bucket
  recomputed from raw after that would come back empty and overwrite a good value with nothing.
  Every resolution is built from one that outlives it
- The arithmetic is pure and lives in `@wolf/telemetry-schema`, so the correctness — which is
  the whole feature, because a chart that is subtly wrong is worse than one that is missing —
  is tested without a database anywhere near it
- **The merged p95 is honest about what it is.** A percentile cannot be recovered from
  summaries of its parts; reconstructing one needs every original value, which is the thing
  being thrown away. What is stored is the largest contributing p95 — the worst five-minute
  spike in the hour — and the module says so, because a number that is quietly a different
  statistic from the one its column is named after is worse than a missing one
- Means are weighted by sample count. An unweighted mean of means lets a bucket with three
  samples count as much as one with three hundred, which is what happens when an agent is
  restarted mid-hour
- The job is idempotent, resumable without a cursor, and bounded. Every write is an upsert of a
  value computed only from its inputs, so two API instances doing it at once is not a problem
  and needs no leader election. Where to resume is derived from what is already written, so a
  crash between writing a bucket and advancing a cursor cannot lose a window
- Retention is enforced here rather than by a database job: raw by dropping whole partitions,
  aggregates by delete. It is a promise the product makes about somebody's data, and a promise
  kept by a cron entry nobody can see from the code is one that quietly stops being kept

**Three real bugs, all found by the tests rather than in production**

- The cascade began at the *newest* finer bucket instead of the oldest, which silently lost
  the beginning of a machine's history — the kind of wrong nobody notices until they go looking
  for last Tuesday
- The raw sample window was inclusive at both ends while the aggregate window was half-open, so
  a sample landing exactly on a boundary was counted in two buckets. Caught by a test that
  asked for two buckets and got three
- A bounded pass finalised a coarse bucket from a partial finer one and never came back: the
  first run rolled eight hours of five-minute buckets, built a *day* out of those eight hours,
  and the daily watermark then sat past the day for ever. A cascade bucket is now eligible only
  when the resolution beneath it covers all of it

**Done — alert rules and the in-app inbox**

- Rules ask about a metric staying above or below a line for a window, or a PC being offline for
  one; on one PC or on every PC, including ones enrolled later. Evaluated once a minute in every
  API instance. See [alerts](../architecture/alerts.md)
- **Three verdicts, not two.** Breaching, clear, or unknown — and unknown never moves an alert.
  Treating "no data" as "fine" resolves an alert at the moment a machine stops reporting, which
  is exactly when somebody needs it. An alert about a disk that vanished stays firing
- "Sustained" means every reading in the window, and the window must actually have been
  observed: samples reaching back across 90% of it, nothing stale at the end, and no hole in the
  middle wider than a tenth of it
- Told once, not every minute; a cooldown keeps a metric hovering at its threshold from flooding
  the inbox; a firing suppressed by the cooldown recovers silently rather than announcing "back
  to normal" about something the owner never heard was wrong
- **Two instances cannot both notify.** State changes are compare-and-set on the state and when
  it changed, in the same transaction as the notification; whichever instance's change lands
  writes it
- Long windows are judged from the five-minute bucket minimums (maximums for below rules) plus the
  raw tail, which is exact rather than approximate, instead of reading seventeen thousand raw
  samples a day per rule per minute
- Rule changes are audited under `automation`; editing a rule clears its state, because the old
  answers were to a different question
- **In-app only, at first.** Push has since arrived with Android, content-free; webhooks have since arrived
  with the egress controls they needed (see *Since the milestones*); e-mail still needs a provider and its secrets

**A real bug found on the way, in the previous slice**

- The rollup suite used a fixed clock of 10 September while telemetry partitions are created
  around the wall clock. It passed the day it was written and failed four days later with "no
  partition found for row". The suite now creates the days it writes to

**Done — GPU, process and storage intelligence**

- **The agent now measures what it only claimed not to.** Before this, every sample carried an empty
  GPU list, every drive was "unknown" and every process's CPU was null. See
  [insights](../architecture/insights.md)
- GPUs from the display kernel — plain structs, no COM, no device created just to ask a name —
  with load from the GPU Engine counters computed by Task Manager's rules, so the two agree on the
  same machine. Software renderers and virtual displays are left out
- **A GPU's id is its PCI location, not its LUID.** Windows assigns a new LUID every boot; a series
  key that changed on restart would have broken every GPU chart and every alert rule narrowed to one
- The process list measures CPU and GPU over a real interval — half a second on a first look, since
  the previous list otherwise — and matches PIDs on start time so a reused PID is never differenced
  against the process that had it. A process new to the GPU is unknown, not idle
- Drive health is Windows' own verdict per volume, cached for five minutes; temperature needs the
  rights the agent service has
- **Insights are computed on request and never stored.** A straight line through a month of hourly
  usage gives a fill date, with the history it rests on and how well the line fits; nothing is
  forecast from under three days. A day of GPU buckets gives load, the busiest five minutes, peak
  memory and heat. Findings are fixed templates over numbers, a failing drive ranked above a
  filling one
- **Nothing about processes reaches the cloud.** Process-level insight lives in the live list on the
  PC; the cloud's findings are about drives and GPUs only
- Clock speeds, fan and GPU power in watts stay null: the display kernel reports power as a share of
  the limit and fan in RPM, which are not what those fields mean

**Done — the automation engine: triggers, conditions, actions, cooldowns**

- When a schedule comes round, an alert fires or resolves, or the owner presses "Run now" — and
  nobody is connected, the machine is idle, it is inside a time window — notify, or run one of four
  commands on chosen PCs. See [automations](../architecture/automations.md)
- **Saving an automation is authorizing it.** The same policy as a command sent by hand, applied once,
  at the moment of decision: the confirmed risk level must equal the server's, and a high-risk
  automation needs the password. **Critical actions can never be automated** — they need a single-use
  grant per action, and an automation would turn that into a standing permission. Refused by the
  schema, the API, the engine and a database check
- **Authority belongs to a device.** Revoking the device an automation was saved from turns it off in
  the same transaction; a run that finds its device revoked turns itself off and tells the owner.
  Actions are classified again at every run, so an upgrade that makes one riskier stops the
  automations using it
- A separate, unattended dispatch path onto the ordinary command pipeline, so nothing about it can
  loosen the interactive one. It never queues for an offline PC, never takes power control from a
  connected session, and dates the confirmation to when it was actually given
- Actions run in order and wait for each command's result; the first failure skips the rest
- **Nothing runs twice, and nothing runs late.** A scheduled minute is claimed by its local date and
  time, an alert event in the transaction that created it, a cooldown by compare-and-set, the daily
  limit under a row lock. Schedules are due for five minutes, events for five, and a run whose API
  instance died is marked interrupted rather than finished an hour later. Daylight saving follows the
  wall clock: a skipped time does not run, a repeated one runs once
- Only `power.action`, `service.control`, `task.control` and `startup.set-enabled` are automatable.
  Nothing that names a PID, and nothing the agent does not implement — `process.start` was on the
  first draft of the list and came off it for that reason

**Done — configuration backup and restore**

- PC names and tags, remote desktop profiles, alert rules and automations, in a file the owner keeps
  and back. See [configuration backup](../architecture/configuration-backup.md)
- **A backup grants nothing.** No password hash, token, key, enrollment token or recorded authority,
  asserted by a test that looks for them in the file. Built on request and handed to the browser;
  the cloud keeps no copy
- **A checksum, not a signature, and the docs say which.** It catches a damaged or edited file. What
  protects a restore is that every item is validated against the schema it was first saved with, so
  a doctored automation carrying a critical action is refused as it would be from the API
- **Restoring is not a way round authorization.** Automations come back turned off unless the owner
  confirms turning them on at the risk of the riskiest one — with a password if that is high — and
  their authority is re-recorded from the restoring device. Every restore is at least a medium
  confirmation, because it replaces configuration wholesale
- Sections replace in one transaction, keeping ids so run history and notifications stay attached;
  a rule about a PC that is gone is not widened to every PC; two swapped PC names do not trip the
  uniqueness constraint halfway
- A shared confirm-and-password hook now serves both automations and restore

**Milestone 5 is complete.** Every item it set out to build is built: rollups, alerts, GPU, process
and storage intelligence, automations, and configuration backup.

## Since the milestones

**Done — Wake-on-LAN** ([Wake-on-LAN](../architecture/wake-on-lan.md))

- A PC reports its wired adapter and whether Windows armed it, without administrator; the address is stored and
  never returned. `power.wake` goes to another online PC, the API fills in the reported address, and the agent
  broadcasts the magic packet on its own networks. Web and Android offer Wake on an offline PC.
- Proven live with the real agent (six packets sent and received on udp/9). **Not proven:** a real sleeping PC
  waking — see Part 3 of the [owner guide](owner-guide.md).

**Done — webhooks** ([webhooks](../architecture/webhooks.md))

- Signed HTTPS requests to public addresses only, the connection pinned to the checked address, no redirects,
  the URL encrypted at rest and never returned; WOLF, Slack and Discord formats; retries and turning off after
  twenty failures. Web settings page and the Android Alerts screen.
- **Not proven:** a delivery to a real third-party service — Part 2e of the owner guide.

**Done — resumable transfers, and changing files** ([the file manager](../architecture/file-manager.md))

- An interrupted upload's part file waits 30 minutes for a new stream; downloads resume onto what arrived; a
  whole-file checksum keeps a mismatched resume out of place. Proven live over three streams.
- Delete (to the Recycle Bin), rename, move and new folder on the data channel, audited without paths. Proven
  live from the emulator to the real agent.

**Owner steps** — accounts, a second PC, administrator runs and deployment — are in the
[owner guide](owner-guide.md).

## Web dashboard — device proof-of-possession

**Done**

- At sign-in the browser makes an ECDSA P-256 key with WebCrypto, its private half non-extractable, kept in
  IndexedDB, and registers the public half. The broker refuses a dashboard sign-in without one; the API refuses any
  registered key that is not a P-256 SPKI, where before a malformed key would have surfaced as a "stolen token"
- The page never holds the refresh token, so it signs the token's binding — a labelled SHA-256 the broker hands out
  and the API recomputes — with its device id and the time (`webRefreshProofPayload`). Which payload a device signs
  is fixed by its recorded kind: a browser key cannot satisfy the phone rule, nor a phone key the browser's. The
  Android rule is unchanged
- Every tab refreshes under one Web Lock. A binding gone stale because another tab rotated the token is a 409 retry
  at the broker and is never forwarded, so a race is not answered as a theft
- A lost key — site data cleared, storage evicted — ends the sign-in as a sign-out with reason `device-key-lost` on
  the audit record, the sign-in page says why, and the next sign-in is a new device. Nothing falls back to an unsigned
  refresh. A browser that cannot keep a key is refused before the password is sent; a sign-in from before keys is
  ended at its next refresh
- A wrong device clock or an unreachable API now leaves the sign-in intact and is shown with a retry; the broker used
  to clear the cookie on any failed refresh
- Proven: protocol tests pinning the web payload and binding bytes; the WebCrypto key, DER conversion and storage
  failures under Node's WebCrypto; the page's session code and the broker end to end against the real API over HTTP —
  tabs refreshing at once, a rotation racing a signature, a copied cookie with no key and with a foreign key, a lost
  key, a wrong clock, a pre-key sign-in; the web variant through the API's own e2e suite; every broker route checking
  CSRF first; `next build`. In a real Chromium, the device-key harness page: one key from five concurrent creations
  under Web Locks, the key kept across a reload, export refused, the signature accepted by the API's verifier, and the
  loss noticed after clearing storage. The same page, all seven steps, in Firefox 155 in a normal window and one opened
  with `-private-window`, and in LibreWolf 154 (Firefox with its privacy defaults), each on a fresh profile
- **Not driven:** Safari or any WebKit (not available on the Windows machine this was built on), Safari's seven-day
  storage eviction, and the full dashboard signed in to a running API in a browser

## Android

Kotlin and Jetpack Compose, native WebRTC, platform keystore for tokens and device
identity, signed APK through CI. See [the Android client](../architecture/android.md).

**Done — first slice: sign-in, PCs and live metrics**

- A Keystore ECDSA P-256 identity key — the curve the server and the agent already use — in StrongBox
  where there is one, created with no way to read it back; its encoding pinned to the server's by test
- The refresh token encrypted under a Keystore AES-GCM key in the no-backup directory, backups turned
  off; the access token in memory only
- **One refresh for many callers.** Refresh tokens rotate and a reused one revokes the family, so eight
  concurrent calls with an expired token must produce exactly one refresh — tested against a mock server
  that behaves that way. Only a refused refresh signs out; being offline does not
- TLS with system trust anchors only in release; cleartext only to the emulator's host alias, only in
  debug. Screenshots and screen recording blocked
- Proven against the real API, not only a model of it: a gated instrumented test signs in with the
  Keystore key against a local cloud, restores after a relaunch and confirms sign-out revokes the token
- **A build finding:** the Android Gradle plugin compiles Java through a `jlink`-built JDK image, and no
  JDK on the development machine was both new enough to have `jlink` and old enough for the plugin. The
  app's only Java was generated `BuildConfig`, so it is gone — per-build-type values are Kotlin — and the
  build runs on any JDK 21–25 runtime

**Done — commands: power and processes, with the confirmation ladder**

- A PC session opened only when a command needs one, asking for `processes` and `power` alone
- The web client's escalation rules exactly: the server names the risk, medium confirms, high re-enters
  the password and re-issues the session token, critical adds a single-use grant, the same idempotency
  key throughout, and the phone never escalating by itself
- **A wrong password counts once.** The generic 401-refresh-retry would have sent it twice against the
  lockout; re-authentication bypasses it, and a test holds that
- Power actions never forced; process termination carries the expected name

**Done — remote desktop on the phone**

- libwebrtc on Android (the WebRTC SDK build, BSD-3-Clause) against the same relay and session host as
  the browser: a separate PC session with `screen` and `input` only, the session token in the first
  message rather than the URL, the PC offering and the phone answering
- Viewing by default; control requested from the relay and renewed while held. Tap, long press and drag
  become left click, right click and left drag; a text field and a row of keys become keyboard input
- Touch normalised against the letterboxed picture, and a touch on the bars dropped rather than clamped
- The phone claims only the codecs its decoders report — no H.264 floor, since libwebrtc on Android has
  no software H.264 decoder
- **A finding from the first real stream:** the emulator decodes Constrained Baseline only, the PC sent
  High 5.1, and libwebrtc rejected the video. Clients now state their H.264 profiles
  (`h264Profiles`, protocol), the session host encodes the best one listed, and a rejected video answer
  fails as `codec-unsupported` rather than connecting to a black screen
- Proven live: the development PC streamed to the emulator at 2560×1440, control was granted, and a
  pointer move landed at exactly (0.25, 0.25) of the PC's screen, read back on the PC

**Done — alerts and automations**

- The inbox, alert rules and automations on the phone, with the unread count on the PC list; lists
  refreshed while their screen is open and never in the background
- A rule and automation builder that applies the protocol's bounds before sending, and never forces a
  power action; notify and power actions on the phone, the other automatable commands shown and built on
  the web
- **Saving is authorizing.** The web client's authority flow: the server names the level, medium
  confirms, high re-enters the password once, and a critical action is a refusal rather than a dialog
- Kinds the app does not model are listed by name instead of dropped
- Proven against the real API and agent: rules in both shapes, a notify automation run by hand into the
  inbox, a high-risk save that asks for the password

**Done — configuration backup and restore**

- Backup saved to a file the owner picks in the system document picker — no storage permission, no copy
  kept by the app or the cloud — fetched before the picker opens, so a failure leaves no empty file
- The server's JSON kept as JSON and written back value for value, so the checksum still covers it
- Restore with sections, a preview of what will change, and the server-named confirmation; the phone
  checks size and format and leaves the checksum and every item to the server
- Proven against the real API through the real document store: back up, delete a rule, restore it from
  the file with its id; an edited copy refused

**Done — services, scheduled tasks and startup items**

- Services and Tasks & startup screens off the PC screen: list, filter, start, stop, restart, start type;
  run, enable and disable tasks; enable and disable startup items. Protected entries and Windows' own
  refusals shown before anybody tries; refusals made on purpose reported as notices
- Commands built from the listed rows and held to the protocol's name and path rules before sending,
  through the server-named confirmation ladder; a PC session that now asks for `services` and
  `configuration` as well
- An empty list with the helper's reason shown as that reason, never as "nothing"
- **Automations choose services, tasks and startup items from a PC's own list** over a short read-only
  session, instead of typed names — the gap left by the alerts and automations slice
- Proven live: the lists read from the real agent (reporting, honestly, that its helper is not running),
  six changes classified by the server and none confirmed, a phone-built service action saved into an
  automation that cannot run
- **A finding from the first command the phone sent to a real agent: the local cloud never delivered
  commands.** Deployed, the API's `pg_notify` wakes the realtime service's Postgres `LISTEN`; the local
  cloud runs PGlite, which that listener cannot connect to, and nothing else listened. Every command
  through `npm run dev:cloud` — from the phone or the browser — waited forever. The test database now has an
  in-process `listen`, and the local cloud subscribes the same channels with the same sweep; the API's
  path is unchanged

**Done — the file manager**

- Browse, fetch and send on the remote desktop screen, over the stream's data channel: no server sees a
  name or a byte. Its own lease, requested and renewed, and nothing sent without it
- Fetched files go into a document the owner picks, every chunk verified before it is written, and the
  document removed if the file does not arrive whole; sent files never overwrite, are checked end to end
  against the PC's whole-file checksum, and are cancelled on the PC — part file and all — when stopped
- Every request answered exactly once: matched by id, timed out, or ended with the stream
- **A finding from the first live run:** the file lease can be granted while the PC's data channel is still
  opening. Requests now wait for the channel, bounded by their timeout
- Proven live: 200 KB sent to the development PC and fetched back identical, refusals with reasons, a stopped
  upload leaving nothing

**Done — push notifications, with nothing in them**

- A content-free wake-up through Firebase Cloud Messaging — no PC name, alert or count reaches Google; the
  phone fetches the news from WOLF over its own sign-in and posts it private on the lock screen
  ([push](../architecture/push.md))
- Behind the cloud-provider interface: an FCM adapter with a service-account JWT signed by Node's own
  crypto, no Google client library; `WOLF_PUSH_PROVIDER=none` by default, and "not set up" said as such
  on the phone rather than pretended
- A push job decoupled from alerting: notifications claimed at most once across instances, nothing sent
  for news older than fifteen minutes or for history, dead tokens forgotten unless replaced
- One token per device, registered only by that device, cleared at sign-out and in the revocation
  transaction, never returned or audited
- Proven: the adapter against a local stand-in for Google's token endpoint and FCM, the job against a real
  Postgres engine, the routes; live, a real notification fetched on a wake-up and posted privately on the
  emulator. **Not proven: Google's delivery**, which needs a Firebase project this repository does not have

**Done — remote desktop: sound, clipboard, displays, scroll and zoom**

- Sound when the owner asks for it, played as media, with Mute only when the PC actually sent audio and the
  PC's reason shown when it did not; no microphone permission, no local audio track
- The clipboard both ways on the data channel, text only, one tap each way: the phone's clipboard read only
  when the owner sends it, the PC's text offered as a length and copied to the phone marked sensitive, 256 KB
  refused whole
- The PC's displays from `remote-desktop.list-displays`, and a switch in place that keeps the stream — and
  control — running
- Two-finger scroll and pinch zoom in one gesture handler, every touch taken back through the zoom
- Proven live: Opus from the development PC (about 270 packets in five seconds), the display list, the
  clipboard round trip with the PC's own clipboard saved and restored, and asking for the shown display
  changing nothing. **Not proven: a real display switch** — that PC has one monitor
- **A finding from the first live run, on the PC's side:** on a still desktop the session host sends no frame
  for many seconds, and a requested key frame is only encoded with the next captured frame, so a first key
  frame the network damages is not replaced until the screen changes. On the emulator that lost the 2560×1440
  picture every time; the live test uses the mobile-data profile, and the session host fix is tracked
  separately. It was chased first as a sound bug: a loopback test of picture loss with sound on — which passes,
  and stays — ruled that out, and the same failure without sound confirmed it

**Done — release signing and distribution**

- Release signing from the environment only; a release without its key refuses to package and names every
  variable the pipeline must provide — no unsigned or debug-signed fallback
- CI builds the app on every push with no key: JVM tests, a debug build, and R8 over the release build
- A tag-triggered release workflow: signing secrets in a reviewer-gated environment, the version code derived from
  the version, the key decoded to the runner's temporary directory and deleted, a GitHub release with the APK,
  `SHA256SUMS` and the certificate fingerprint; the app bundle and R8 mapping kept with the run
- **A release gate** (`scripts/verify-android-release.mjs`, tested): v2+ signature, one signer, no debug
  certificate, not debuggable, the expected version, and only the permissions WOLF chose — a dependency that adds
  an advertising id or a microphone fails the release
- Proven here, not in CI: the first minified release ever built, signed with a throwaway key, passed the gate,
  installed on the emulator, launched to the sign-in screen with no crash, and took an update signed with the
  same key. The workflows parse, but have never run — the repository has no GitHub remote yet. A release build was
  not signed in to a real API, so R8's keep rules for serialization are proven by startup only
- **A finding from inspecting the release:** Android allows other apps to capture an app's audio playback by
  default, so an app with the owner's screen-capture grant could have recorded the PC's sound. The window was
  already `FLAG_SECURE`; audio playback capture is now off as well, checked on the installed package

**Done — app lock**

- Opt-in, changed only through the system prompt: a strong biometric or the screen lock
- It locks the sign-in itself: the vault sealed with a fresh AES key per write, wrapped under a Keystore RSA key whose
  private half opens only after the owner authenticates. Writing needs only the public half, so rotated refresh
  tokens are stored while locked; reading needs the owner
- Locked, the session sends nothing and says `auth.locked`; unlocked, credentials are held in memory and dropped when
  the process ends or after five minutes in the background. A wake-up while locked fetches nothing and posts a
  generic notice
- A screen lock removed or reset destroys the key: signed out, the lock turned off, the owner told why — never a crash
  or a silent downgrade
- Proven: the vault, session and wake-up behaviour on the JVM; on the emulator with a throwaway PIN, the real Keystore
  key refusing a read as locked, opening after the lock-screen credential was verified, taking a token rotated while
  shut, and losing the sign-in cleanly when the PIN was removed; the real app relaunched to the system prompt and, the
  prompt dismissed, to the locked screen. **Not driven:** completing the prompt, and a fingerprint

**Done — device proof-of-possession on refresh**

- Every refresh from the phone is signed with its Keystore identity key: the device id, that exact refresh token,
  and the time. No server nonce: rotation already makes each token single-use
- The server requires it of any device that registered a key. Missing or signed by another key: the family revoked,
  the device's sessions ended, a `device-proof-failure` security event with no token in it. A correct signature by a
  clock more than five minutes off: `auth.device_clock`, a 400, nothing revoked — and the phone keeps its sign-in
- A sign-in naming a key-bound device's id with a different key makes a new device instead of rebinding it
- One payload builder in the protocol and one on the phone, pinned to the same bytes in both test suites
- Proven: end-to-end tests through the real HTTP app; the phone's refreshes checked by a mock server enforcing the
  rule; and live, a Keystore signature accepted by the real server's verifier, a wrong clock refused without revoking,
  and an unsigned refresh revoking the device's tokens
- **Found on the way:** the security model said the web client registers a key. It does not — its login sends
  none — so its refreshes are not asked for a proof, and the docs now say so rather than implying otherwise. Since
  closed: see *Web dashboard — device proof-of-possession*

**Still open for Android**
- Push: an end-to-end delivery through a real Firebase project (owner guide, Part 4)
- Files: browsing without a stream (as on the web); resuming after the app process has ended
- Changing services, tasks and startup items against a machine with the privileged helper installed
- Remote desktop: a display switch on a two-monitor PC (owner guide, Part 9)
- The release pipeline run on GitHub (owner guide, Parts 5–6); Google Play publishing; per-ABI APKs

## Infrastructure

- Terraform for GCP, behind the cloud-provider interface
- Staging and production pipelines with migrations and rollback
- Signed agent packages, staged rollout, health check, and rollback on failure

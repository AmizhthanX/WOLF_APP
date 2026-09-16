# Android client

Kotlin and Jetpack Compose, in `apps/android`. Built so far: sign-in, the PC list, live metrics,
commands — power actions and the process list — with the same confirmation ladder as the web client, and
remote desktop over WebRTC — touch, scroll and zoom, sound, the clipboard and display choice — the file manager, services, scheduled tasks and startup items,
alert rules, the notification inbox and automations, configuration backup and restore, and push
notifications that carry nothing through Google.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| API client | `api/WolfApi.kt`, `api/Models.kt` | Typed calls; the WOLF error envelope; no token state |
| Session | `session/SessionManager.kt` | The only code that touches account tokens: sign-in, refresh, sign-out |
| PC session | `session/PcSessionController.kt` | A remote session on one PC; commands and their confirmation |
| Token vault | `security/TokenVault.kt` | The refresh token at rest, AES-GCM under a Keystore key |
| App lock | `security/AppLock.kt`, `MainActivity.kt` (the prompt) | A Keystore key only the owner's fingerprint or screen lock opens; the vault sealed to need nobody to write and the owner to read |
| Device identity | `security/DeviceIdentity.kt` | ECDSA P-256 key in the Android Keystore |
| Stream session | `remote/StreamSession.kt` | Signaling and the stream's state machine; no Android types, so JVM-tested |
| WebRTC | `remote/WebRtcAndroid.kt` | libwebrtc peer connection, decoders, the signaling socket |
| Input | `remote/InputEvents.kt` | Touch to normalised coordinates; WOLF input events |
| Zoom and gestures | `remote/Viewport.kt`, `ui/RemoteDesktopExtras.kt` | Pinch zoom, pan and two-finger scroll, taken back through the zoom to the PC's coordinates |
| Displays, clipboard | `remote/Displays.kt`, `storage/PhoneClipboard.kt` | The PC's display list; the phone's clipboard, touched only on a tap |
| Remote desktop | `remote/RemoteDesktopController.kt`, `ui/RemoteDesktopScreen.kt` | Its own PC session, renderer and gestures |
| Alerts, automations | `api/AlertModels.kt`, `api/Automations.kt` | Rule and automation shapes, built within the protocol's bounds, and described |
| Account authority | `session/AccountAuthority.kt` | Confirmation and password re-entry for decisions saved rather than sent |
| Alerts UI | `ui/AlertsAutomationsViewModel.kt`, `ui/AlertsScreen.kt`, `ui/AutomationsScreen.kt` | Inbox, rules, automations and their runs |
| Configuration backup | `api/ConfigurationBackup.kt`, `storage/Documents.kt`, `ui/ConfigurationViewModel.kt`, `ui/ConfigurationScreen.kt` | The backup file, the system document picker, restore |
| What runs on a PC | `api/CommandModels.kt` (`Commands`, `PcTools`), `ui/PcToolsScreens.kt` | Services, scheduled tasks and startup items |
| Files | `remote/FileTransfer.kt`, `ui/FilesPanel.kt`, `storage/Documents.kt` | Browse, fetch and send over the stream's data channel |
| Push | `push/PushRegistrar.kt`, `push/WakeHandler.kt`, `push/AndroidPush.kt`, `push/WolfMessagingService.kt` | Registration, a wake-up turned into notifications fetched from WOLF |
| UI | `ui/`, `MainActivity.kt` | Sign-in, PCs, live metrics |
| Endpoint | `src/debug/…/ApiEndpoint.kt`, `src/release/…/ApiEndpoint.kt` | API and relay addresses per build type |

## Tokens

| Token | Where it lives on the phone |
| --- | --- |
| Access | Process memory only. Gone when the process is |
| Refresh | `noBackupFilesDir/credentials.bin`, AES-256-GCM under a Keystore key the app can use and not read |

- **A 401 refreshes once and retries once.** More would turn a revoked device into a loop.
- **Concurrent calls share one refresh.** Refresh tokens rotate and a reused one revokes the whole
  family, so parallel refreshes would sign the phone out. A test fires eight calls with an expired
  token and asserts one refresh.
- **Only a 401 from refresh signs out.** A launch with no network keeps the credentials.
- Anything in the vault that does not decrypt — another install's file, a Keystore key wiped when the
  lock screen changed, a flipped bit — reads as signed out and is deleted.
- Backups are off (`allowBackup=false`, every domain excluded from cloud backup and device transfer),
  and the vault is in the no-backup directory besides. A restored copy would only be a broken sign-in
  that looked like a working one, since the Keystore key does not travel.

## App lock

Off until the owner turns it on from the PC list, through the system prompt — and turned off only through it.

- **It locks the sign-in, not only the screen.** With the lock on, the vault is sealed by `HybridLockCipher`: a
  fresh AES-256 key for every write, wrapped with an RSA key in the Android Keystore whose private half opens for 30
  seconds after a fingerprint or face of the strong class, or the screen lock's PIN, pattern or password. Writing needs
  only the public half, so a refresh token the server rotates is stored when it arrives, in the background too.
- **Locked is not lost.** A read without the owner is a `VaultLockedException`, and the sealed sign-in stays. The
  session is `Locked`: nothing is sent, and a call that would need a token fails with `auth.locked` instead of
  refreshing.
- **Once unlocked, the credentials are held in memory**, so refreshing goes on while WOLF is in use. They are dropped
  when the process ends and after five minutes in the background — checked when WOLF comes back and before any call
  made from the background, so a wake-up does not outlast the lock.
- **A wake-up while locked fetches nothing.** It posts one notification, "Something may be new. Unlock WOLF to see
  it.", private on the lock screen like every other.
- **Removing or resetting the screen lock destroys the key**, so nobody can open that sign-in again. It reads as
  signed out, the lock turns itself off rather than failing the next sign-in, and the owner is told why.
- **The prompt** is AndroidX Biometric's: a strong biometric or the screen lock on Android 11 and later. Android 9 and
  10 cannot offer the screen lock beside a strong biometric, so there it sits beside a weak one; a weak biometric does
  not open the Keystore key, and the unlock says so and asks again.

What it does not do: protect a phone handed over, unlocked, within five minutes of using WOLF, or one whose screen
lock the person holding it knows. There is no sign-out on the locked screen — revoking the sign-in on the server needs
the token, so the owner unlocks first, or revokes the phone from the web dashboard.

## Commands

A command is sent with a **session token** — scoped to one PC and to the capabilities the session was
granted — never with the account token. The session is opened the first time a command needs one
rather than when a PC is looked at, because reading metrics does not need a session and every session
is audited. It asks for `processes`, `power`, `services` (services and scheduled tasks) and
`configuration` (startup items), and nothing else; remote desktop opens its own session.

The confirmation ladder is the web client's, rule for rule:

1. Send with no confirmation. Accepted means low risk.
2. Refused for confirmation: the **server** names the risk level, and that level is what the owner is
   asked about. Nothing on the phone guesses it.
3. Medium: an explicit yes. High: the password as well; the session token is then re-issued so it
   carries the fresh sign-in time. Critical: both, plus a single-use privileged grant requested with
   that session token.
4. Resent at the named level with the **same idempotency key**, so a retried request cannot run the
   command twice. If the server now names a higher level, the owner is asked again; the phone never
   climbs the ladder by itself.

**A wrong password is tried once.** Re-authentication answers a wrong password with 401, and the
session manager's usual "401 means refresh and retry" would count one typo twice against the account
lockout — so password re-entry goes through a call with no retry. A test asserts one attempt, no refresh
and no command.

Power actions are never sent forced (forcing is critical and closes unsaved work). Terminating a process
carries the name as well as the PID, so a recycled PID is refused by the agent. Protected system
processes show no terminate button, and the server would classify them critical if asked.

## Remote desktop

The web client's protocol, spoken by a second implementation — which is the point of building it: the
relay and the session host are held to the protocol rather than to one client's habits.

1. A **separate PC session** asking for `screen`, `audio`, `input`, `clipboard` and `file-transfer`, and nothing
   else. Commands keep their own session; a viewer does not carry `power`. Holding a capability is not using
   it, as on the web: sound only when asked for, clipboard text only on a tap, control and files each a lease.
2. The relay socket (`/client`), authenticated with that session token in the first message. The token
   never goes in the URL, where proxies log it.
3. `stream.request` with the Wi-Fi or mobile-data profile, the codecs the phone's decoders **report** and
   the H.264 profiles those decoders take. No codec is assumed: without a hardware H.264 decoder,
   libwebrtc on Android has none at all, so the web client's "every browser decodes H.264" floor would
   be a lie here.
4. The PC offers; the phone answers. The PC creates the data channel.
5. **Control is asked for, not taken.** Viewing is the default. "Take control" sends `input.request`; the
   relay's `input.control` grants it, and the grant is renewed every 45 seconds while held. Touch does
   nothing until then.

Gestures, once in control: a tap is a left click, a long press a right click, a drag a left-button drag,
**two fingers moving together scroll the PC** — fingers up scroll down, as a phone does — and a **pinch zooms
the picture on the phone**, up to four times, around the fingers. Without control a pinch still zooms and a
drag moves around the zoomed picture, and nothing reaches the PC. Whether two fingers are a pinch or a scroll
is decided once, as they pass the touch slop, and kept until they lift. All of it is one gesture handler
(`ui/RemoteDesktopExtras.kt`), so no two detectors fight over a finger; the geometry (`remote/Viewport.kt`) has
no Android types and is tested on the JVM. Zoom is the phone's own view: the PC keeps sending the same frames,
and a picture of a new size — another display — goes back to fitting.

A text field sends `text` events (split under the protocol's limit without cutting a character in two), with
buttons for Enter, Backspace, Escape and Tab and one-notch scroll buttons. Coordinates are normalised against
the **picture**, not the view, and taken back through the zoom first — the picture is letterboxed to fit, and a
touch on the black bars is dropped rather than moved to the nearest edge, where it would click something the
owner did not touch.

**Sound.** "Play the PC's sound" on the PC screen, off by default, sends `requestAudio`; the session holds
`audio`, and the PC decides. The screen offers Mute only when the negotiation carries an audio codec — never a
speaker button over silence — and shows the PC's adjustment when it gave none ("not granted", "no audio
output"). Playback is as media, not as a voice call, through libwebrtc's audio device module; the app has no
microphone permission and never creates a local audio track.

**Displays.** `remote-desktop.list-displays` (low risk, under `screen`) is sent when the stream starts; with
more than one display, a picker switches with `stream.set-display`, in place. The PC answers a switch with a
fresh `stream.ready`, which updates the labels and the picture's size without leaving the streaming phase —
going back to "preparing" would take control away from a stream that has it. Asking for the display already
shown is not a switch, and the PC answers nothing.

**Clipboard.** Text only, both ways on the data channel, never through the cloud. "Send this phone's clipboard
to the PC" reads the phone's clipboard on that tap — Android shows the owner that it happened — and text past
the protocol's 256 KB is refused whole, not cut. What the PC copies while the stream runs is offered as a
length ("The PC copied 42 characters") with Copy and Dismiss; it reaches the phone's clipboard only on Copy,
marked sensitive so Android 13 and later keep it out of the copy preview. Held text is dropped when the stream
ends, and its `toString` prints a length, so a stray log line cannot carry it. Images and files on either
clipboard are named, not carried.

**The H.264 profile is negotiated, because the first real stream failed.** The Android emulator's only
H.264 decoder takes Constrained Baseline (`42e01f`); the PC encoded High 5.1 (`640033`). libwebrtc
rejected the video section (`m=video 0`) and nothing reached the screen. Two changes came out of it:

- The phone reads its decoders' `profile-level-id`s and sends the profiles they take. The session host
  encodes High unless the client lists profiles without it, then Main, then Baseline; a client listing
  none it can produce is told so (`codec-mismatch`). The offer still describes the encoder's own SPS
  (`42c033` for that stream), not the request.
- An answer that rejects video is a failure with the reason — `codec-unsupported`, naming the profile the
  PC sent — never a stream that connects and stays black.

Proven against the real thing: the live test below streamed the development PC to the emulator at
2560×1440 (252 frames decoded in about 35 seconds on the emulator), took control, and
moved the PC's pointer to exactly (0.25, 0.25) of the screen, read back on the PC.

**A still desktop used to leave the first picture missing.** Found by the extras live test, on the PC's side:
the session host sent no frame while nothing on screen changed, and a key frame it was asked for was only
encoded with the next captured frame. On the emulator's lossy network a 2560×1440 key frame lost about a fifth
of its packets, the phone asked for another 24 to 39 times, and none came until the screen changed. The
session host now encodes the picture it already holds again when nothing new was captured
([remote desktop](remote-desktop.md#recovering-from-loss)), which fixes it for every client.

**Not yet:** profile changes mid-stream from the phone, and a hardware keyboard's shortcuts. These exist in
the protocol and the web client.

## Files

The web dashboard's file manager ([the file manager](file-manager.md)), on the remote desktop screen:
**Files** opens a panel under the picture. Like the web, it rides the running stream's data channel, so
**no server sees a name or a byte** — and, like the web, it needs a running stream.

- **Its own lease.** "Ask for file access" sends `file.request`; the relay grants the `file-operations`
  lease only to a session holding `file-transfer`, and the grant is renewed while held. Without it nothing
  is sent: a file request without the lease fails on the phone before it reaches the channel. Losing the
  lease clears what was shown.
- **Browse:** drives with free space, folders, files with size, date, and whether an entry is a link, a
  hidden file or under a Windows-owned location. A truncated folder says so. The PC's refusals are shown in
  its words, with Windows' refusals marked as Windows'.
- **Fetch** into a document the owner picks. Chunks are requested at exact offsets, each chunk's SHA-256 is
  verified **before any of it is written**, and a transfer that does not finish — stopped, refused, a bad
  chunk, a dropped stream — **removes the document**, so a partial copy never sits on the phone looking like
  the file.
- **Send** a document the owner picks into the folder shown. Never overwrites: the PC refuses `exists` and
  the owner is told. The phone reads the file in order, so an answer from the PC that is not exactly past
  what was sent ends the transfer rather than being guessed at, and the PC's whole-file checksum at the end
  is compared with the phone's. Stopping or failing cancels the transfer on the PC, and its part file goes.
  A document whose size the provider will not state is refused, because the PC must know the size first.
- **Always answered.** Requests are matched to answers by id, never by order, and each is answered exactly
  once: the PC's answer, its refusal, a 30-second timeout, or the stream ending.

**A finding from the first live run:** the lease can be granted while the PC's data channel is still
opening — the stream was connected, access granted, and the first listing failed with "not ready". File
requests now wait for the channel to open, still bounded by their timeout; the Android peer reports when it
does.

Not built, as on the web: delete, rename, move and new folders (they belong on the command path); search;
folder transfers; resuming an interrupted transfer (the protocol supports it; neither client uses it yet);
browsing without a stream.

## Services, scheduled tasks and startup items

Two screens off the PC screen, **Services** and **Tasks & startup**, the web dashboard's panels on a phone.
They share the PC's session, so leaving one keeps the lists already read.

- **Services:** filter, status, account, start type; start, stop, restart; set the start type to automatic,
  delayed, manual or disabled. `boot` and `system` are shown and never offered — they belong to drivers that
  load before the service control manager exists. Stop and restart are off for a service WOLF protects, or
  that Windows says does not accept a stop, and the card says which.
- **Tasks & startup:** startup items (source, whose, what it runs) enabled and disabled; scheduled tasks
  (path, what it runs, state, last and next run in local time, a non-zero exit code) run, enabled and
  disabled. Disabling is off for protected entries; enabling them stays possible.
- **WOLF turns things off and on and never creates or removes them**, and the screen says why: those are
  how Windows persistence is installed. There is no field for what a startup entry runs.

Every change is a typed command on the command path, through the same confirmation ladder as power: the
server names the level (stopping a service is high; disabling one, or stopping one Windows cannot do
without, is critical and needs a single-use grant; running a task is high; a startup item is medium).
Commands are built from the listed row — the service's display name, the task's name — and the protocol's
own rules are applied before sending: a service name with no spaces or separators, a rooted task path that
cannot climb out of itself.

**An empty list and a reason are not an empty list.** Every Windows machine has services and tasks; when
the privileged helper is not there the agent returns none with `helperAvailable: false` and the reason,
and the screen shows the reason rather than "nothing". **A refusal WOLF or Windows made on purpose is a
notice, not an error**, so it does not read as something a retry would fix.

## Alerts and automations

Account-wide rather than about one PC, so none of it opens a PC session. The PC list shows the unread
count; the Alerts and Automations screens refresh every 30 seconds while open, and a run's history every
3 seconds while it is expanded — the web dashboard's pace.

**Alerts.** The inbox (mark one or all read), the rules (turn off, turn on, delete), and a new-rule form:
every PC or one, a metric above or below a threshold or the PC being offline, how long it must hold, the
quiet period after notifying, severity. The metrics offered are the web dashboard's, which are the ids the
server's rollup computes, and a device ("C:") is kept only for metrics that have devices — on CPU usage it
would match nothing, silently. Nulls are left out of what is sent, so the server applies its own defaults.

**Push notifications, with nothing in them** ([push](push.md)). What arrives through Firebase is a wake-up
that names nothing; the phone fetches its inbox from WOLF over its own sign-in and posts what is new —
private on the lock screen, where only "Something needs your attention" shows, and critical alerts on their
own channel. The Alerts screen says which of three states the phone is in and never implies more: this
build has no push service; WOLF's server has none (news shows only while the app is open); or wake-ups are
on, with the notification permission asked for there. The app never polls in the background to imitate
push. Signing out clears the phone's registration on the server first; revoking the device clears it too.
Tapping a notification opens the Alerts screen, after sign-in if needed.

**Automations.** The list shows each one's authorized risk, trigger, actions, targets, conditions and last
run, with Run now, Turn on/off, History and Delete. The builder on the phone covers schedules, alert
triggers and manual runs; the PC the alert fired for, or chosen PCs; the nobody-connected, time-window and
CPU-below conditions; and notify, power, **service, scheduled-task and startup-item actions**. The last
three are never typed: "Choose from a PC" opens a short session with `services` and `configuration` only,
reads that PC's list (low risk, so nothing to confirm), and ends the session as soon as the list is in. A
typed name is how an automation ends up aimed at nothing; a chosen one carries the display name the list
showed, which every PC checks again before it acts, so on a PC without that service the run fails and says
so. The phone does more than the web dashboard here, where these names are typed. Every payload is built in
`Automations.kt`, which applies the protocol's bounds (1–5 actions,
up to 5 conditions, 1–20 distinct PCs, HH:MM times, a power delay of at most a day) and never forces a
power action.

Anything a newer server sends that this app does not model — a trigger, condition, action or target
kind — is listed by its name rather than dropped, so the list stays the truth.

**Authority** is the web client's `useAuthority`, not the command ladder:

1. Save with no confirmation. Accepted means nothing in it needed one.
2. Refused: the server names the level. Medium asks for a yes; high asks for the password, re-entered
   through the no-retry call so a typo counts once, and the save is retried with the token that produced.
3. Retried at exactly that level. A higher level named on the retry asks again; a re-authentication
   refusal names no level and always means the password.
4. **Critical is a refusal, never a question.** The server refuses a critical action outright, and the
   app shows that as a problem. There is no dialog the owner could click through.

Turning an automation off and renaming it need nothing, because neither can make it do more; turning one
on re-authorizes. There is no PC session or privileged grant — the account token carries the decision and
the server records it against this phone's device. Revoking that device turns those automations off at
their next run; signing out does not, because sign-out revokes the refresh token and not the device.

## Configuration backup

The web dashboard's backup and restore ([configuration backup](configuration-backup.md)), with files in
the **system document picker**: the app asks for no storage permission, sees only the file the owner
picks, and keeps no copy of anything it read or wrote.

**Back up.** The backup is fetched first and the picker opened second, so a failed request never leaves an
empty file behind. It is held in memory only until it is written, and dropped if the owner cancels — the
cloud keeps no copy either, and the app says so. The file is the server's JSON, indented, with every value
written back as it came; it is kept as JSON rather than modelled, so nothing the app does not know about
is lost from the file the server's checksum covers. Written with truncation, so saving over a longer old
backup leaves no tail.

**Restore.** Choose a file; choose sections; *check what will change*; restore. The phone refuses only what
it can tell without trusting itself — a file over the API's 4 MiB restore limit, not JSON, or not in WOLF's
backup format — and leaves the checksum, the format version and every item to the server, which verifies
them. The summary shown is counts, not names. The restore sends the exact request that was previewed; if
the sections or the automations choice change, the preview is cleared and must be checked again, and a
preview answered after the choice changed is discarded. Authority is the same flow as automations: the
server names the level — at least medium, since configuration is replaced wholesale, and higher if restored
automations are turned on — and the phone confirms it, with the password when it is high.

Leaving the screen, or signing out, forgets the chosen file and any fetched backup.

## Device identity

An ECDSA P-256 key generated in the Android Keystore — the same curve the server and the Windows
agent use — in StrongBox where the phone has one, otherwise the TEE. The private key is created
without an export purpose; a test asserts its encoded form is null. The public key is sent at sign-in
as base64url SPKI, and a JVM test pins that encoding to the P-256 header the server expects.

On the emulator the key is software-backed, and the test log says so. On a phone with a TEE it is not.

**Every refresh is signed with it.** `RefreshProof` signs the device id, the exact refresh token and the
time — the bytes `refreshProofPayload` builds in the protocol, pinned byte for byte in both test suites — and
the server refuses a refresh without that signature, revoking the device's tokens. A refresh token copied off
the phone is useless without the phone's Keystore. A clock the server calls wrong comes back as
`auth.device_clock`, a 400, which the phone does not treat as being signed out. Access tokens are still
bearer tokens for their few minutes.

## Network

- Release: TLS only, system trust anchors only. A user-installed CA — a debugging proxy, or something
  installed by whoever had the phone — cannot read WOLF traffic.
- Debug: cleartext to `10.0.2.2` (the emulator's name for the development machine) and nowhere else, in
  a network security config that exists only in the debug source set.
- The API address is a Kotlin constant per build type rather than `BuildConfig`. Generated
  `BuildConfig` would be the app's only Java source, and compiling Java makes the Android Gradle plugin
  build a JDK image with `jlink`, which needs a full JDK of a version it supports.

## Screen

`FLAG_SECURE` on the window: no screenshots, no screen recording, no recent-apps thumbnail. The app
shows the owner's password field and other machines' screens, and the remote desktop renderer draws
inside that window, so the PC's picture is covered too. The password field is not kept in saved
instance state. **Audio playback capture is off** (`allowAudioPlaybackCapture="false"`): Android lets other apps
record an app's sound by default, and this app plays a PC's. Found by inspecting the first release build, checked
on the installed package.

## Errors

Every failure is a WOLF problem — what went wrong, why, the current state, what to do, and a reference
— whether it came from the API, from a non-WOLF error body (a proxy's HTML page), or from the network.
Metrics a PC could not read stay unknown and are shown as a dash, never as zero.

## Building

Gradle 9.1.0, Android Gradle plugin 9.0.1, Kotlin 2.3.20, compile and target SDK 36, minimum SDK 28.
Gradle runs on JDK 21–25; because there are no Java sources, a runtime without `jlink` is enough.

```bash
npm run test:android          # JVM tests
npm run test:android:device   # Keystore tests on a running emulator or phone
npm run build:android         # debug APK
```

**Release builds** are minified by R8 and signed with the upload key, which comes from the environment only
(`WOLF_ANDROID_KEYSTORE_FILE`, `WOLF_ANDROID_KEYSTORE_PASSWORD`, `WOLF_ANDROID_KEY_ALIAS`,
`WOLF_ANDROID_KEY_PASSWORD`) — never from `local.properties`, never committed. Without them a release refuses to
package and names what is missing; there is no unsigned or debug-signed fallback. Debug builds, the tests and
`:app:minifyReleaseWithR8`, which CI runs on every push, need none of it. The version comes from
`WOLF_ANDROID_VERSION_NAME` and `WOLF_ANDROID_VERSION_CODE`, set by the release pipeline.

```bash
npm run build:android:release                               # signed APK and app bundle
npm run verify:android:release -- <path to app-release.apk>  # the release gate
```

The gate (`scripts/verify-android-release.mjs`) is what the release pipeline runs before publishing: signed with
APK Signature Scheme v2 or later by one signer, not a debug certificate, not debuggable, the expected version, and
only the permissions WOLF chose — `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, and what Firebase
Cloud Messaging needs (`WAKE_LOCK`, `c2dm.permission.RECEIVE`), plus AndroidX's guard on the app's own
receivers. The release manifest's exported components are the launcher activity, Firebase's receiver (only
Google Play services may send to it) and AndroidX's profile installer (only the shell). Signing, the pipeline and
key custody: [deployment](../deployment/README.md#android-app).

## Tests

- **JVM, commands:** the confirmation ladder against a mock API enforcing the real rules — medium,
  high with a re-issued session token, critical with a grant, the phone never escalating on its own, one
  password attempt, a lapsed session token renewed once, sessions ended on close.
- **JVM, remote desktop:** the stream session against a scripted relay and peer — authentication first,
  the request's shape, offer to answer, ICE both ways, control requested and renewed, an answer that
  rejects video failing as `codec-unsupported`, an agent that is away, a dropped connection reported as
  reconnecting, errors from the PC carrying their own advice; touch normalisation against a
  letterboxed picture; input event bounds; decoder profile-level-ids to H.264 profiles.
- **JVM, remote desktop extras:** sound asked for only when wanted; the negotiation's display id, audio codec
  and adjustments; a display switch sent in place, answered without leaving streaming, and null for the primary;
  clipboard text in the protocol's exact shape on the data channel and never through the relay, refused whole
  past 256 KB and before the channel opens; the PC's text, refusals and unsupported formats handed over, other
  formats ignored, held text never printed. Zoom around the fingers, panning bounded by the picture, a touch
  through the zoom and on the bars, pinch versus scroll decided once, scroll direction and accumulation; the
  display list read from the agent's result with unusable entries left out.
- **JVM, automations:** authority against a mock API enforcing `authorizeSave` — nothing confirmed
  before the server asks, medium at the named level, high with the re-authenticated token, one password
  attempt, no request without a password, critical refused rather than asked, never climbing, a stale
  sign-in asking again, turning off free and turning on not. The builders held to the protocol's exact
  JSON and bounds; descriptions, including kinds the app does not know; the alert and inbox paths.
- **JVM, files:** against a fake PC that behaves like the session host's file channel — every message's
  protocol shape; paths built as the web builds them; a download at exact offsets, a corrupt chunk refused
  with none of it written, a stop between chunks; an upload in contiguous chunks with only the last final and
  overwrite never set, an empty file as one final empty chunk, a misaligned copy and a refusal each ending
  the transfer and cancelling it on the PC, a whole-file checksum mismatch reported, a short source and an
  over-limit file refused. On the stream: the lease requested, renewed and released; nothing sent without
  it; answers matched by id out of order; a timeout answered once; waiting requests answered when the
  stream ends; a request made before the channel opens sent when it does, and not sent if it timed out.
- **JVM, services, tasks and startup items:** every command's exact protocol JSON; service names, task
  paths (rooted, no climbing, no wildcards), start types (boot and system refused) and actions held to the
  protocol; a startup change carrying nothing but on or off; lists decoded as the agent sends them,
  including the helper-unavailable shape; scheduler times in local time or not at all; the service, task
  and startup automation actions and their descriptions.
- **JVM, configuration:** the file checks (too large, not JSON, not WOLF's format, a byte-order mark
  accepted, a newer version left to the server), the file written value for value, names, section order,
  plan wording; backup and restore against a mock API that verifies the file and always asks — medium at
  the named level, the password when restored automations make it high, a damaged file refused with
  nothing restored.
- **JVM:** the API client against a mock server (paths, the error envelope, ids that cannot add path
  segments, unknown metrics staying unknown); the session against a mock server that rotates refresh
  tokens and treats reuse as theft (single shared refresh, sign-out on refusal, offline launch); the
  vault format (no plaintext on disk, tampering, another key, truncation); the identity key encoding.
- **Instrumented (emulator or phone):** the Keystore identity key is stable, non-exportable and signs
  verifiably; the vault round-trips through the Keystore and a deleted key reads as signed out.
- **JVM, app lock:** a locked vault written without the owner and opened only after unlock; a token rotated while
  locked found after unlock; the setting outliving sign-out and turning off back to the ordinary format; a key lost
  with the screen lock read as signed out, said once, and the lock turned off; a tampered locked file signed out
  without blaming the screen lock. The session locked on relaunch and sending nothing, an unlock the Keystore does not
  accept staying locked, five minutes in the background locking it and one minute not, no lock meaning no locking.
  A wake-up while locked fetching nothing and posting the generic notice.
- **Instrumented, app lock** (`AppLockKeystoreTest`), with a throwaway PIN the runner sets on the emulator and
  removes: the real Keystore key refuses a read as locked and keeps the file, opens once the lock-screen credential is
  verified, takes a token rotated after the window has closed, and — when the PIN is removed — loses the sign-in,
  says so, and turns the lock off.
- **The locked app on screen** (`PrepareLockedAppTest`, through `am instrument`): the real app signed in against a
  local cloud with the lock on, relaunched past the unlock window to the system prompt ("Unlock WOLF"), and — the
  prompt dismissed, nothing entered — the locked screen saying "Not unlocked: Authentication canceled". Completing
  the prompt and a fingerprint were not driven: that would mean typing a PIN into the system's own UI.
- **Live:** the same session and Keystore against a real WOLF API (`npm run dev:cloud`), gated on a
  runner argument: sign in, the server records an Android device, a relaunch restores from the rotated
  token, sign-out revokes the refresh token on the server. And the refresh proof against the server's own
  verifier: a Keystore signature accepted, one by a clock an hour off refused as `auth.device_clock` without
  revoking, and an unsigned refresh revoking the device's tokens so that even a signed one then fails.
- **Live remote desktop** (`LiveRemoteDesktopTest`), gated the same way, against a local cloud and a
  running agent on the development PC: the stream reaches `streaming`, frames are decoded, control is
  granted, and a single `pointer.move` is sent — never a click, since the PC is someone's real desktop.
  The runner reads the PC cursor back to confirm the move arrived.
- **Live alerts and automations** (`LiveAlertsAutomationsTest`), gated the same way: both rule shapes
  accepted by the server's schema, turned off and deleted; a notify-only automation saved with nothing to
  confirm, run by hand and found in the inbox; a restart automation asking for the password before it is
  saved. That one is saved turned off with a manual trigger, so it cannot run, and everything the test
  creates is deleted.
- **Live configuration** (`LiveConfigurationTest`), gated the same way: a backup written to a real file
  through the app's document store and read back identical, holding none of the strings of credentials;
  a rule deleted and restored from that file — alert rules only — at the medium level the server named,
  coming back with its id; an edited copy refused by the server.
- **Live services, tasks and startup items** (`LivePcToolsTest`), against a local cloud and the running
  agent: all three lists read from the PC, or the PC's reason they could not be; six changes classified by
  the server and **none confirmed**, so nothing reaches the machine (stopping the Print Spooler high,
  stopping RpcSs critical, disabling a service critical, running a task high, disabling a Windows Update task
  critical, disabling a startup item medium); a phone-built service action saved into an automation that is
  off and manual-only, after the password, and deleted. On the development PC the agent runs without the
  privileged helper, so the lists came back empty with that reason — which is the path this test proves.
- **Live files** (`LiveFileManagerTest`), over a real stream to the development PC: the drives listed; a
  network path, a climbing path and a device name refused with their reasons; 200 KB of random bytes sent
  into `C:\Users\Public\Documents` with the PC's checksum matching; the same name refused rather than
  overwritten; the file fetched back into memory and through the document store into a real file, identical
  byte for byte; a stopped upload leaving neither a file nor a part file. WOLF cannot delete, so the runner
  removes the one file the test writes.
- **Live remote desktop extras** (`LiveRemoteDesktopExtrasTest`), against a local cloud and the running agent,
  holding no `input` at all, on the full 2560×1440 profile again since the still-desktop fix: the displays listed
  by the real command; a stream asking for sound, negotiated as Opus, with audio packets arriving (about 270 in
  five seconds); on the development PC's single display, asking for the display shown changes nothing and the
  stream keeps streaming — a real switch needs a second monitor and is not proven live; and the clipboard both
  ways — the phone's marker reached the PC's clipboard, and the PC's reply reached the phone. The runner saves
  the PC's clipboard (text and HTML) first, never prints it, and restores both afterwards.
- **JVM, push:** registration sent only when WOLF does not hold this token (a rotated token, another
  device's sign-in, a server that lost it), a marker that holds a hash and never the token, the server's
  "not configured" reported as such, sign-out clearing the server before the token; a wake-up showing only
  unread news not shown before, oldest first, the latest four and a count, nothing without credentials, and
  a failed fetch remembering nothing so the news is not lost.
- **Live push** (`LivePushTest`), against a local cloud and the running agent: a synthetic token registered
  and reported back; a notify automation run on the PC; a wake-up, as the messaging service calls it,
  fetching that notification and posting it through the phone's real notification manager, private with a
  generic lock-screen version; a second wake-up showing nothing; sign-out clearing the registration. **Not
  proven: that Google delivers** — that needs a Firebase project this repository does not have.

```bash
npm run test:android:device -- \
  -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveRemoteDesktopTest \
  -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
  -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
  -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
```

## Dependencies

AndroidX Activity, Lifecycle and Jetpack Compose (Apache-2.0), kotlinx-serialization and
kotlinx-coroutines (Apache-2.0), OkHttp (Apache-2.0), the WebRTC SDK for Android
`io.github.webrtc-sdk:android` 137.7151.05 — a build of Google's libwebrtc (BSD-3-Clause), kept by R8
under `org.webrtc`. Firebase Cloud Messaging `com.google.firebase:firebase-messaging` 24.1.0 from
Google's Maven repository (Apache-2.0), which brings Google Play services libraries under the Android
Software Development Kit License; it is started by the app only when the build has a Firebase project, and
its automatic start-up provider is removed. AndroidX Biometric 1.1.0 (Apache-2.0), for the system's prompt. Tests: JUnit 4 (EPL-1.0), OkHttp MockWebServer (Apache-2.0),
AndroidX Test (Apache-2.0).

## Not built yet

- Files: resuming an interrupted transfer, and browsing without a running stream (as on the web).
- Push: a delivery through Google proven end to end, which needs a Firebase project; phones without
  Google Play services receive no wake-ups.
- Changing a service, task or startup item from the phone has not run against a machine with the
  privileged helper installed; the development PC runs the agent interactively without it. The same is
  true of those changes from the web (see the roadmap's Milestone 4).
- Remote desktop: a display switch proven live on a PC with two monitors; profile changes mid-stream; a
  hardware keyboard's shortcuts.
- The release pipeline run for real: it needs the repository on GitHub, the `android-release` environment and an
  upload key. Publishing to Google Play, and per-ABI APKs (x86 and x86_64, for emulators only, are over half of
  the 50 MB universal APK).

# Android client

Kotlin and Jetpack Compose, in `apps/android`. Built so far: sign-in, the PC list, live metrics,
commands — power actions and the process list — with the same confirmation ladder as the web client, and
remote desktop over WebRTC with touch mapped to WOLF input. Alerts and automations follow.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| API client | `api/WolfApi.kt`, `api/Models.kt` | Typed calls; the WOLF error envelope; no token state |
| Session | `session/SessionManager.kt` | The only code that touches account tokens: sign-in, refresh, sign-out |
| PC session | `session/PcSessionController.kt` | A remote session on one PC; commands and their confirmation |
| Token vault | `security/TokenVault.kt` | The refresh token at rest, AES-GCM under a Keystore key |
| Device identity | `security/DeviceIdentity.kt` | ECDSA P-256 key in the Android Keystore |
| Stream session | `remote/StreamSession.kt` | Signaling and the stream's state machine; no Android types, so JVM-tested |
| WebRTC | `remote/WebRtcAndroid.kt` | libwebrtc peer connection, decoders, the signaling socket |
| Input | `remote/InputEvents.kt` | Touch to normalised coordinates; WOLF input events |
| Remote desktop | `remote/RemoteDesktopController.kt`, `ui/RemoteDesktopScreen.kt` | Its own PC session, renderer and gestures |
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

## Commands

A command is sent with a **session token** — scoped to one PC and to the capabilities the session was
granted — never with the account token. The session is opened the first time a command needs one
rather than when a PC is looked at, because reading metrics does not need a session and every session
is audited. It asks for `processes` and `power` and nothing else.

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

1. A **separate PC session** asking for `screen` and `input` only. Commands keep their own session; a
   viewer does not carry `power`.
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

Gestures, once in control: a tap is a left click, a long press a right click, a drag a left-button drag.
A text field sends `keyboard.text` (split under the protocol's limit without cutting a character in
two), with buttons for Enter, Backspace, Escape, Tab and arrows. Coordinates are normalised against the
**picture**, not the view — the picture is letterboxed to fit, and a touch on the black bars is dropped
rather than moved to the nearest edge, where it would click something the owner did not touch.

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

**Not yet:** audio (profiles ask for none), clipboard, file transfer, multiple displays and profile
changes mid-stream from the phone, a hardware keyboard's shortcuts, pinch-zoom and scroll gestures.
These exist in the protocol and the web client.

## Device identity

An ECDSA P-256 key generated in the Android Keystore — the same curve the server and the Windows
agent use — in StrongBox where the phone has one, otherwise the TEE. The private key is created
without an export purpose; a test asserts its encoded form is null. The public key is sent at sign-in
as base64url SPKI, and a JVM test pins that encoding to the P-256 header the server expects.

On the emulator the key is software-backed, and the test log says so. On a phone with a TEE it is not.

**The server records the key but no request is signed with it yet.** Device proof-of-possession is a
later piece of work; until then the key identifies the device in the list and nothing more.

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
instance state.

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

## Tests

- **JVM, commands:** the confirmation ladder against a mock API enforcing the real rules — medium,
  high with a re-issued session token, critical with a grant, the phone never escalating on its own, one
  password attempt, a lapsed session token renewed once, sessions ended on close.
- **JVM, remote desktop:** the stream session against a scripted relay and peer — authentication first,
  the request's shape, offer to answer, ICE both ways, control requested and renewed, an answer that
  rejects video failing as `codec-unsupported`, an agent that is away, a dropped connection reported as
  reconnecting, errors from the PC carrying their own advice; touch normalisation against a
  letterboxed picture; input event bounds; decoder profile-level-ids to H.264 profiles.
- **JVM:** the API client against a mock server (paths, the error envelope, ids that cannot add path
  segments, unknown metrics staying unknown); the session against a mock server that rotates refresh
  tokens and treats reuse as theft (single shared refresh, sign-out on refusal, offline launch); the
  vault format (no plaintext on disk, tampering, another key, truncation); the identity key encoding.
- **Instrumented (emulator or phone):** the Keystore identity key is stable, non-exportable and signs
  verifiably; the vault round-trips through the Keystore and a deleted key reads as signed out.
- **Live:** the same session and Keystore against a real WOLF API (`npm run dev:cloud`), gated on a
  runner argument: sign in, the server records an Android device, a relaunch restores from the rotated
  token, sign-out revokes the refresh token on the server.
- **Live remote desktop** (`LiveRemoteDesktopTest`), gated the same way, against a local cloud and a
  running agent on the development PC: the stream reaches `streaming`, frames are decoded, control is
  granted, and a single `pointer.move` is sent — never a click, since the PC is someone's real desktop.
  The runner reads the PC cursor back to confirm the move arrived.

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
under `org.webrtc`. Tests: JUnit 4 (EPL-1.0), OkHttp MockWebServer (Apache-2.0), AndroidX Test
(Apache-2.0).

## Not built yet

- Alerts, automations, configuration backup, services, scheduled tasks and the file manager.
- Remote desktop: audio, clipboard, file transfer, display switching, scroll and zoom gestures.
- Release signing and distribution through CI.
- Unlocking the vault with the phone's biometric or screen lock.
- Device proof-of-possession, above.

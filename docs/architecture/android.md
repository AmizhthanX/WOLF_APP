# Android client

Kotlin and Jetpack Compose, in `apps/android`. The first slice is sign-in, the PC list and live
metrics; commands, alerts, automations and remote desktop follow.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| API client | `api/WolfApi.kt`, `api/Models.kt` | Typed calls; the WOLF error envelope; no token state |
| Session | `session/SessionManager.kt` | The only code that touches tokens: sign-in, refresh, sign-out |
| Token vault | `security/TokenVault.kt` | The refresh token at rest, AES-GCM under a Keystore key |
| Device identity | `security/DeviceIdentity.kt` | ECDSA P-256 key in the Android Keystore |
| UI | `ui/`, `MainActivity.kt` | Sign-in, PCs, live metrics |
| Endpoint | `src/debug/…/ApiEndpoint.kt`, `src/release/…/ApiEndpoint.kt` | API address per build type |

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
shows the owner's password field now and other machines' screens later. The password field is not kept
in saved instance state.

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

- **JVM:** the API client against a mock server (paths, the error envelope, ids that cannot add path
  segments, unknown metrics staying unknown); the session against a mock server that rotates refresh
  tokens and treats reuse as theft (single shared refresh, sign-out on refusal, offline launch); the
  vault format (no plaintext on disk, tampering, another key, truncation); the identity key encoding.
- **Instrumented (emulator or phone):** the Keystore identity key is stable, non-exportable and signs
  verifiably; the vault round-trips through the Keystore and a deleted key reads as signed out.
- **Live:** the same session and Keystore against a real WOLF API (`npm run dev:cloud`), gated on a
  runner argument: sign in, the server records an Android device, a relaunch restores from the rotated
  token, sign-out revokes the refresh token on the server.

## Dependencies

AndroidX Activity, Lifecycle and Jetpack Compose (Apache-2.0), kotlinx-serialization and
kotlinx-coroutines (Apache-2.0), OkHttp (Apache-2.0). Tests: JUnit 4 (EPL-1.0), OkHttp MockWebServer
(Apache-2.0), AndroidX Test (Apache-2.0).

## Not built yet

- Commands with the confirm-and-password flow, alerts, automations, configuration backup.
- Remote desktop: the WebRTC library, capture of touch into WOLF input, and the viewer.
- Release signing and distribution through CI.
- Unlocking the vault with the phone's biometric or screen lock.
- Device proof-of-possession, above.

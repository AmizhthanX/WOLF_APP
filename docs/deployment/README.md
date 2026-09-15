# Deployment

Initial target is Google Cloud. Nothing in the application depends on it: the services need
Postgres, an HTTP listener, and a WebSocket listener, all of which exist identically on AWS.

## Services

| Service | Shape | Notes |
| --- | --- | --- |
| `@wolf/api` | Cloud Run | Stateless. Scales to zero safely. |
| `@wolf/realtime` | Cloud Run, **min instances ≥ 1** | Holds long-lived agent links. Scaling to zero would disconnect every PC. |
| `@wolf/web` | Cloud Run or a static host with SSR | Needs `WOLF_API_URL` server-side for the token broker. |

Cloud Run supports WebSockets, but a connection belongs to one container instance. WOLF is
built for that: agents reconnect with backoff, commands live in durable rows, and delivery
is claimed atomically, so a scaled or restarted instance loses nothing but the socket.

## Hostnames

```
amizhthan.app          web app and PWA
api.amizhthan.app      HTTPS API
relay.amizhthan.app    realtime agent links (wss)
status.amizhthan.app   status page
```

## Configuration

Every value comes from the environment and is validated at startup. A service that cannot
be configured safely refuses to start — there is no fallback signing secret and no
development mode that skips authentication.

Required in every environment:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Cloud SQL connection string |
| `DATABASE_SSL` | `require` anywhere outside a local machine |
| `WOLF_TOKEN_SECRET` | ≥32 bytes of real entropy, from Secret Manager |
| `WOLF_TOKEN_ISSUER` | e.g. `https://api.amizhthan.app` |
| `WOLF_ALLOWED_ORIGINS` | Explicit list. `*` is rejected in production, as is a non-HTTPS origin. |

See `.env.example` for the full set.

Secrets come from Secret Manager, mounted as environment variables. Nothing sensitive is
ever written to a configuration file in the image.

## Database

```bash
npm run db:migrate
```

Migrations are plain SQL applied in filename order, each in its own transaction, recorded
with a checksum. A file that changes after being applied is a hard error rather than a
silent divergence between the schema and the repository.

Run migrations as a separate step before rolling out new instances, and keep them
backwards-compatible with the version currently running so a rollback stays possible.

Raw telemetry is partitioned by day. `wolf_ensure_telemetry_partitions` runs from the API's
maintenance sweep, so tomorrow's partition exists before samples for it arrive.

## First deployment

1. Provision Cloud SQL, Secret Manager entries, and the Cloud Run services.
2. Apply migrations.
3. Create the owner account — once, from a machine with database access:

   ```bash
   WOLF_OWNER_EMAIL=… WOLF_OWNER_PASSWORD=… npm run bootstrap:owner -w @wolf/api
   ```

   There is no HTTP path to this. A second run fails, by design and by database constraint.
4. Sign in, create an enrolment token, and install the agent on a PC.

## Health

`GET /healthz` for liveness, `GET /readyz` for readiness (checks the database). Point Cloud
Run's probes at these; neither reveals anything useful to an unauthenticated caller.

## Observability

Structured JSON logs with ISO timestamps, which Cloud Logging reads directly. Every log
line carries a request id, and every user-visible failure carries a `WOLF-<AREA>-<HEX>`
reference that appears in both — an operator can take a reference id from a user and find
the exact request.

Logs never contain secrets: everything passes through the shared redactor.

## Rollback

Cloud Run keeps revisions; roll traffic back to the previous one. Because migrations are
kept backwards-compatible with the running version, a code rollback does not require a
schema rollback.

## Android app

Released by `.github/workflows/android-release.yml` from a tag of the form `android-vMAJOR.MINOR.PATCH`;
a manual run with a version builds and uploads artifacts but publishes nothing. CI builds every
push without any key: JVM tests, a debug build, and R8 over the release build.

**The upload key** lives only in the secrets of a GitHub environment named `android-release` — give
that environment required reviewers, so a release waits for a person:

| Secret | |
| --- | --- |
| `WOLF_ANDROID_KEYSTORE_BASE64` | The keystore, base64 |
| `WOLF_ANDROID_KEYSTORE_PASSWORD` | |
| `WOLF_ANDROID_KEY_ALIAS` | |
| `WOLF_ANDROID_KEY_PASSWORD` | |

Optional variables `WOLF_FIREBASE_APPLICATION_ID`, `WOLF_FIREBASE_PROJECT_ID`, `WOLF_FIREBASE_API_KEY`
and `WOLF_FIREBASE_SENDER_ID` give the app its push project; without them it is built with no push
service and says so ([push](../architecture/push.md)).

Create the key once, on a machine you trust, with the passwords in the environment rather than on
the command line:

```bash
keytool -genkeypair -keystore wolf-upload.keystore -storetype PKCS12 -alias wolf-upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=WOLF" \
  -storepass:env WOLF_ANDROID_KEYSTORE_PASSWORD -keypass:env WOLF_ANDROID_KEYSTORE_PASSWORD
base64 -w0 wolf-upload.keystore    # the value of WOLF_ANDROID_KEYSTORE_BASE64
```

Keep an offline copy. Android updates an installed app only from an APK signed with the same key, so
a lost key means every user uninstalls — losing their sign-in — to move to a new one. Never commit
it: `.keystore`, `.jks` and `.p12` files fail the secrets check.

**What a release run does.** Fails at once if a signing secret is missing — there is no unsigned or
debug-signed fallback, and the Gradle build refuses the same way locally. Derives the version code
from the version (`MAJOR·1000000 + MINOR·1000 + PATCH`), so every release is an update to the last.
Runs the JVM tests, builds and signs the APK and the app bundle, and passes the APK through the
release gate (`scripts/verify-android-release.mjs`): signed with APK Signature Scheme v2 or later by
one signer and not with a debug certificate, not debuggable, the version the tag names, and **no
permission outside the list the gate holds** — a dependency that adds an advertising id or a
microphone fails the release instead of shipping in it. It then deletes the decoded key and publishes
a GitHub release with the APK, `SHA256SUMS`, and notes giving the APK's SHA-256 and the signing
certificate's fingerprint, which is what a person installing it checks. The app bundle and the R8
mapping stay with the run for 90 days; archive the mapping with each release, since it is the only way
to read a release crash's stack trace.

To build a release locally, set the four signing variables (`WOLF_ANDROID_KEYSTORE_FILE` holding a
path, and the passwords and alias), then:

```bash
npm run build:android:release
npm run verify:android:release -- apps/android/app/build/outputs/apk/release/app-release.apk
```

Not yet: publishing to Google Play, which needs a Play Console service account; and per-ABI APKs —
the one APK carries WebRTC for four ABIs, and x86 and x86_64, which only emulators use, are over half
of its 50 MB.

## AWS migration

The mapping the PRD calls for, none of which touches business logic:

| GCP | AWS |
| --- | --- |
| Cloud Run | ECS, EKS, or App Runner |
| Cloud SQL (Postgres) | RDS (Postgres) |
| Secret Manager | Secrets Manager |
| Cloud Logging / Monitoring | CloudWatch |
| Cloud Storage | S3 |
| Pub/Sub | SNS/SQS |

The one piece to check is `LISTEN/NOTIFY`, used for command delivery. RDS Postgres supports
it, so the move is a matter of infrastructure rather than code.

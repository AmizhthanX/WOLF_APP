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

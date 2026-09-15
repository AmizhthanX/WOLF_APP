# Push wake-ups

How a phone hears about news while WOLF is closed, and why what it hears is nothing.

## A wake-up says nothing

Push on Android means Firebase Cloud Messaging: a Google service WOLF does not run and whose logs WOLF
cannot see. So what WOLF sends through it is **content-free**:

```json
{ "message": { "token": "<registration token>", "data": { "kind": "wolf.wake", "v": "1" },
               "android": { "priority": "HIGH", "ttl": "3600s", "collapse_key": "wolf-wake" } } }
```

No notification block, so Android shows nothing from the push itself. No PC name, alert title, severity or
count. The phone wakes, fetches its inbox from WOLF over its own authenticated connection, and shows what is
new. The cost is one round trip before a notification appears. The alternative put "DESKTOP-50RGWF is offline"
into a third party's hands for every alert.

- **High priority**, so Android lets the app wake for it.
- **One hour to live.** Past that, the news is in the inbox and a wake-up adds nothing.
- **One collapse key.** A phone that was offline gets one wake-up, not a queue.

## The server

```
alert job / automation executor ──writes──▶ notifications (pushed_at null)
                                                  │
PushJob, every 5 s ──claims (FOR UPDATE SKIP LOCKED)──┘
        │  users with news ▶ active devices with a token
        ▼
PushSender (cloud/push.ts) ──▶ FcmPushSender (cloud/gcp/fcm.ts) ──▶ FCM HTTP v1
```

- **Behind the cloud-provider interface.** Business logic knows a device, a token and three outcomes
  (`delivered`, `token-invalid`, `failed`). The FCM adapter authenticates as a service account with a JWT
  signed by Node's own crypto and exchanged for an OAuth token, cached until a minute before it expires.
  No Google client library.
- **Decoupled from writing notifications.** The alert job and the automation executor write rows as before
  and never wait on a push service. A push service that is down delays nothing else.
- **At most once.** A notification is claimed before its wake-up is sent. A failed send is not retried:
  the notification is already safe in the inbox. Several API instances are safe; each notification is
  claimed by one.
- **Old news is not news.** A notification older than fifteen minutes when found is set aside without a
  wake-up, so a server back from an outage does not wake phones for its backlog. The migration marks every
  existing notification as considered, so turning push on wakes nobody for history.
- **Dead tokens are forgotten** when FCM says `UNREGISTERED` or `SENDER_ID_MISMATCH` — unless the phone
  registered a fresh token in the meantime.
- **Logs** carry counts and outcomes, never a token or anything from a notification.

## Tokens

`device_push_tokens` holds one token per device. A device registers only its own (`PUT /push/token`, for the
device the access token belongs to), clears it on sign-out (`DELETE /push/token`), and loses it when the
device is revoked, in the revocation transaction. A revoked device is never woken even before that. The token
is never returned by the API or written to the audit trail, which records only that a token was registered or
cleared.

## Configuration

| | |
| --- | --- |
| `WOLF_PUSH_PROVIDER` | `none` (default) or `fcm` |
| `WOLF_FCM_PROJECT_ID` | The Firebase project the Android app is registered in |
| `WOLF_FCM_CREDENTIALS_FILE` | A service-account JSON file, mounted from secret management — a path, never the key in the environment |

`none` is a state, not a failure: the server sends nothing, `GET /push` says `configured: false`, and the
phone tells its owner that news shows only while WOLF is open. A provider that is configured but whose
credentials cannot be read refuses to start rather than starting silently without push.

## The phone

- **Firebase starts only from this build's own settings** — `wolf.firebase.applicationId`, `projectId`,
  `apiKey`, `senderId`, from `-P` or `local.properties`. These identify a project and are not credentials;
  they are still per deployment and not committed. Firebase's start-up provider is removed from the manifest,
  so a build without them has no push service and says so.
- **Registration** (`PushRegistrar`): on sign-in, at launch, and when the token rotates, the phone registers
  its token if WOLF does not already hold that one. It keeps a marker — the device id and a SHA-256 of the
  token — never the token.
- **A wake-up** (`WolfMessagingService` → `WakeHandler`): anything that is not `wolf.wake` is ignored. The
  inbox is fetched with the phone's own credentials; notifications already read, or already shown on this
  phone, are not shown again; the latest four each get a notification and the rest are counted. A phone with
  no credentials shows nothing and asks nothing; a failed fetch shows nothing and remembers nothing.
- **On the lock screen, only that WOLF has something.** Notifications are `VISIBILITY_PRIVATE` with a generic
  public version. Critical alerts have their own channel, so they can be let through while the rest are
  quieted. Nothing is posted without the notification permission, which the owner grants from the Alerts
  screen.

## What is and is not proven

- **Tested:** the FCM adapter against a local server that answers as Google's token endpoint and FCM do —
  the signed assertion verified with the service account's public key, the message byte for byte, token
  reuse, a refused token fetched once more, dead tokens told apart from failures. The job against a real
  Postgres engine. The routes, including that the audit trail never holds a token. The phone's registration
  and wake-up handling, and — live, against a real cloud and agent — a real notification fetched on a
  wake-up and posted privately on a real phone.
- **Not proven: that Google delivers.** That needs a Firebase project and its credentials, which this
  repository does not have. The token the live test registers is synthetic.

## Not built

- E-mail and webhooks. A webhook is an owner-configured URL the cloud would call, which is a server-side
  request forgery surface until it is designed as one.
- Apple push, for a client that does not exist yet.

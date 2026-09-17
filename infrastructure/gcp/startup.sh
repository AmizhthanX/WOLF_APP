#!/usr/bin/env bash
#
# Runs on the WOLF VM at every boot, and again on every deploy (`google_metadata_script_runner startup`).
#
# 1. Installs Docker from Debian's own packages, once.
# 2. Reads the secrets from Secret Manager into /run/wolf — memory, gone at power-off, readable by root only — as the
#    env files and credential files compose.yml mounts. Nothing secret is written to disk or printed to the log.
# 3. Pulls the images named in the instance metadata and starts WOLF. Migrations run before the API and the relay.
#
# Everything this needs comes from the instance metadata (set by Terraform and by scripts/deploy-gcp.mjs) and from
# Secret Manager and Artifact Registry, reached as the VM's own service account.

set -euo pipefail
umask 077

log() { echo "wolf-startup: $*"; }

METADATA=http://metadata.google.internal/computeMetadata/v1
meta() { curl -fsS -H 'Metadata-Flavor: Google' "$METADATA/$1"; }
attribute() { meta "instance/attributes/$1" 2>/dev/null || true; }

# The VM's own service account, through the metadata server: no key file, and nothing to install.
access_token() {
  meta instance/service-accounts/default/token | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

# The latest version of one secret, or nothing when it has none. Read with the service account, which may read
# exactly the WOLF secrets and nothing else (infrastructure/terraform/main.tf).
secret() {
  local project token
  project="$(meta project/project-id)"
  token="$(access_token)"
  curl -fsS -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/$1/versions/latest:access" 2>/dev/null \
    | python3 -c 'import base64,json,sys; sys.stdout.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())' 2>/dev/null
}

# --- Docker -------------------------------------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker from Debian's packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q docker.io docker-compose python3 curl
  systemctl enable --now docker
fi

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# --- Configuration ------------------------------------------------------------------------------------------------

DOMAIN="$(attribute wolf-domain)"
REGISTRY="$(attribute wolf-registry)"
IMAGE_TAG="$(attribute wolf-image-tag)"
ACME_EMAIL="$(attribute wolf-acme-email)"
FCM_PROJECT_ID="$(attribute wolf-fcm-project-id)"
EXTERNAL_IP="$(meta instance/network-interfaces/0/access-configs/0/external-ip)"
INTERNAL_IP="$(meta instance/network-interfaces/0/ip)"

if [ -z "$DOMAIN" ] || [ -z "$REGISTRY" ]; then
  log "wolf-domain and wolf-registry must be set in the instance metadata; nothing started"
  exit 1
fi

if [ -z "$IMAGE_TAG" ]; then
  log "no image has been deployed yet (wolf-image-tag is empty). Run: node scripts/deploy-gcp.mjs deploy"
  exit 0
fi

APP=/opt/wolf
mkdir -p "$APP"
attribute wolf-compose > "$APP/compose.yml"
attribute wolf-caddyfile > "$APP/Caddyfile"
chmod 644 "$APP/compose.yml" "$APP/Caddyfile"

# --- Secrets, into memory -----------------------------------------------------------------------------------------

# Written over in place rather than removed and made again: a running container's bind mount keeps pointing at
# the directory it started with.
RUN=/run/wolf
mkdir -p -m 700 "$RUN" "$RUN/secrets"

TOKEN_SECRET="$(secret wolf-token-secret || true)"
DATABASE_PASSWORD="$(secret wolf-database-password || true)"
TURN_SECRET="$(secret wolf-turn-secret || true)"
WEBHOOK_KEY="$(secret wolf-webhook-key || true)"

if [ -z "$TOKEN_SECRET" ] || [ -z "$DATABASE_PASSWORD" ] || [ -z "$TURN_SECRET" ]; then
  log "a required secret is missing from Secret Manager. Run: node scripts/deploy-gcp.mjs secrets"
  exit 1
fi

# The password is URL-safe base64 by construction (scripts/deploy-gcp.mjs), so it needs no escaping in the URL.
printf '%s' "$DATABASE_PASSWORD" > "$RUN/database-password"
chown 999:999 "$RUN/database-password"  # the postgres user inside its image
chmod 400 "$RUN/database-password"

PUSH_PROVIDER=none
FCM_FILE=
if [ -n "$FCM_PROJECT_ID" ] && secret wolf-fcm-credentials > "$RUN/secrets/fcm.json" && [ -s "$RUN/secrets/fcm.json" ]; then
  chown -R 1000:1000 "$RUN/secrets"  # the node user inside the server image
  chmod 400 "$RUN/secrets/fcm.json"
  PUSH_PROVIDER=fcm
  FCM_FILE=/run/secrets/fcm.json
else
  rm -f "$RUN/secrets/fcm.json"
fi

cat > "$RUN/server.env" <<EOF
NODE_ENV=production
HOST=0.0.0.0
DATABASE_URL=postgres://wolf:${DATABASE_PASSWORD}@db:5432/wolf
DATABASE_SSL=disable
WOLF_TOKEN_SECRET=${TOKEN_SECRET}
WOLF_TOKEN_ISSUER=https://api.${DOMAIN}
WOLF_ALLOWED_ORIGINS=https://${DOMAIN}
WOLF_STUN_URLS=stun:turn.${DOMAIN}:3478
WOLF_TURN_URLS=turn:turn.${DOMAIN}:3478?transport=udp,turn:turn.${DOMAIN}:3478?transport=tcp
WOLF_TURN_SECRET=${TURN_SECRET}
WOLF_WEBHOOK_KEY=${WEBHOOK_KEY}
WOLF_PUSH_PROVIDER=${PUSH_PROVIDER}
WOLF_FCM_PROJECT_ID=${FCM_PROJECT_ID}
WOLF_FCM_CREDENTIALS_FILE=${FCM_FILE}
EOF
chmod 400 "$RUN/server.env"

# TURN relays only to the public internet. Every private, loopback, link-local and metadata range is refused, so a
# credential cannot be used to reach this VM's own services or anything else inside Google's network.
cat > "$RUN/turnserver.conf" <<EOF
listening-port=3478
listening-ip=${INTERNAL_IP}
relay-ip=${INTERNAL_IP}
external-ip=${EXTERNAL_IP}/${INTERNAL_IP}
min-port=49160
max-port=49200
realm=${DOMAIN}
use-auth-secret
static-auth-secret=${TURN_SECRET}
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
no-rfc5780
user-quota=12
total-quota=120
stale-nonce=600
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.88.99.0-192.88.99.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
log-file=stdout
simple-log
EOF
chown 65534:65534 "$RUN/turnserver.conf"  # coturn's image runs as nobody
chmod 400 "$RUN/turnserver.conf"

unset TOKEN_SECRET DATABASE_PASSWORD TURN_SECRET WEBHOOK_KEY

# --- Start --------------------------------------------------------------------------------------------------------

log "pulling ${REGISTRY} images, tag ${IMAGE_TAG}"
# A registry login that lasts an hour, kept in memory with the other secrets.
export DOCKER_CONFIG="$RUN/docker"
mkdir -p "$DOCKER_CONFIG"
access_token | docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY%%/*}" >/dev/null

export WOLF_REGISTRY="$REGISTRY" WOLF_IMAGE_TAG="$IMAGE_TAG" WOLF_DOMAIN="$DOMAIN" WOLF_ACME_EMAIL="$ACME_EMAIL"
export WOLF_RUNTIME_DIR="$RUN"

# The same names for anyone who signs in to look: `cd /opt/wolf && sudo docker compose logs api`. No secret here.
umask 022
cat > "$APP/.env" <<EOF
WOLF_REGISTRY=${REGISTRY}
WOLF_IMAGE_TAG=${IMAGE_TAG}
WOLF_DOMAIN=${DOMAIN}
WOLF_ACME_EMAIL=${ACME_EMAIL}
WOLF_RUNTIME_DIR=${RUN}
EOF

# Making the owner account, once. WOLF has no sign-up page; the password is typed here, hidden, and goes to the
# one-off container as an environment variable — never into a command line, a file, or shell history.
cat > "$APP/create-owner.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/wolf
read -r -p "Owner email: " WOLF_OWNER_EMAIL
read -r -p "Your name: " WOLF_OWNER_NAME
read -r -s -p "New WOLF password (hidden): " WOLF_OWNER_PASSWORD; echo
read -r -s -p "Again: " again; echo
[ "$WOLF_OWNER_PASSWORD" = "$again" ] || { echo "The two passwords are different. Nothing was made."; exit 1; }
unset again
export WOLF_OWNER_EMAIL WOLF_OWNER_NAME WOLF_OWNER_PASSWORD
export DOCKER_CONFIG=/run/wolf/docker
if docker compose version >/dev/null 2>&1; then compose=(docker compose); else compose=(docker-compose); fi
"${compose[@]}" run --rm --no-deps -e WOLF_OWNER_EMAIL -e WOLF_OWNER_NAME -e WOLF_OWNER_PASSWORD \
  migrate node services/api/dist/cli/bootstrap-owner.js
EOF
chmod 755 "$APP/create-owner.sh"
umask 077

cd "$APP"
compose --profile turn pull --quiet
compose --profile turn up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

log "WOLF ${IMAGE_TAG} is starting on https://${DOMAIN}"

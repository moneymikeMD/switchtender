#!/usr/bin/env bash
# Deploy switchtender to Cloud Run (CMB-12).
#
# Idempotent. Enables the APIs, creates any Secret Manager secret that does
# not exist yet (values read from 1Password through the op CLI and piped on
# stdin, never passed as arguments), grants the runtime service account read
# access, and deploys from source. Re-running deploys the current tree and
# leaves existing secret versions alone unless a flag says otherwise.
#
#   scripts/deploy-cloud-run.sh                  deploy
#   scripts/deploy-cloud-run.sh --update-config  also push ./config.toml as a new version
#   scripts/deploy-cloud-run.sh --rotate-secret  also mint a new shared secret (and store it in 1Password)
#
# Requires: gcloud authenticated as the project owner, op signed in, openssl.
# Env: SWITCHTENDER_CONFIG overrides the config file (default ./config.toml).
#
# --allow-unauthenticated is deliberate. The caller is a phone shortcut that
# cannot mint a Google identity token, so Cloud Run's IAM gate is off and the
# X-Switchtender-Key header, compared in constant time by src/server.js, is
# the authentication. Nothing is served without it except /health.

set -euo pipefail

PROJECT="${GCP_PROJECT:-commuter-bot-501717}"
REGION="${GCP_REGION:-us-east4}"
SERVICE="switchtender"
RUNTIME_SA="commuter-bot@${PROJECT}.iam.gserviceaccount.com"
CONFIG_FILE="${SWITCHTENDER_CONFIG:-./config.toml}"
OP_VAULT="Software_Development"
OP_SHARED_ITEM="Switchtender shared secret"
OP_NTFY_ITEM="Switchtender ntfy topic"
SCHEDULER_JOB="switchtender-verdict-check"

update_config=0
rotate_secret=0
for arg in "$@"; do
  case "$arg" in
    --update-config) update_config=1 ;;
    --rotate-secret) rotate_secret=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud not found"
command -v op >/dev/null || die "op not found"
command -v openssl >/dev/null || die "openssl not found"
[ -f "$CONFIG_FILE" ] || die "config file $CONFIG_FILE not found (copy config.example.toml and edit)"
[ -f Dockerfile ] || die "run from the repository root"

gcloud config set project "$PROJECT" --quiet >/dev/null

log "enabling APIs"
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  --quiet

secret_exists() { gcloud secrets describe "$1" --quiet >/dev/null 2>&1; }

# op read and openssl both end their output with a newline. Stored as-is, the
# container sees a 65-byte shared secret while the phone sends 64, and every
# API key carries a stray byte. Strip TRAILING line endings before anything
# reaches Secret Manager. Only trailing: the config file is multi-line TOML
# and flattening it onto one line made revision 00004 fail to start.
# Values are never echoed.
strip_newlines() { perl -0777 -pe 's/[\r\n]+\z//'; }

# Create a secret from stdin if absent. Prints nothing about the value.
create_secret_from_stdin() {
  local name="$1"
  if secret_exists "$name"; then
    cat >/dev/null # drain stdin; keep the existing version
    log "secret $name exists, keeping current version"
  else
    log "creating secret $name"
    strip_newlines | gcloud secrets create "$name" --replication-policy=automatic --data-file=- --quiet
  fi
}

# Add a new version from stdin, creating the secret first if needed.
add_secret_version_from_stdin() {
  local name="$1"
  if secret_exists "$name"; then
    log "adding a version to secret $name"
    strip_newlines | gcloud secrets versions add "$name" --data-file=- --quiet
  else
    log "creating secret $name"
    strip_newlines | gcloud secrets create "$name" --replication-policy=automatic --data-file=- --quiet
  fi
}

# Read a 1Password field, refusing an empty value. A failed `op read` piped
# straight into `gcloud secrets create` used to leave a secret with no
# version behind, which secret_exists then reported as healthy on every
# later run. The value goes through a shell variable, never argv; it is
# handed on through stdin.
op_value() {
  local value
  value="$(op read "$1")" || die "op read failed for $1"
  [ -n "$value" ] || die "op read returned nothing for $1"
  printf '%s' "$value"
}

# API keys: 1Password item -> Secret Manager, via stdin.
op_value "op://${OP_VAULT}/Switchtender/gcp routes api key" \
  | create_secret_from_stdin switchtender-routes-api-key
op_value "op://${OP_VAULT}/TomTom Developer/api key" \
  | create_secret_from_stdin switchtender-traffic-api-key
op_value "op://${OP_VAULT}/Wmata API/api key" \
  | create_secret_from_stdin switchtender-transit-api-key
# The Ticketmaster item title carries a trailing space, so it is addressed by id.
op_value "op://${OP_VAULT}/vvcgqbcehm2ccrfcg574wdrhci/credentials/consumer key" \
  | create_secret_from_stdin switchtender-events-api-key

# Shared secret. Source of truth is the 1Password item; Secret Manager holds
# a copy. If the item is missing, or a rotation was asked for, mint one with
# openssl and write it to 1Password through a JSON template on stdin.
shared_path="op://${OP_VAULT}/${OP_SHARED_ITEM}/credential"
mint_shared_secret() {
  local value
  value="$(openssl rand -hex 32)"
  # op item edit takes field values only as arguments, which would put the
  # secret in argv. Archive the old item and create afresh from a JSON
  # template on stdin instead; the archived copy keeps the previous value.
  if op item get "$OP_SHARED_ITEM" --vault "$OP_VAULT" >/dev/null 2>&1; then
    log "archiving previous 1Password item ${OP_SHARED_ITEM}"
    op item delete "$OP_SHARED_ITEM" --vault "$OP_VAULT" --archive
  fi
  log "creating 1Password item ${OP_SHARED_ITEM}"
  printf '{"title":"%s","category":"API_CREDENTIAL","vault":{"name":"%s"},"fields":[{"id":"credential","type":"CONCEALED","label":"credential","value":"%s"}]}' \
    "$OP_SHARED_ITEM" "$OP_VAULT" "$value" \
    | op item create - >/dev/null
}
if [ "$rotate_secret" = 1 ] || ! op read "$shared_path" >/dev/null 2>&1; then
  mint_shared_secret
  op_value "$shared_path" | add_secret_version_from_stdin switchtender-shared-secret
else
  op_value "$shared_path" | create_secret_from_stdin switchtender-shared-secret
fi

# ntfy.sh push topic (CMB-36, CMB-37). The public instance has no per-topic
# auth, so the topic name itself is the secret: a long random slug, never
# the literal word "switchtender". Same mint-if-missing pattern as the
# shared secret, its own 1Password item so it is never confused with (or
# rotated alongside) the phone's auth key.
ntfy_path="op://${OP_VAULT}/${OP_NTFY_ITEM}/credential"
mint_ntfy_topic() {
  local value
  value="$(openssl rand -hex 20)"
  log "creating 1Password item ${OP_NTFY_ITEM}"
  printf '{"title":"%s","category":"API_CREDENTIAL","vault":{"name":"%s"},"fields":[{"id":"credential","type":"CONCEALED","label":"credential","value":"%s"}]}' \
    "$OP_NTFY_ITEM" "$OP_VAULT" "$value" \
    | op item create - >/dev/null
}
if ! op read "$ntfy_path" >/dev/null 2>&1; then
  mint_ntfy_topic
fi
op_value "$ntfy_path" | create_secret_from_stdin switchtender-ntfy-topic

# The commute description. Gitignored, never in the image; mounted as a file.
if [ "$update_config" = 1 ]; then
  add_secret_version_from_stdin switchtender-config <"$CONFIG_FILE"
else
  create_secret_from_stdin switchtender-config <"$CONFIG_FILE"
fi

log "granting ${RUNTIME_SA} read access to each secret"
for name in switchtender-routes-api-key switchtender-traffic-api-key \
  switchtender-transit-api-key switchtender-events-api-key \
  switchtender-shared-secret switchtender-ntfy-topic switchtender-config; do
  gcloud secrets add-iam-policy-binding "$name" \
    --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

# Source deploys build with the default compute service account, which in
# projects created after the 2024 IAM change no longer carries Editor and so
# cannot read the uploaded source or push the image. Grant it the builder
# role once; the binding is idempotent.
project_number="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
build_sa="${project_number}-compute@developer.gserviceaccount.com"
log "granting ${build_sa} the Cloud Build builder role"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${build_sa}" \
  --role roles/cloudbuild.builds.builder \
  --condition None \
  --quiet >/dev/null

log "deploying ${SERVICE} to ${REGION}"
# --set-secrets covers both kinds: KEY=secret:version becomes an environment
# variable, /path=secret:version becomes a file mount. One flag replaces the
# whole set, so it doubles as --update-secrets on redeploy.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --memory 256Mi \
  --timeout 30 \
  --set-env-vars "SWITCHTENDER_CONFIG=/config/config.toml,NODE_ENV=production" \
  --set-secrets "/config/config.toml=switchtender-config:latest,ROUTES_API_KEY=switchtender-routes-api-key:latest,TRAFFIC_API_KEY=switchtender-traffic-api-key:latest,TRANSIT_API_KEY=switchtender-transit-api-key:latest,EVENTS_API_KEY=switchtender-events-api-key:latest,SWITCHTENDER_SHARED_SECRET=switchtender-shared-secret:latest,NTFY_TOPIC=switchtender-ntfy-topic:latest" \
  --quiet

url="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
log "deployed: ${url}"
log "check: curl -s -o /dev/null -w '%{http_code}\n' ${url}/health"

# Weekday morning push check (CMB-36, CMB-37). The geofence-triggered phone
# call and any manual poll never set ?notify=1, so this scheduled call is the
# only trigger for a push, and it fires whether or not the owner actually
# drives that day (owner decision 2026-09-18) -- a fixed clock time, not tied
# to the geofence. Cloud Scheduler has no way to read a header value out of
# Secret Manager for an HTTP target, so the shared secret is written into the
# job definition itself (readable by anyone with Cloud Scheduler access on
# this project, i.e. the owner alone -- same trust boundary as everything
# else here).
shared_secret_value="$(op_value "$shared_path")"
scheduler_target="${url}/verdict?notify=1"
if gcloud scheduler jobs describe "$SCHEDULER_JOB" --location "$REGION" --quiet >/dev/null 2>&1; then
  log "updating Cloud Scheduler job ${SCHEDULER_JOB}"
  # update takes --update-headers; only create takes --headers. With the
  # wrong one gcloud rejects the call AND echoes every argument, which puts
  # the shared secret in the output (CLAUDE.md rule 7).
  gcloud scheduler jobs update http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --uri "$scheduler_target" \
    --http-method GET \
    --update-headers "X-Switchtender-Key=${shared_secret_value}" \
    --schedule "0 7 * * 1-5" \
    --time-zone "America/New_York" \
    --quiet >/dev/null
else
  log "creating Cloud Scheduler job ${SCHEDULER_JOB}"
  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --uri "$scheduler_target" \
    --http-method GET \
    --headers "X-Switchtender-Key=${shared_secret_value}" \
    --schedule "0 7 * * 1-5" \
    --time-zone "America/New_York" \
    --quiet >/dev/null
fi
log "scheduler: weekdays 7:00 AM America/New_York -> ${scheduler_target}"

# Deploying the verdict service (CMB-12)

`src/server.js` serves `GET /verdict` on Cloud Run in project
`commuter-bot-501717`, region `us-east4`, service `switchtender`. It scales to
zero and is called twice a weekday. Cloud Run's own IAM gate is off
(`--allow-unauthenticated`) because a phone shortcut cannot mint a Google
identity token; the `X-Switchtender-Key` header, compared in constant time, is
the authentication. `/health` is the only route served without it.

## Deploy

```
cp config.example.toml config.toml   # edit for the real commute; stays local
scripts/deploy-cloud-run.sh
```

The script is idempotent. It enables the APIs, creates any missing Secret
Manager secret from 1Password (values travel on stdin, never argv), grants the
runtime service account `commuter-bot@commuter-bot-501717.iam.gserviceaccount.com`
`secretAccessor` on each, grants the default compute service account the
Cloud Build builder role (source deploys need it), and runs
`gcloud run deploy --source .`.

Secrets and where they land in the container:

| Secret Manager name | In the container |
| --- | --- |
| `switchtender-config` | file at `/config/config.toml` (`SWITCHTENDER_CONFIG`) |
| `switchtender-routes-api-key` | `ROUTES_API_KEY` |
| `switchtender-traffic-api-key` | `TRAFFIC_API_KEY` |
| `switchtender-transit-api-key` | `TRANSIT_API_KEY` |
| `switchtender-events-api-key` | `EVENTS_API_KEY` |
| `switchtender-shared-secret` | `SWITCHTENDER_SHARED_SECRET` |

The image (`Dockerfile`) holds `src/` and the Boston example config only.
`.dockerignore` and `.gcloudignore` keep `config.toml` and `.env` out of both
the build context and the source upload.

## Sheet logging from Cloud Run

`src/log.js` takes a token from `SHEETS_ACCESS_TOKEN`, else from the GCE
metadata server. On Cloud Run the metadata server returns the runtime service
account's token with `cloud-platform` scope, which the Sheets API accepts, so
no key file and no extra environment variable are needed. The Sheet is already
shared with that service account as a writer (CMB-11).

## Rotate the shared secret

```
scripts/deploy-cloud-run.sh --rotate-secret
```

Mints a new value with `openssl rand -hex 32`, archives the old 1Password item
`Switchtender shared secret` in `Software_Development` and creates a fresh one
(field `credential`), adds a Secret Manager version, and redeploys so the new
revision picks up `latest`. Then update the phone shortcut.

## Update the commute config

Edit `config.toml`, then:

```
scripts/deploy-cloud-run.sh --update-config
```

A new secret version is mounted by the new revision. Without the flag the
script keeps the existing version.

## Logs

```
gcloud run services logs read switchtender --region us-east4 --limit 50
```

One line per request: method, path, status, duration. Never a header.

## Phone-side call

```
curl -s --max-time 25 \
  -H "X-Switchtender-Key: $(op read 'op://Software_Development/Switchtender shared secret/credential')" \
  "$(gcloud run services describe switchtender --region us-east4 --format 'value(status.url)')/verdict"
```

Response: `{ "spoken": "...", "verdict": {...}, "computedAt": "..." }`. Speak
`spoken`. A 503 means routing failed and there is no verdict; the phone says
"Switchtender lookup failed" (see docs/phone.md) so silence is never mistaken
for a missed trigger. A 401 means the key is wrong.

`/verdict?from=origin` measures the whole trip from `route.origin` instead of
the fork (CMB-30); the spoken line opens with "Starting from home." Any other
`from` value is a 400. The verdict carries `measuredFrom`, and the arrival at
the destination for each option as `driveArrival` / `transitArrival` (ISO) and
`driveArrivalClock` / `transitArrivalClock` ("9:52 AM" in the commute's zone,
CMB-32); the spoken line says the arrival for the chosen option.

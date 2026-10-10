# Deploying the verdict service (CMB-12)

`src/server.js` serves `GET /verdict` on Cloud Run in project `commuter-bot-501717`, region `us-east4`, service `switchtender`. It scales to zero and is called about thirteen times a weekday: eleven
hourly samples, the phone at the fork, and the 7:30 push on office days. Cloud Run's own IAM gate is off (`--allow-unauthenticated`) because a phone shortcut cannot mint a Google identity token; the
`X-Switchtender-Key` header, compared in constant time, is the authentication. `/health` is the only route served without it.

## Deploy

```
cp config.example.toml config.toml   # edit for the real commute; stays local
scripts/deploy-cloud-run.sh
```

The script is idempotent. It enables the APIs, creates any missing Secret Manager secret from 1Password (values travel on stdin, never argv), grants the runtime service account
`commuter-bot@commuter-bot-501717.iam.gserviceaccount.com` `secretAccessor` on each, grants the default compute service account the Cloud Build builder role (source deploys need it), and runs `gcloud
run deploy --source .`.

The service's hostname is deliberately not written anywhere in this public repo: an unauthenticated call is refused before any upstream API is touched, but a discoverable URL still invites traffic
that costs Cloud Run requests. It lives in two private places: the gitignored `config.toml` as `[service] url`, and 1Password as `op://Software_Development/Switchtender/service url`. The phone recipes
in `docs/phone.md` read it from either. To recover it from the platform: `gcloud run services describe switchtender --region us-east4`, or the mapped domain in `gcloud beta run domain-mappings list
--region us-east4`.

Secrets and where they land in the container:

| Secret Manager name | In the container |
| --- | --- |
| `switchtender-config` | file at `/config/config.toml` (`SWITCHTENDER_CONFIG`) |
| `switchtender-routes-api-key` | `ROUTES_API_KEY` |
| `switchtender-traffic-api-key` | `TRAFFIC_API_KEY` |
| `switchtender-transit-api-key` | `TRANSIT_API_KEY` |
| `switchtender-events-api-key` | `EVENTS_API_KEY` |
| `switchtender-shared-secret` | `SWITCHTENDER_SHARED_SECRET` |
| `switchtender-ntfy-topic` | `NTFY_TOPIC` |

The image (`Dockerfile`) holds `src/` and the Boston example config only. `.dockerignore` and `.gcloudignore` keep `config.toml` and `.env` out of both the build context and the source upload.

## Sheet logging from Cloud Run

`src/log.js` takes a token from `SHEETS_ACCESS_TOKEN`, else from the GCE metadata server. On Cloud Run the metadata server returns the runtime service account's token with `cloud-platform` scope,
which the Sheets API accepts, so no key file and no extra environment variable are needed. The Sheet is already shared with that service account as a writer (CMB-11).

## Rotate the shared secret

```
scripts/deploy-cloud-run.sh --rotate-secret
```

Mints a new value with `openssl rand -hex 32`, archives the old 1Password item `Switchtender shared secret` in `Software_Development` and creates a fresh one (field `credential`), adds a Secret
Manager version, and redeploys so the new revision picks up `latest`. Then update the phone shortcut.

## Update the commute config

Edit `config.toml`, then:

```
scripts/deploy-cloud-run.sh --update-config
```

A new secret version is mounted by the new revision. Without the flag the script keeps the existing version.

## Arrivals (CMB-41)

`POST /arrived?place=park|office` records that the owner reached a place, and appends one row to the sheet's `arrivals` tab (`[log] arrivals_tab`) with the local timestamp, the place, and the
timestamp of that day's last verdict row so the two can be joined. It takes the same `X-Switchtender-Key` header as `/verdict`, `&at=<ISO 8601>` overrides the arrival time, and `&took=drive|transit`
records which option was actually taken. `took` is null when it is not given: what the verdict advised is not evidence that the advice was followed.

It answers 200 whenever the request itself was sound, including when the sheet write failed — the phone is at a destination, not waiting on a spreadsheet, and a status the macro might retry on would
only queue duplicate arrivals. The body says what happened: `recorded`, `duplicate` (a second arrival for that place on that local date, which is ignored) and `verdictAt` (null when no verdict was
logged that day; an arrival is still worth having). A failed write is logged server-side.

The tab is created on first use, like the verdicts tab. `scripts/bq-external-table.sh` defines `switchtender.arrivals` over it beside `switchtender.verdicts`, schema from `ARRIVALS_HEADER` in
`src/log.js`; re-run it after a header change. Score a morning by joining `arrivals.verdict_timestamp` to `verdicts.timestamp`, and pool `choice_taken = 'drive'` rows separately from transit ones: an
office arrival after transit covers park, wait, ride and walk, none of which `drive_minutes` models.

## Office-day push (CMB-36, CMB-37, CMB-83)

A Cloud Scheduler job `switchtender-verdict-check` runs at 7:30 AM Monday to Wednesday (`30 7 * * 1-3`, `America/New_York`), the owner's permanent office days. It calls
`/verdict?notify=1&trigger=schedule&from=origin`, so the owner can glance at the trip on sitting down in the car (owner decision 2026-09-28). The notify flag is the only thing that sends a push. The
phone's geofence call, the hourly samples, and `make poll`/`make poll-local` never set it.

Every call pushes, whatever the verdict. The title says the choice (`switchtender: keep driving` or `switchtender: take the train`) and the body is the spoken line. `from=origin` measures the whole
trip from home, so the minutes and the arrival clock cover the drive about to start; the row logs `measured_from = origin`. On office days the 7:30 poll sample also runs, so those mornings carry two
7:30 rows, `poll` and `schedule`.

The push goes to `https://ntfy.sh/$NTFY_TOPIC`. `ntfy.sh` is the public instance (CMB-36): self-hosting was rejected because it would mean this scale-to-zero public service reaching back into a
private network. The free tier has no per-topic auth, so `NTFY_TOPIC` — a long random slug from `openssl rand -hex 20`, never the word "switchtender" — is itself the secret, minted and stored the same
way as the shared secret (1Password item `Switchtender ntfy topic` in `Software_Development`, field `credential`). Subscribe to that topic in the ntfy Android app (the Google Play build; confirmed
FCM-backed, so delivery works with the app closed) to receive the push.

The response body's `notified` field (`null` outside `?notify=1`, otherwise `{ ok, sent, error }`) says what happened: `sent: false` covers both "no topic configured" and a failed push, which is also
logged server-side (never crashes the request — a push is a courtesy, not part of the verdict).

Cloud Scheduler has no way to pull a header value from Secret Manager for an HTTP target, so the shared secret is written into the job definition itself, readable by anyone with Cloud Scheduler access
on this project — the owner alone, same trust boundary as everything else here. Re-running `scripts/deploy-cloud-run.sh` updates the job in place if the service URL or secret ever changes.

## Hourly samples (CMB-81, CMB-82)

The phone logs a verdict only on days the owner drives in, three or four rows a week. Two more Cloud Scheduler jobs sample the commute every hour on weekdays (`America/New_York`), so the log also
grows on days nobody drives:

| Job | Schedule | Calls |
| --- | --- | --- |
| `switchtender-verdict-sample` | `30 5-10 * * 1-5`, 5:30 to 10:30 AM | `/verdict?trigger=poll` |
| `switchtender-verdict-sample-evening` | `30 15-19 * * 1-5`, 3:30 to 7:30 PM | `/verdict?trigger=poll&direction=outbound` |

`scripts/deploy-cloud-run.sh` creates or updates both next to the push job, with the same header. With the push job that is three, which is Cloud Scheduler's whole free tier for the billing account; a
fourth job anywhere on it costs $0.10 a month.

### The trip home

`direction=outbound` measures the same two options in reverse, fork as the far end: drive from the parking spot (or the destination) to the fork, or ride from the destination to the park-and-ride and
drive on from there. The drive from the lot is asked for at the moment the rider reaches the car, so it meets the traffic of that moment. `from=origin` ends the trip at home. The events signal's
evening window is centred on the actual departure, not `assumed_evening_departure`.

The trip home is data, never advice: the response's `spoken` is null, `notify=1` is a 400 on it, and the `direction` column reads `outbound`. The rule still decides, so `choice` and the margins are
logged for analysis.

Every row says who asked for it in the `trigger` column: `poll` for a sample, `schedule` for the 7:30 push, `phone` when a caller sends it, and empty when nobody said (the fork macro today, and every
row logged before 2026-09-28). Any other value is a 400. Samples never set `notify`.

Samples are for analysis, not decisions. The arrival join, which looks for the day's last real call, skips `poll` rows and `outbound` rows. Filter them the same way when scoring a drive, and keep them
when studying how the road behaves across the morning.

Cost: about 55 extra verdicts a week, which keeps Routes inside its free calls (`docs/cost-routes.md`).

Run one by hand with `gcloud scheduler jobs run switchtender-verdict-sample --location us-east4` (or `...-sample-evening`).

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

Response: `{ "spoken": "...", "verdict": {...}, "computedAt": "..." }`. Speak `spoken`. A 503 means routing failed and there is no verdict; the phone says "Switchtender lookup failed" (see
docs/phone.md) so silence is never mistaken for a missed trigger. A 401 means the key is wrong.

`/verdict?from=origin` measures the whole trip from `route.origin` instead of the fork (CMB-30); the spoken line opens with "Starting from home." Any other `from` value is a 400. The verdict carries
`measuredFrom`, and the arrival at the destination for each option as `driveArrival` / `transitArrival` (ISO) and `driveArrivalClock` / `transitArrivalClock` ("9:52 AM" in the commute's zone, CMB-32);
the spoken line says the arrival for the chosen option.

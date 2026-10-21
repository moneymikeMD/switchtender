# Configuration

Two files, with a hard line between them.

`config.toml` holds everything that describes a commute: coordinates, timings, thresholds, venues. It is gitignored. `config.example.toml` is the committed template, and it describes a real Boston
commute rather than a redacted version of anyone's actual route, so it can be read, run and copied without anyone having to wonder what was scrubbed out of it.

Secrets never appear in either. API keys come from the environment, which on a maintainer machine is populated by a password manager rather than a file on disk. See [Secrets](#secrets).

## The rule this file exists to enforce

The engine contains no coordinates. Not as defaults, not as fallbacks, not as test fixtures outside the fixture directory. A coordinate compiled into source is a coordinate that gets published the
first time the repository does, and no amount of tidying the working tree removes it from the history afterwards.

It is also what makes the tool reusable. Somebody else's commute is somebody else's config file, not a fork.

## Shape

The tool assumes a commute with two options that share a common first leg and diverge once. Drive the whole way, or park and take transit. Because the shared leg is common to both it cancels out
entirely, so the only thing that decides the answer is what happens after the fork. This is why there is a `decision_point` rather than a route: the engine does not care how you got there.

## Keys

### `[route]`

| Key | Meaning |
| --- | --- |
| `timezone` | IANA name. Everything user-facing is local time; everything stored is UTC. |

### Places: one shape (CMB-33)

Every `[route.*]` table is a place with exactly four keys: `lat`, `lon`, a human `label`, and `addl_walk_mins`. The label is what gets spoken and logged, so write it the way you would say it out loud.
`addl_walk_mins` is the minutes on foot added to any leg that ends at that place; it defaults to 0 and may be left out. Any other key is an error that names it, so a renamed or misspelt field can
never silently become a zero.

### `[route.origin]`

Where the commute starts. It plays no part in the verdict at the fork, but `npm start -- --from origin` or `GET /verdict?from=origin` measures the whole trip from it, for a look at both options before
leaving the house (CMB-30). The spoken line then opens with "Starting from home." Its walk is the one from the door to the car, counted only when measuring from here.

### `[route.decision_point]`

The fork. Past it the options are no longer interchangeable. No leg ends here, so its walk is accepted and never used.

### `[route.park_and_ride]`

Where the driver would leave the car to take transit. Its walk is the time from stopping the car to standing on the platform: garage queue, stairs, fare gates. Measure it on a normal weekday rather
than estimating it, because it is a constant added to every transit verdict and a wrong value biases every decision the tool ever makes in the same direction.

### `[route.destination]`

The door you walk through, not where the car stops. The transit leg is measured to it, and so is the drive once the parking walk is added. The transit answer already includes its final walk, so this
place's walk is normally 0.

### `[route.parking]` (optional)

Where the car actually stops when that is not the destination: a cheaper garage a few blocks from work, say. With it present, driving is routed to the parking spot and its walk (car to the destination
door) is added to the driving time, so both options end at the same door and the comparison is fair (CMB-31). Leave the table out to drive to the destination itself. Time the walk; do not guess it.

### `[trigger]`

`lead_miles` is how far before the decision point the verdict is delivered. Too short and there is no time to act; too long and conditions change between the verdict and the fork. This wants verifying
in the car at real speed.

### `[decision]`

| Key | Meaning |
| --- | --- |
| `transit_wins_ties` | A tie means the model cannot tell the options apart. The train is the one whose duration does not degrade while you sit in it. |
| `minimum_drive_margin_minutes` | Floor on how much faster driving must be, zero or more. The required margin scales above this with the congestion signal. |
| `assumed_evening_departure` | `"HH:MM"` on a 24-hour clock. Used only when something about the evening is already known. The trip home (`direction=outbound`) uses its actual departure instead. |

Every value is checked at startup: a time zone the runtime does not know, a `nan` or `inf` where a number belongs, a clock time that is not `HH:MM`, or a venue coordinate out of range is a config
error before any routing call is paid for, not a failed verdict on the first morning.

On that last point: a morning verdict commits you to how you get home, so a scheduled evening event is legitimately in scope. An afternoon crash is not, and the tool does not guess at it.

### `[transit]`

`lines` names the Metrorail lines the transit leg rides, matched against WMATA's planned track-work page. Any spelling the page would recognise loads as the page's own (`"red"`, `"Red Line"` and
`"RED"` all become `Red`); a line the page does not list is a startup error, because a misspelt line would otherwise report "no track work" on every run. Leave the list empty and the signal stays
quiet.

### `[ride]` (optional)

Metro ride alerts (CMB-148, CMB-151). Leave the whole block out and the three `/ride/*` endpoints answer 503. Present, it takes:

| Key | Meaning |
| --- | --- |
| `sheet_tab` | Tab in the `[log]` sheet that holds one row per ride (default `rides`). Must differ from `log.sheet_tab` and `log.arrivals_tab`; rides are never joined to verdicts. |
| `[ride.am]`, `[ride.pm]` | One table per leg. Each takes `start` and `end` (`"HH:MM"`, weekdays only; defaults `05:30`-`10:00` and `16:30`-`22:30`), `gps_window_mins` (default 25 and 5) and `legs`. |
| `[[ride.<leg>.legs]]` | In riding order: `line` (any spelling of a Metrorail line, canonicalised like `[transit] lines`), `board` and `alight`, the names the alerts use. The last `alight` is the exit; the ones before are transfers. |
| `board_code`, `alight_code`, `alert_code` | Per leg, optional here and required by the tracker Job: WMATA station codes (`"A15"`), upper-cased. `alert_code` names the station the alert fires on arrival at; left out, it is the station before `alight` along the track, so a leg must span at least two stops. The Job is WMATA-only and follows at most two legs; the direction of travel comes from the track's station order, never from the feed's `DirectionNum`. |

A fence time is judged on the wall clock in `route.timezone`, so the window follows DST. `start` is inside the window, `end` is not. The morning GPS window opens at the fence time plus
`route.park_and_ride.addl_walk_mins` and runs `gps_window_mins`; the evening one opens at the fence.

### `[incidents]`

A bounding box for the live incident feed and the District closure feed, covering the part of the route the regional feed does not reach. The box is applied to the closure records here, not on the
server; the live incidents and the closures inside it are then matched to the drive polyline, so only what sits on the road ahead counts.

Keep it tight to the route. A box drawn generously around one end of a commute is a way of publishing a home address, which is exactly what the rest of this document exists to prevent.

### `[[venues]]`

An allowlist, repeated once per venue, each with `name`, `lat`, `lon` and `weight`. A Ticketmaster venue may also carry `ticketmaster_venue_id`; a ballpark carries `provider = "mlb"` and `mlb_team_id`
instead.

`ticketmaster_venue_id` is optional and worth setting (CMB-42). The vendor allows two requests a second, and without the id every run spends one request per venue resolving a name to an id that never
changes. Add the venue without it once, read the id the run prints for it, then paste it in and keep `name`, `lat` and `lon` beside it as the human record of what the id means. With every venue's id
set, a run makes one Ticketmaster request. Lookups that remain are spaced at least half a second apart, a rate-limited call is retried once (honouring `Retry-After`, inside the run's deadline), and a
venue whose lookup still fails is lost alone: the others keep answering and the run notes which one is missing, with whatever rate-limit headers the vendor sent.

It is an allowlist rather than a radius search on purpose. Distance to the destination turns out to be the wrong metric. A twenty-thousand-seat arena whose crowds disperse away from the route matters
less than a six-thousand-seat hall sitting on the road out, because position relative to the route beats capacity. A radius promotes venues by size and has no idea which direction traffic leaves in.

A radius query is still a good way to *discover* candidates for this list. It is a poor way to filter it. Curate.

`weight` scales how far a scheduled event moves the confidence figure. Start everything at `1.0`. Adjust only once logged history shows that an event at that venue actually predicted a slower drive,
rather than because it feels like it should.

## Secrets

Not in this file, and not in any file. The engine reads them from the environment:

| Variable | Used for |
| --- | --- |
| `ROUTES_API_KEY` | Driving and transit durations |
| `TRAFFIC_API_KEY` | Live incidents on the unreached portion of the route |
| `EVENTS_API_KEY` | Scheduled events at the configured venues |

`TRANSIT_API_KEY` (WMATA rail alerts) is provisioned by the deploy script but nothing reads it yet; the engine neither scores its absence nor its presence until the rail-alerts module exists.

A missing optional key degrades one signal and lowers confidence, charged once as that signal's own "unavailable" result. It never blocks a verdict. A missing required key fails loudly at startup
rather than silently producing a worse answer, because a tool that quietly stops considering traffic is worse than one that refuses to start.

## Rides

The ride endpoints (CMB-151) keep each ride in one GCS object and start the tracker, a Cloud Run Job (CMB-152, `src/ride/job.js`, the same image), through the Run Admin API. Where those live comes
from the environment, read on every call and never printed. Any of the required ones missing makes `/ride/start` a 503 naming it; nothing crashes.

| Variable | Used for |
| --- | --- |
| `RIDE_BUCKET` | Required. GCS bucket holding `rides/<local-date>-<leg>.json`, one object per ride. Also passed to the Job as `RIDE_BUCKET`. |
| `RIDE_JOB_PROJECT` | Required. Project of the ride Job. |
| `RIDE_JOB_REGION` | Region of the ride Job (default `us-east4`). |
| `RIDE_JOB_NAME` | Name of the ride Job (default `switchtender-ride`). |
| `SHEETS_ACCESS_TOKEN` | A laptop run's access token for GCS and the Run API, the same one `[log]` uses. On Cloud Run the metadata server supplies the service identity's token instead. |

The Job reads its own environment once at start and exits 2 with the first missing name, touching nothing:

| Variable | Used for |
| --- | --- |
| `RIDE_KEY` | Required. The ride object's key, set per execution by `/ride/start`. |
| `RIDE_BUCKET` | Required. The bucket above, set per execution by `/ride/start`. |
| `RIDE_NTFY_TOPIC` | Required. The ntfy.sh topic the ride pushes go to. A second long random slug, never `NTFY_TOPIC`: the phone vibrates on this one and must not on the 7:30 verdict. |
| `RIDE_SERVICE_URL` | Required. The service's own URL, for the cancel buttons on each alert (`<url>/ride/cancel?...`). |
| `TRANSIT_API_KEY` | Required. The WMATA key, sent as the `api_key` header, never in a URL or a log line. |
| `SWITCHTENDER_CONFIG` | The config file (default `config.toml`), for the leg codes, `route.timezone` and `[log] sheet_id`. The Job never needs `ROUTES_API_KEY`. |
| `SHEETS_ACCESS_TOKEN` | A laptop run's token for GCS and Sheets, as above. |

All three endpoints are `POST`, take the `X-Switchtender-Key` header like `/verdict`, and `leg=am|pm`. No key is 401, a wrong method 405, an unknown leg 400, a GCS failure 503 `ride store failed`.

- `POST /ride/start?leg=am|pm[&at=ISO]` judges `at` (default: now; refused with 400 when more than two minutes from the server clock) against the leg's weekday window. Outside it answers 200
  `{ started: false, reason }`. Inside it creates the day's object with `ifGenerationMatch=0` (the atomic claim), starts the Job with `RIDE_KEY` set to the object key, and answers 200
  `{ started: true, ride, gps_from, gps_until, gps_from_epoch, gps_until_epoch, operation }`. The phone sends fixes between `gps_from` and `gps_until`. A second start that day is 200
  `{ started: false, reason: "already running", ... }` and launches nothing. A start whose launch fails is 502 and leaves the object at `status: launch_failed`; the next start takes that object over and
  launches again, as it does one still `launching` more than two minutes after its claim (a Job that never reported back).
- `POST /ride/fix?leg=am|pm` appends a fix. Fields `lat`, `lon`, `acc` (metres), `kmh` (km/h, as MacroDroid sends `{last_loc_speed_kmh}`) and `at` come as a small JSON body, as query parameters, or
  both (query wins). `lat` and `lon` are required and ranged; anything that is not a number is 400. The fix is stored in the phone's units with `speed_mps` beside it, however poor the accuracy: the
  Job decides what a fix is worth. Answers 200 `{ recorded, locked, cancelled, ended, done, status, fixes }`; once `done` is true the phone can stop sending, and nothing more is stored. No ride that day
  is 404.
- `POST /ride/cancel?leg=am|pm&reason=off|not-riding` marks the ride cancelled. The first reason sticks. Same body as a fix answer plus `cancelled: true`; no ride is 404. In place of the key it
  accepts `&token=<cancel_token>`, the random token the ride object was created with: the Job's ntfy buttons carry it, since ntfy keeps action URLs in the message for anyone holding the topic to read,
  and it opens nothing but a cancel of its own ride. A wrong token is 401; the token is compared in constant time and never appears in any endpoint answer.

The object shape, and which fields the endpoints own against which the Job owns, is documented at the top of `src/ride/state.js`. The rides tab (`[ride] sheet_tab`, columns in `RIDES_HEADER` in
`src/ride/log.js`) is written once per ride by the Job, never by the endpoints.

### The Job

One execution per ride, started by `/ride/start`. Morning only for now: a `pm` ride ends at once with reason `pm-not-built` (the evening start needs an underground-GPS gate the phone spike, CMB-149,
showed does not exist). The morning run:

1. Fetches StandardRoutes and jStations once, then polls TrainPositions every 15 s, every 5 s once a followed train is within one station of its alert station, and re-reads the ride object each poll
   for new fixes and a cancel.
2. Locks the first leg's train: candidates are Normal trains that left `board_code` the right way at or after `gps_from`; the phone's fixes (`accuracy_m` under 50 m, `speed_mps` over 5) must sit on
   exactly one of them (`src/ride/track.js`). On a lock the object gets `lock`, the phone is told to stop sending, and a quiet status goes out (`Tracking the 8:14 from Shady Grove`). No lock by
   `gps_until` plus two minutes ends the ride, reason `no-lock`, with a vibrating `Not tracking. Watch the stops.`; the Job never guesses a train.
3. Alerts on the locked train's arrival at the first leg's alert station (`Next stop Gallery Place. Transfer to Green.`). On its arrival at `alight_code` the second leg starts: the first two trains to
   leave that leg's `board_code` the right way at or after that arrival plus two minutes become candidates, and each alerts on arrival at the second leg's alert station naming its departure
   (`Next stop Waterfront. You're on the 8:47 from Gallery Place.`). The first candidate's alert vibrates until dismissed; the second's buzzes once.
4. Ends five minutes after the last alert (`done`), on a cancel (`cancelled`), when the locked train leaves the feed or goes out of service (`lost`, vibrating status), or after two hours (`timeout`,
   vibrating status); the feed failing two polls in a row is one vibrating status and polling goes on. Every end writes `ended { reason, at }` and the rides row and exits 0. A crash writes
   `ended { reason: "crash" }` and a vibrating status as best it can and exits 1, as do a feed that will not bootstrap (`feed`) and a leg without codes (`config`).

Every alert and status push is appended to the object (`alerts`, `statuses`) before it is sent, keyed, so a restarted Job never sends one twice.

### Ride push wire format (for the phone macro, CMB-154)

Every ride push is `POST https://ntfy.sh/<RIDE_NTFY_TOPIC>` with:

| Header or body | Value |
| --- | --- |
| `Title` | `Ride alert` for an alert that vibrates until dismissed; `Ride` for an alert that buzzes once; `Ride status` for a status line. |
| `Priority` | `5` for every alert and for a vibrating status; `3` for the quiet lock status. |
| body | `<text>\|<send epoch seconds>`, e.g. `Next stop Gallery Place. Transfer to Green.\|1761045600`. Split on `\|`; the last part is when it was sent, so delay is `{system_time}` minus it. |
| `Actions` | Alerts only: `http, I'm off, <RIDE_SERVICE_URL>/ride/cancel?leg=am&reason=off&token=<cancel_token>, clear=true; http, Not riding, <RIDE_SERVICE_URL>/ride/cancel?leg=am&reason=not-riding&token=<cancel_token>, clear=true` (ntfy `http` actions, default method POST). |

The texts: `Tracking the <h:mm> from <board>` (quiet status on lock), `Not tracking. Watch the stops.` (every vibrating status), `Next stop <alight>. Transfer to <line>.` (first leg),
`Next stop <alight>. You're on the <h:mm> from <board>.` (second leg). Times are local to `route.timezone` without a leading zero. The constants live in `src/ride/notify.js`.

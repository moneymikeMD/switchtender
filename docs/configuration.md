# Configuration

Two files, with a hard line between them.

`config.toml` holds everything that describes a commute: coordinates, timings,
thresholds, venues. It is gitignored. `config.example.toml` is the committed
template, and it describes a real Boston commute rather than a redacted version
of anyone's actual route, so it can be read, run and copied without anyone
having to wonder what was scrubbed out of it.

Secrets never appear in either. API keys come from the environment, which on a
maintainer machine is populated by a password manager rather than a file on
disk. See [Secrets](#secrets).

## The rule this file exists to enforce

The engine contains no coordinates. Not as defaults, not as fallbacks, not as
test fixtures outside the fixture directory. A coordinate compiled into source
is a coordinate that gets published the first time the repository does, and no
amount of tidying the working tree removes it from the history afterwards.

It is also what makes the tool reusable. Somebody else's commute is somebody
else's config file, not a fork.

## Shape

The tool assumes a commute with two options that share a common first leg and
diverge once. Drive the whole way, or park and take transit. Because the shared
leg is common to both it cancels out entirely, so the only thing that decides
the answer is what happens after the fork. This is why there is a
`decision_point` rather than a route: the engine does not care how you got
there.

## Keys

### `[route]`

| Key | Meaning |
| --- | --- |
| `timezone` | IANA name. Everything user-facing is local time; everything stored is UTC. |

### Places: one shape (CMB-33)

Every `[route.*]` table is a place with exactly four keys: `lat`, `lon`, a
human `label`, and `addl_walk_mins`. The label is what gets spoken and
logged, so write it the way you would say it out loud. `addl_walk_mins` is
the minutes on foot added to any leg that ends at that place; it defaults to
0 and may be left out. Any other key is an error that names it, so a renamed
or misspelt field can never silently become a zero.

### `[route.origin]`

Where the commute starts. It plays no part in the verdict at the fork, but
`npm start -- --from origin` or `GET /verdict?from=origin` measures the whole
trip from it, for a look at both options before leaving the house (CMB-30).
The spoken line then opens with "Starting from home." Its walk is the one
from the door to the car, counted only when measuring from here.

### `[route.decision_point]`

The fork. Past it the options are no longer interchangeable. No leg ends
here, so its walk is accepted and never used.

### `[route.park_and_ride]`

Where the driver would leave the car to take transit. Its walk is the time
from stopping the car to standing on the platform: garage queue, stairs, fare
gates. Measure it on a normal weekday rather than estimating it, because it is
a constant added to every transit verdict and a wrong value biases every
decision the tool ever makes in the same direction.

### `[route.destination]`

The door you walk through, not where the car stops. The transit leg is
measured to it, and so is the drive once the parking walk is added. The
transit answer already includes its final walk, so this place's walk is
normally 0.

### `[route.parking]` (optional)

Where the car actually stops when that is not the destination: a cheaper
garage a few blocks from work, say. With it present, driving is routed to the
parking spot and its walk (car to the destination door) is added to the
driving time, so both options end at the same door and the comparison is fair
(CMB-31). Leave the table out to drive to the destination itself. Time the
walk; do not guess it.

### `[trigger]`

`lead_miles` is how far before the decision point the verdict is delivered. Too
short and there is no time to act; too long and conditions change between the
verdict and the fork. This wants verifying in the car at real speed.

### `[decision]`

| Key | Meaning |
| --- | --- |
| `transit_wins_ties` | A tie means the model cannot tell the options apart. The train is the one whose duration does not degrade while you sit in it. |
| `minimum_drive_margin_minutes` | Floor on how much faster driving must be, zero or more. The required margin scales above this with the congestion signal. |
| `assumed_evening_departure` | `"HH:MM"` on a 24-hour clock. Used only when something about the evening is already known. |

Every value is checked at startup: a time zone the runtime does not know, a
`nan` or `inf` where a number belongs, a clock time that is not `HH:MM`, or a
venue coordinate out of range is a config error before any routing call is
paid for, not a failed verdict on the first morning.

On that last point: a morning verdict commits you to how you get home, so a
scheduled evening event is legitimately in scope. An afternoon crash is not,
and the tool does not guess at it.

### `[transit]`

`lines` names the Metrorail lines the transit leg rides, matched against
WMATA's planned track-work page. Any spelling the page would recognise loads
as the page's own (`"red"`, `"Red Line"` and `"RED"` all become `Red`); a
line the page does not list is a startup error, because a misspelt line would
otherwise report "no track work" on every run. Leave the list empty and the
signal stays quiet.

### `[incidents]`

A bounding box for the live incident feed and the District closure feed,
covering the part of the route the regional feed does not reach. The box is
applied to the closure records here, not on the server; the live incidents
and the closures inside it are then matched to the drive polyline, so only
what sits on the road ahead counts.

Keep it tight to the route. A box drawn generously around one end of a commute
is a way of publishing a home address, which is exactly what the rest of this
document exists to prevent.

### `[[venues]]`

An allowlist, repeated once per venue, each with `name`, `lat`, `lon` and
`weight`. A Ticketmaster venue may also carry `ticketmaster_venue_id`; a
ballpark carries `provider = "mlb"` and `mlb_team_id` instead.

`ticketmaster_venue_id` is optional and worth setting (CMB-42). The vendor
allows two requests a second, and without the id every run spends one
request per venue resolving a name to an id that never changes. Add the venue
without it once, read the id the run prints for it, then paste it in and keep
`name`, `lat` and `lon` beside it as the human record of what the id means.
With every venue's id set, a run makes one Ticketmaster request. Lookups that
remain are spaced at least half a second apart, a rate-limited call is retried
once (honouring `Retry-After`, inside the run's deadline), and a venue whose
lookup still fails is lost alone: the others keep answering and the run notes
which one is missing, with whatever rate-limit headers the vendor sent.

It is an allowlist rather than a radius search on purpose. Distance to the
destination turns out to be the wrong metric. A twenty-thousand-seat arena
whose crowds disperse away from the route matters less than a six-thousand-seat
hall sitting on the road out, because position relative to the route beats
capacity. A radius promotes venues by size and has no idea which direction
traffic leaves in.

A radius query is still a good way to *discover* candidates for this list. It
is a poor way to filter it. Curate.

`weight` scales how far a scheduled event moves the confidence figure. Start
everything at `1.0`. Adjust only once logged history shows that an event at
that venue actually predicted a slower drive, rather than because it feels like
it should.

## Secrets

Not in this file, and not in any file. The engine reads them from the
environment:

| Variable | Used for |
| --- | --- |
| `ROUTES_API_KEY` | Driving and transit durations |
| `TRAFFIC_API_KEY` | Live incidents on the unreached portion of the route |
| `EVENTS_API_KEY` | Scheduled events at the configured venues |

`TRANSIT_API_KEY` (WMATA rail alerts) is provisioned by the deploy script but
nothing reads it yet; the engine neither scores its absence nor its presence
until the rail-alerts module exists.

A missing optional key degrades one signal and lowers confidence, charged once
as that signal's own "unavailable" result. It never blocks a verdict. A missing required key fails loudly at startup rather than
silently producing a worse answer, because a tool that quietly stops
considering traffic is worse than one that refuses to start.

# switchtender

A switchtender is the railway worker who sets the switch at a junction and
decides which track a train takes. This tool does that for a commute. At a
fork you pass every morning, it reads live conditions and says, out loud,
whether to keep driving or park and take the train.

```
Keep driving. Driving is 38 minutes, the train is 84 minutes.
Driving saves 46 minutes, more than the 5 needed, the road ahead is clear,
planned road closure at Rochambeau Bridge. Confidence is moderate.
Keep driving.
```

One sentence, heard once at highway speed, then repeated so a half-heard
verdict is still unambiguous.

## The problem it solves

Plenty of commutes share this shape: you drive the first stretch no matter
what, then reach a point where you can either stay on the highway all the way
in or pull off to a park-and-ride and let transit finish the trip. The right
answer changes daily and the moment to decide is one exit wide.

Take the example commute this repository ships with. You live north-west of
Boston and drive Route 2 inbound. Where Route 2 meets I-95 you choose: stay on
Route 2 through Cambridge to downtown, or drop into the Alewife garage and ride
the Red Line. Most mornings driving wins by twenty minutes. On a morning with a
crash on Memorial Drive, a Bruins game letting out early, or single-tracking on
the Red Line, the answer flips, and you cannot tell which morning it is from
the driver's seat.

switchtender makes the call four miles before the fork, from a phone in the
cupholder, without you touching it.

## How it decides

Both options share the leg before the fork, so only the legs after it are
measured. The engine asks a routing API for two things: the drive from the
fork to the destination, and the drive from the fork to the garage plus the
transit ride from there. Transit wins ties. Driving is recommended only when
it beats transit by a margin that grows with how congested the road ahead
already is, because a drive estimate taken in heavy traffic is the one most
likely to be wrong.

Everything else only moves the confidence figure and the spoken reason, never
the verdict, until logged history proves it should:

| Signal | Source | Needs a key |
| --- | --- | --- |
| Durations and congestion along the polyline | Google Routes API | yes |
| Live incidents in the destination city | TomTom Traffic Incidents | yes |
| Live incidents on the highway approach | Maryland CHART (swap for your state's feed) | no |
| Planned road closures near the destination | DDOT permits (swap for your city's) | no |
| Events at venues you name | Ticketmaster, or MLB's schedule for a ballpark | yes / no |
| Planned rail track work | Operator's published schedule | no |

Every verdict and every input is appended to a Google Sheet and exposed to
BigQuery, so the starting guesses in the rule can be tuned against what
actually happened.

## Try it

You need Node 24 and a Google Routes API key. Everything else is optional and
degrades gracefully: a missing key lowers confidence, it never blocks a verdict.

```bash
git clone https://github.com/moneymikeMD/switchtender.git
cd switchtender
nvm use            # reads .nvmrc
npm ci
npm test           # no network, a few hundred milliseconds

cp config.example.toml config.toml
ROUTES_API_KEY=your-key npm start
```

The example config is a real, runnable Boston commute, so the first run works
before you edit anything. Then open `config.toml` and describe your own fork:
where you start, where the road splits, where the garage is, where you end
up, and which venues and rail lines matter to you. The engine holds no
coordinates of its own. Full key reference: [docs/configuration.md](docs/configuration.md).

To hear it the way you would in the car:

```bash
npm start 2>/dev/null | tail -1 | say      # macOS; use espeak or similar elsewhere
```

## Put it on the road

- **Serve it.** [docs/deploy.md](docs/deploy.md) deploys the same engine to
  Cloud Run behind a shared-secret header, scale-to-zero, secrets in Secret
  Manager, config mounted as a file. One script.
- **Fire it from the phone.** [docs/phone.md](docs/phone.md) and
  [docs/switchtender.macro](docs/switchtender.macro) give you a MacroDroid
  macro for Android: a geofence four miles before the fork triggers an HTTP
  call and speaks the answer over the car audio, weekday mornings only.
- **Know what it costs.** [docs/cost-routes.md](docs/cost-routes.md) works
  through the Routes API tiers. Two verdicts a weekday sits inside the free
  quota.

## Contributing

Issues and pull requests are welcome. Good first contributions:

- **A feed for your region.** The incident and closure sources are Maryland
  and DC specific behind small interfaces (`src/chart.js`, `src/closures.js`).
  A module for another state DOT or city permit feed, with a recorded
  fixture and tests, is exactly the shape this project wants.
- **Another operator's track-work page.** `src/trackwork.js` parses WMATA's
  table; other operators publish something similar.
- **A phone recipe for iOS.** The Android path exists; Shortcuts should be
  able to do the same.
- **Tuning evidence.** If you run this for a few weeks, the Sheet you build
  up is the data the rule's starting guesses are waiting for.

House rules, all enforced by tests where a test can reach:

- No coordinates in source. Every place comes from `config.toml`.
- Unknown is not clear. A signal that fails returns `null`, never `0`.
- Unproven signals change confidence, not the verdict.
- Data sources are ranked on live queries against the real area, never on
  their documentation, and a source with no current-month data is dropped.
- Fixtures recorded from public feeds get their free-text contact fields
  blanked before commit.

`npm test` must pass, and a new feed comes with a live-recorded fixture so the
tests never touch the network.

## Name

The v1 of this idea compared home-to-office against home-to-garage-to-office
and got nowhere, because the shared first leg cancelled out and hid the
signal. Measuring only the legs after the fork is the whole trick, and the
person who stands at the fork and throws the switch is the switchtender.

## License

MIT. See [LICENSE](LICENSE).

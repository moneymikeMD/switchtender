# CLAUDE.md

Context for Claude Code sessions opened in this repository.

## What this is

switchtender decides, at a fork in a commute, whether to keep driving or park
and take transit, and says the verdict out loud. The fork is configurable. Both
options share the leg before the fork, so only the legs after it are measured.

Node 24 (current LTS), ESM, one runtime dependency (`smol-toml`). Tests use `node:test`.

```
npm ci
npm test          # 26 tests, no network
cp config.example.toml config.toml
ROUTES_API_KEY=... npm start
```

## Where things live

- **Tickets:** Jira project key `CMB`, Space named Switchtender. The key is
  deliberately left over from the v1 project, Commuter Bot. The epic is CMB-7.
  The site host and the Jira wrapper are in the owner's night-watchman config,
  not in this repo.
- **Memory:** the global memory-graph. Recall with single nouns, one per call:
  `switchtender`, `commuter`, `cmb`, `tomtom`, `wmata`, `chart`, `ddot`.
- **Resume notes:** `docs/handoffs/`, newest first.
- **v1:** a separate private repository. It stays private forever because its
  history holds the owner's home coordinates. Nothing here depends on it.

## Rules

1. **No coordinates in source.** Every place, venue and bounding box comes from
   `config.toml`, which is gitignored. The committed example is a Boston
   commute and must stay one. A test fails if a maintainer coordinate shows up
   in it.
2. **Private until CMB-24.** A history rewrite is still cheap. Before the
   visibility flip, scan every commit, not just the working tree.
3. **Unproven signals change confidence, not the verdict.** Incidents,
   closures, events and track work move the confidence number and the spoken
   reason. None of them flips the decision until logged history shows it
   predicts a slower drive.
4. **Unknown is not clear.** A missing signal returns `null`, never `0`.
5. **Data source freshness is two tests.** For the source: does its newest
   record fall in the current month? If not, drop it. For a record: does its
   start-to-end window cover the commute? Never filter records by creation
   date.
6. **Rank data sources on a live query against the real area, never on their
   docs.** MapQuest's documented delay fields came back all zero for DC.
7. **Secrets come from the environment only.** Read keys at call time and never
   print them. Any key that automation or a remote session needs must be a
   normal 1Password item. 1Password Environments are invisible to the `op` CLI
   and to the mobile app.
8. **Commits are attributed to the owner alone.** No AI co-author or session
   trailers.

## Settled data sources

| Signal | Source | Auth |
| --- | --- | --- |
| Drive and transit durations, congestion | Google Routes API | `ROUTES_API_KEY` |
| Maryland live incidents | CHART `getEventMapDataJSON.do` | none |
| DC live incidents | TomTom Traffic Incident Details v5 | `TRAFFIC_API_KEY` |
| DC planned road closures | DDOT TOPS ArcGIS layers 10 and 11 | none |
| Venue events | Ticketmaster Discovery, filtered by a venue allowlist | `EVENTS_API_KEY` |
| Rail alerts | WMATA Incidents | `TRANSIT_API_KEY` |
| Planned track work | Scrape of the wmata.com track-work table | none |

Rejected, with the evidence in the tickets: MapQuest (CMB-22), HERE, Bing,
DDOT MajorEvent (no data after 2017), HSEMA road closures (no data after 2023),
WMATA GTFS-RT as a source of advance notice (CMB-27). Motorcades are a known
blind spot with no workaround.

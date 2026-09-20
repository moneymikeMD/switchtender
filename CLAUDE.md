# CLAUDE.md

Context for Claude Code sessions opened in this repository.

## What this is

switchtender decides, at a fork in a commute, whether to keep driving or park
and take transit, and says the verdict out loud. The fork is configurable. Both
options share the leg before the fork, so only the legs after it are measured.

Node 24 (current LTS), ESM, one runtime dependency (`smol-toml`). Tests use `node:test`.

```
npm ci
npm test          # no network
cp config.example.toml config.toml
ROUTES_API_KEY=... npm start
```

## Where things live

- **Tickets:** Jira project key `CMB`, Space named Switchtender. The key is
  deliberately left over from the v1 project, Commuter Bot. The epic is CMB-7.
  The site host and the Jira wrapper are in the owner's night-watchman config,
  not in this repo. This repo conforms to the
  [work-order](https://github.com/moneymikeMD/work-order) ticket contract at
  profile `minimal` — never night-watchman, which this repo does not run (see
  below). `docs/tickets.md` has the conformance claim, the plugin dependency
  that backs it, and a recorded gap in what can actually be machine-checked
  against live CMB tickets today.
- **Memory:** the global memory-graph. Recall with single nouns, one per call:
  `switchtender`, `commuter`, `cmb`, `tomtom`, `wmata`, `chart`, `ddot`.
- **Resume notes:** `docs/handoffs/`, newest first. Read only the newest.
- **Service:** Cloud Run `switchtender` in `commuter-bot-501717`, us-east4; `docs/deploy.md`.
- **Phone:** MacroDroid macro `docs/switchtender.macro`; `docs/phone.md`.
- **v1:** a separate private repository. It stays private forever because its
  history holds the owner's home coordinates. Nothing here depends on it.

## How work happens here

Fast code production with tests. This repo does not run the night-watchman
operating model: no session-start, wave trail, spec-reviewer or
script-reviewer here (owner decision 2026-09-16). A session reads memory-graph
and this file, dispatches one plain worktree subagent per ticket with disjoint
file ownership, reviews the diff, runs `npm test` and a live `npm start`.

**Every change lands through a PR, merged right away, not left open**
(owner decision 2026-09-18). `main` requires a pull request via a GitHub
ruleset — no direct push. For the owner (repo admin, bypass always) this
is for change visibility and a second, GitHub-native record of what
shipped, not a review gate: open the PR, merge it immediately once CI is
green. An outside contributor's PR is different — the repo is public, so
`required_approving_review_count: 1` applies to them: the owner reviews
and approves before anything from someone else merges. **PR bodies are capped at 1000
characters** (owner's rule; `.github/workflows/pr-body-length.yml` fails
the PR if it isn't). CI (`.github/workflows/ci.yml`) runs `npm test` on
every push and PR and is a required check. Close the Jira ticket with a
comment after merge.

Dependabot opens weekly PRs for npm and GitHub Actions dependencies
(`.github/dependabot.yml`); patch/minor updates auto-merge once CI passes
(`.github/workflows/dependabot-auto-merge.yml`), major bumps wait for a
human. `release-please` (`.github/workflows/release-please.yml`) opens a
release PR from Conventional Commits history and maintains `CHANGELOG.md`
on merge — commit subjects must stay Conventional Commits (rule 9) for
this to produce a sane changelog. `docs/` stays the source of truth for
prose docs; the GitHub Wiki mirrors `docs/*.md` automatically on push
(`.github/workflows/wiki-sync.yml`) — edit the repo, never the wiki
directly.

### GitHub Actions permissions and the GITHUB_TOKEN quirk

Repo setting **Settings > Actions > General > Workflow permissions** is
**"Read and write permissions"** with **"Allow GitHub Actions to create and
approve pull requests"** checked. Without it, `release-please` fails with
"GitHub Actions is not permitted to create or approve pull requests" — it
opens its own release PR using the default `GITHUB_TOKEN`, which needs that
grant.

**A commit pushed with the default `GITHUB_TOKEN` does not trigger other
workflows** (GitHub's anti-recursion guard). `release-please` rebasing its
own PR on every push to `main` is exactly this: the rebase commit lands,
but `ci.yml`'s `pull_request`/`push` triggers never fire, so the release
PR sits with stale or missing checks. Fix each time it happens: `gh pr
close <n> && gh pr reopen <n>` — a human/PAT-authored event, so it does
trigger the workflows normally. No permanent fix without a PAT in place of
`GITHUB_TOKEN` for that one workflow, which hasn't been set up here.

Bot-authored PRs (Dependabot, `release-please`'s `github-actions[bot]`)
are exempted from `pr-body-length.yml` — their bodies are generated
(a dependency changelog, a release changelog) and were never meant to
satisfy a human-authored 1000-char rule.

## Rules

1. **No coordinates in source.** Every place, venue and bounding box comes from
   `config.toml`, which is gitignored. The committed example is a Boston
   commute and must stay one. A test fails if a maintainer coordinate shows up
   in it.
2. **Public since 2026-09-16 (CMB-24).** History was rewritten once before
   the flip; it cannot be rewritten again. Anything committed now is
   published. Fixtures recorded from public feeds must have free-text contact
   fields blanked before commit.
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
9. **Commit subjects follow Conventional Commits** (`type: subject`, e.g.
   `fix:`, `feat:`, `chore:`, `docs:`). Adopted 2026-09-18; earlier history
   predates it and is not rewritten.

## Settled data sources

| Signal | Source | Auth |
| --- | --- | --- |
| Drive and transit durations, congestion | Google Routes API | `ROUTES_API_KEY` |
| Maryland live incidents | CHART `getEventMapDataJSON.do` | none |
| DC live incidents | TomTom Traffic Incident Details v5, matched to the route by geometry | `TRAFFIC_API_KEY` |
| DC planned road closures | DDOT TOPS ArcGIS layer 11 (only layer with IsRoadClosed), box applied client side (the server envelope cost 6 s), matched to the route | none |
| Venue events | Ticketmaster Discovery per configured venue; `provider = "mlb"` venues read MLB's keyless schedule instead | `EVENTS_API_KEY` |
| Rail alerts | WMATA Incidents (CMB-35), line-matched to `[transit] lines` | `TRANSIT_API_KEY` |
| Planned track work | Scrape of wmata.com/ride/planned-track-work.html, lines from `[transit]` | none |

Rejected, with the evidence in the tickets: MapQuest (CMB-22), HERE, Bing,
DDOT MajorEvent (no data after 2017), HSEMA road closures (no data after 2023),
WMATA GTFS-RT as a source of advance notice (CMB-27). Motorcades are a known
blind spot with no workaround.

# Cost ledger

A per-wave record of what a wave of agentic work on this repo cost, so a
cost review (or a human) can ask "did last wave's change actually move
the number" without re-deriving it from raw logs each time. Follows the
ledger convention from night-watchman's `docs/cost.md`
(`~/code/night-watchman/docs/cost.md`); this project
does not vendor the scripts itself and calls them by absolute path from
the night-watchman checkout.

## Files

- `docs/cost-ledger.tsv` — one row per wave (see schema below). Started
  2026-09-16 from night-watchman's `templates/cost-ledger.tsv`.
- `docs/cost-ledger.jsonl` — the ledger's append-only JSONL twin, written
  automatically by every `claude-cost.py append`. Not the source of
  truth; a convenience tail target for a log shipper. Don't "fix" the tsv
  from this file if the two look out of sync — investigate the jsonl
  append instead.

## Schema

One TSV row per wave: `date` (ISO-8601, when recorded), `wave` (short
unique label, e.g. `2026-09-16-eve`), `turns` (integer, total agent turns
for the wave), `cost_usd` (float, total wave cost), `model_mix` (free
text, e.g. `claude-fable-5-1:93,claude-sonnet-5:7`), `notes` (what
changed this wave / what was adopted from the previous review).

## Usage

```bash
# scan this repo's local transcripts for a session/window and get the
# exact --cost/--turns pair for a wave
python3 ~/code/night-watchman/scripts/claude-cost-scan.py \
  --repo ~/code/switchtender --since <wave start> --ledger-line

# append a wave's row
python3 ~/code/night-watchman/scripts/claude-cost.py append \
  --ledger docs/cost-ledger.tsv --wave <wave> --cost <usd> --turns <n> \
  --model "<mix>" --notes "<what changed / what was adopted>"

# delta against the previous wave (needs >=2 rows)
python3 ~/code/night-watchman/scripts/claude-cost.py compare \
  --ledger docs/cost-ledger.tsv --format md

# see the whole ledger
python3 ~/code/night-watchman/scripts/claude-cost.py list \
  --ledger docs/cost-ledger.tsv --format md
```

## What this project does not yet have

- No metrics backend (Grafana/Datadog/similar) wired in — the optional
  cross-check step in the cost-review procedure is skipped until one
  exists.
- No `docs/script-events.jsonl` yet — script lifecycle analytics
  (`scripts/script-analytics.py report --usage`) has nothing to read
  until a script-author/script-reviewer lane and its events hook exist
  in this repo. Skip that step of a cost review until it does.
- No night-watchman session-start/wave-trail artifacts wired in yet
  either (owner expectation recorded 2026-09-16 that these should exist
  on every dispatched wave) — a gap to close, not this ledger's job to
  fix.

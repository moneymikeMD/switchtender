#!/bin/bash
# Record WMATA TrainPositions fixtures for the ride tracker (CMB-150).
#
# Writes into OUT (default: ./positions-<utc stamp>/):
#   standard-routes.json   /TrainPositions/StandardRoutes, once
#   stations.json          /Rail.svc/json/jStations, once
#   positions-NNN.json     /TrainPositions/TrainPositions every INTERVAL
#                          seconds for DURATION seconds, with a `recordedAt`
#                          field added to each poll
#
# Inputs, none of them on the command line:
#   TRANSIT_API_KEY  the WMATA key (required, never printed)
#   OUT              output directory
#   INTERVAL         seconds between polls (default: 15)
#   DURATION         total seconds to record (default: 600)
#
# Everything recorded is public feed data. Run during a weekday 07:00-09:00
# window for peak-service fixtures; trim to the lines you need before commit.

set -euo pipefail

: "${TRANSIT_API_KEY:?set TRANSIT_API_KEY (not printed)}"
INTERVAL="${INTERVAL:-15}"
DURATION="${DURATION:-600}"
OUT="${OUT:-./positions-$(date -u +%Y%m%dT%H%M%SZ)}"
BASE="https://api.wmata.com"

mkdir -p "$OUT"

fetch() {
  curl -sS --fail --max-time 20 -H "api_key: $TRANSIT_API_KEY" "$BASE$1"
}

fetch '/TrainPositions/StandardRoutes?contentType=json' >"$OUT/standard-routes.json"
fetch '/Rail.svc/json/jStations' >"$OUT/stations.json"

polls=$((DURATION / INTERVAL))
for ((i = 1; i <= polls; i++)); do
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  file="$(printf '%s/positions-%03d.json' "$OUT" "$i")"
  if fetch '/TrainPositions/TrainPositions?contentType=json' | sed "s/^{/{\"recordedAt\":\"$stamp\",/" >"$file"; then
    echo "poll $i/$polls at $stamp"
  else
    echo "poll $i/$polls at $stamp failed" >&2
    rm -f "$file"
  fi
  ((i < polls)) && sleep "$INTERVAL"
done

echo "recorded $(ls "$OUT"/positions-*.json 2>/dev/null | wc -l | tr -d ' ') polls into $OUT"

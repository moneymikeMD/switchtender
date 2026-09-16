#!/bin/bash
# Define the BigQuery external table over the verdict log Sheet (CMB-11).
#
# Creates dataset `switchtender` (if missing) and (re)defines external table
# `switchtender.verdicts` with source format GOOGLE_SHEETS, reading the tab
# named in SHEET_TAB (default: verdicts), skipping the header row.
#
# The schema is generated from HEADER in src/log.js, so the two cannot drift.
# Every column is STRING for v1: the Sheet stores cells as text (RAW), the
# log is about 500 rows a year, and CAST() in the query is cheaper than a
# type mismatch that silently drops rows. Tighten types once the columns
# have settled.
#
# Inputs, none of them on the command line:
#   SHEET_ID     the spreadsheet id; if unset, read from 1Password:
#                op://Software_Development/Switchtender/commuter-bot google sheet id
#   SHEET_TAB    tab name (default: verdicts)
#   PROJECT      GCP project (default: commuter-bot-501717)
#   LOCATION     dataset location (default: US)
#
# The querying identity (whoever runs `bq query`) must be able to read the
# Sheet, and its gcloud credential needs the Drive read-only scope:
#   gcloud auth login --enable-gdrive-access
# Without that, bq reports "Permission denied while getting Drive credentials".

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$repo"

PROJECT="${PROJECT:-commuter-bot-501717}"
LOCATION="${LOCATION:-US}"
SHEET_TAB="${SHEET_TAB:-verdicts}"
DATASET="switchtender"
TABLE="verdicts"

if [ -z "${SHEET_ID:-}" ]; then
  SHEET_ID="$(op read "op://Software_Development/Switchtender/commuter-bot google sheet id")"
fi
if [ -z "$SHEET_ID" ]; then
  echo "bq-external-table: no sheet id (set SHEET_ID or sign in to 1Password)" >&2
  exit 1
fi

command -v bq >/dev/null || { echo "bq-external-table: bq CLI not found" >&2; exit 1; }
command -v node >/dev/null || { echo "bq-external-table: node not found" >&2; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
def="$workdir/verdicts.def.json"

# Schema from the single source of truth. Note the table definition file, not
# argv, carries the sheet id, so it never shows up in `ps` or shell history.
node --input-type=module - "$SHEET_ID" "$SHEET_TAB" >"$def" <<'EOF'
import { HEADER } from './src/log.js';
const [sheetId, tab] = process.argv.slice(2);
const def = {
  sourceFormat: 'GOOGLE_SHEETS',
  sourceUris: [`https://docs.google.com/spreadsheets/d/${sheetId}`],
  googleSheetsOptions: { skipLeadingRows: 1, range: tab },
  autodetect: false,
  schema: { fields: HEADER.map((name) => ({ name, type: 'STRING', mode: 'NULLABLE' })) },
};
process.stdout.write(JSON.stringify(def, null, 2));
EOF

echo "schema: $(node --input-type=module -e "import { HEADER } from './src/log.js'; console.log(HEADER.length)") STRING columns from src/log.js HEADER"

if ! bq --project_id="$PROJECT" show --format=none "$DATASET" >/dev/null 2>&1; then
  echo "creating dataset $PROJECT:$DATASET in $LOCATION"
  bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset \
    --description="switchtender verdict log (CMB-11)" "$DATASET"
else
  echo "dataset $PROJECT:$DATASET exists"
fi

# Redefine so a HEADER change is a re-run, not a manual edit.
if bq --project_id="$PROJECT" show --format=none "$DATASET.$TABLE" >/dev/null 2>&1; then
  echo "replacing external table $DATASET.$TABLE"
  bq --project_id="$PROJECT" rm -f -t "$DATASET.$TABLE"
fi
bq --project_id="$PROJECT" mk \
  --description="one row per verdict, external over the Google Sheet tab $SHEET_TAB" \
  --external_table_definition="$def" "$DATASET.$TABLE"

echo "defined $PROJECT.$DATASET.$TABLE over Sheet ...${SHEET_ID: -4} tab $SHEET_TAB"
echo "try: bq query --use_legacy_sql=false 'SELECT COUNT(*) FROM $DATASET.$TABLE'"

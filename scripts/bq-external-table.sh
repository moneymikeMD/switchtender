#!/bin/bash
# Define the BigQuery external tables over the log Sheet (CMB-11, CMB-41).
#
# Creates dataset `switchtender` (if missing) and (re)defines two external
# tables with source format GOOGLE_SHEETS, each skipping its header row:
#   switchtender.verdicts  over the tab in SHEET_TAB    (default: verdicts)
#   switchtender.arrivals  over the tab in ARRIVALS_TAB (default: arrivals)
#
# Schemas are generated from src/log.js (FULL_HEADER and ARRIVALS_HEADER), so
# the tables cannot drift from what the service writes.
# Every column is STRING for v1: the Sheet stores cells as text (RAW), the
# log is about 500 rows a year, and CAST() in the query is cheaper than a
# type mismatch that silently drops rows. Tighten types once the columns
# have settled.
#
# Inputs, none of them on the command line:
#   SHEET_ID     the spreadsheet id; if unset, read from 1Password:
#                op://Software_Development/Switchtender/commuter-bot google sheet id
#   SHEET_TAB    verdicts tab name (default: verdicts)
#   ARRIVALS_TAB arrivals tab name (default: arrivals)
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
ARRIVALS_TAB="${ARRIVALS_TAB:-arrivals}"
DATASET="switchtender"

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

# Write one table definition. The definition file, not argv, carries the
# sheet id, so it never shows up in `ps` or shell history.
write_def() {
  local header_export="$1" tab="$2" out="$3"
  node --input-type=module - "$SHEET_ID" "$tab" "$header_export" >"$out" <<'EOF_NODE'
import * as log from './src/log.js';
const [sheetId, tab, headerExport] = process.argv.slice(2);
const header = log[headerExport];
if (!Array.isArray(header)) throw new Error(`src/log.js does not export ${headerExport}`);
const def = {
  sourceFormat: 'GOOGLE_SHEETS',
  sourceUris: [`https://docs.google.com/spreadsheets/d/${sheetId}`],
  googleSheetsOptions: { skipLeadingRows: 1, range: tab },
  autodetect: false,
  schema: { fields: header.map((name) => ({ name, type: 'STRING', mode: 'NULLABLE' })) },
};
process.stdout.write(JSON.stringify(def, null, 2));
EOF_NODE
}

if ! bq --project_id="$PROJECT" show --format=none "$DATASET" >/dev/null 2>&1; then
  echo "creating dataset $PROJECT:$DATASET in $LOCATION"
  bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset \
    --description="switchtender verdict log (CMB-11)" "$DATASET"
else
  echo "dataset $PROJECT:$DATASET exists"
fi

# Redefine so a header change is a re-run, not a manual edit.
define_table() {
  local table="$1" header_export="$2" tab="$3" description="$4"
  local def="$workdir/$table.def.json"
  write_def "$header_export" "$tab" "$def"
  local columns
  columns="$(node -e "const d=require('$def');console.log(d.schema.fields.length)")"
  echo "schema: $columns STRING columns from src/log.js $header_export"
  if bq --project_id="$PROJECT" show --format=none "$DATASET.$table" >/dev/null 2>&1; then
    echo "replacing external table $DATASET.$table"
    bq --project_id="$PROJECT" rm -f -t "$DATASET.$table"
  fi
  bq --project_id="$PROJECT" mk \
    --description="$description, external over the Google Sheet tab $tab" \
    --external_table_definition="$def" "$DATASET.$table"
  echo "defined $PROJECT.$DATASET.$table over Sheet ...${SHEET_ID: -4} tab $tab"
}

define_table verdicts FULL_HEADER "$SHEET_TAB" "one row per verdict"
define_table arrivals ARRIVALS_HEADER "$ARRIVALS_TAB" "one row per phone-recorded arrival (CMB-41)"

echo "try: bq query --use_legacy_sql=false 'SELECT COUNT(*) FROM $DATASET.verdicts'"
echo "join: verdicts v JOIN arrivals a ON a.verdict_timestamp = v.timestamp"

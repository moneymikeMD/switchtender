// Verdict log: one wide row per verdict, appended to a Google Sheet (CMB-11).
//
// The log exists so the rule's starting guesses (the margin scale, the
// confidence penalties) can be tuned against what the engine actually saw.
// So every row carries the inputs needed to reconstruct the call, not just
// the call itself. About 500 rows a year: a Sheet, queried through a BigQuery
// external table, is plenty. A warehouse is not.
//
// Two invariants:
//   - Logging never blocks the verdict. Every exported entry point that talks
//     to the network swallows its failure and reports it as { ok: false }.
//   - The column order is defined once, in HEADER, and never reshuffled. A
//     row is an array aligned to HEADER, so adding a column means appending
//     to HEADER and to buildRow, and the BigQuery schema in
//     scripts/bq-external-table.sh is generated from HEADER.
//
// Signals that do not exist yet (weather) have their columns present and
// empty so the schema does not move when they arrive. Signals still being
// built (CHART, DDOT closures) arrive through `extras`, a flat object whose
// keys become columns after HEADER in insertion order.
//
// Authentication: no key files on disk. The logger takes an access token
// provider; see tokenFromEnvOrMetadata for the two supported sources.

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_TIMEOUT_MS = 1000;

/** Column order. Append only; never reorder. */
export const HEADER = Object.freeze([
  // when
  'timestamp',
  'local_date',
  'weekday',
  'season',
  'direction',
  // durations
  'drive_minutes',
  'drive_seconds',
  'transit_minutes',
  'transit_seconds',
  'park_drive_seconds',
  'park_buffer_seconds',
  'park_transit_seconds',
  'drive_distance_metres',
  // congestion on the drive-through leg
  'congestion_score',
  'congestion_normal_metres',
  'congestion_slow_metres',
  'congestion_jam_metres',
  'congestion_total_metres',
  'congestion_unknown',
  // live incidents
  'incidents_count',
  'incidents_score',
  'incidents_unstable',
  'incidents_by_category',
  'incidents_reasons',
  // signal availability
  'degraded_signals',
  // weather: not yet collected, columns reserved
  'weather_summary',
  'weather_temp_c',
  'weather_precip_mm',
  // the verdict and why
  'choice',
  'verdict_drive_minutes',
  'verdict_transit_minutes',
  'margin_minutes',
  'required_margin_minutes',
  'verdict_congestion_score',
  'verdict_incidents_score',
  'road_unstable',
  'confidence',
  'reasons',
  // rule parameters in force, so a row can be re-decided later
  'transit_wins_ties',
  'minimum_drive_margin_minutes',
  'engine_version',
]);

export const ENGINE_VERSION = 'switchtender/1.0.0';

// Meteorological seasons, northern hemisphere. The log is for a commute in
// one place; a hemisphere flag can come with the first southern user.
const SEASONS = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    timeZoneName: 'longOffset',
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) out[type] = value;
  // 'GMT-04:00' -> '-04:00'; plain 'GMT' means UTC.
  const offset = out.timeZoneName === 'GMT' ? '+00:00' : out.timeZoneName.replace('GMT', '');
  return { ...out, offset };
}

/** ISO 8601 timestamp with the configured zone's offset, plus local date and weekday. */
export function localTime(date, timeZone) {
  const p = partsIn(date, timeZone);
  const localDate = `${p.year}-${p.month}-${p.day}`;
  return {
    timestamp: `${localDate}T${p.hour}:${p.minute}:${p.second}${p.offset}`,
    localDate,
    weekday: p.weekday,
    season: SEASONS[Number(p.month) - 1],
  };
}

// A cell is a string. null and undefined are empty, never 0 (CLAUDE.md rule 4:
// unknown is not clear). Objects are JSON so a category breakdown survives.
export function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const joinList = (list, sep) => (Array.isArray(list) && list.length > 0 ? list.join(sep) : null);

/** Header for a row built with these extras: HEADER then the extra keys not already present. */
export function headerFor(extras = {}) {
  const extraKeys = Object.keys(extras ?? {}).filter((k) => !HEADER.includes(k));
  return [...HEADER, ...extraKeys];
}

/**
 * Build one row aligned to headerFor(extras).
 *
 * @param now       Date of the verdict.
 * @param config    the loaded config (route.timezone, decision, secrets.degraded).
 * @param options   routes.computeOptions result.
 * @param incidents incidents.fetchIncidents result, or null when not attempted.
 * @param verdict   verdict.decide result.
 * @param extras    flat { column: primitive } for signals not yet in HEADER.
 */
export function buildRow({ now = new Date(), config, options, incidents = null, verdict, extras = {} }) {
  const t = localTime(now, config?.route?.timezone ?? 'UTC');
  const drive = options?.driveThrough ?? {};
  const park = options?.parkAndRide ?? {};
  const congestion = drive.congestion ?? null;
  const metres = congestion && !congestion.unknown ? congestion.metres ?? {} : {};
  const degraded = config?.secrets?.degraded ?? [];

  const named = {
    timestamp: t.timestamp,
    local_date: t.localDate,
    weekday: t.weekday,
    season: t.season,
    // Every verdict so far is given on the way in. The evening leg is a
    // separate ticket; until then the value is constant so the column exists.
    direction: 'inbound',

    drive_minutes: drive.totalSeconds == null ? null : Math.round(drive.totalSeconds / 60),
    drive_seconds: drive.totalSeconds ?? null,
    transit_minutes: park.totalSeconds == null ? null : Math.round(park.totalSeconds / 60),
    transit_seconds: park.totalSeconds ?? null,
    park_drive_seconds: park.driveSeconds ?? null,
    park_buffer_seconds: park.bufferSeconds ?? null,
    park_transit_seconds: park.transitSeconds ?? null,
    drive_distance_metres: drive.distanceMeters ?? null,

    congestion_score: congestion && !congestion.unknown ? congestion.score : null,
    congestion_normal_metres: metres.NORMAL ?? null,
    congestion_slow_metres: metres.SLOW ?? null,
    congestion_jam_metres: metres.TRAFFIC_JAM ?? null,
    congestion_total_metres: congestion && !congestion.unknown ? congestion.totalMetres : null,
    congestion_unknown: congestion ? Boolean(congestion.unknown) : null,

    incidents_count: incidents?.count ?? null,
    incidents_score: incidents?.score ?? null,
    incidents_unstable: incidents ? Boolean(incidents.unstable) : null,
    incidents_by_category:
      incidents?.byCategory && Object.keys(incidents.byCategory).length > 0 ? incidents.byCategory : null,
    incidents_reasons: joinList(incidents?.reasons, ' | '),

    degraded_signals: joinList(degraded, ', '),

    weather_summary: null,
    weather_temp_c: null,
    weather_precip_mm: null,

    choice: verdict?.choice ?? null,
    verdict_drive_minutes: verdict?.driveMinutes ?? null,
    verdict_transit_minutes: verdict?.transitMinutes ?? null,
    margin_minutes: verdict?.marginMinutes ?? null,
    required_margin_minutes: verdict?.requiredMarginMinutes ?? null,
    verdict_congestion_score: verdict?.congestionScore ?? null,
    verdict_incidents_score: verdict?.incidentsScore ?? null,
    road_unstable: verdict ? Boolean(verdict.roadUnstable) : null,
    confidence: verdict?.confidence ?? null,
    reasons: joinList(verdict?.reasons, ' | '),

    transit_wins_ties: config?.decision?.transit_wins_ties ?? null,
    minimum_drive_margin_minutes: config?.decision?.minimum_drive_margin_minutes ?? null,
    engine_version: ENGINE_VERSION,
  };

  const header = headerFor(extras);
  return header.map((name) => cell(name in named ? named[name] : extras[name]));
}

// ---------------------------------------------------------------------------
// Sheets API

const rangeOf = (tab, a1) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);

async function sheetsCall(fetchImpl, token, method, url, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    return { ok: false, status: 0, error: `network: ${cause.message}` };
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = json?.error?.message ?? response.statusText ?? 'request failed';
    return { ok: false, status: response.status, error: `sheets ${response.status}: ${message}`, body: json };
  }
  return { ok: true, status: response.status, body: json };
}

/** Append one row. valueInputOption RAW: cells are stored exactly as sent. */
export async function appendRow(row, { sheetId, tab, token, fetchImpl = fetch }) {
  const url = `${SHEETS}/${sheetId}/values/${rangeOf(tab, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const result = await sheetsCall(fetchImpl, token, 'POST', url, { values: [row] });
  return { ok: result.ok, status: result.status, error: result.error ?? null };
}

/**
 * Make sure the tab exists and row 1 holds the header. Idempotent: a tab that
 * already has anything in A1 is left alone, so an existing log is never
 * overwritten and a v1 tab with its own header is never clobbered.
 */
export async function ensureHeader({ sheetId, tab, token, fetchImpl = fetch, header = HEADER }) {
  const readUrl = `${SHEETS}/${sheetId}/values/${rangeOf(tab, 'A1')}`;
  let read = await sheetsCall(fetchImpl, token, 'GET', readUrl);
  if (!read.ok && read.status === 400) {
    // "Unable to parse range": the tab does not exist yet. Create it.
    const added = await sheetsCall(fetchImpl, token, 'POST', `${SHEETS}/${sheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: tab } } }],
    });
    if (!added.ok) return { ok: false, status: added.status, error: added.error, created: false };
    read = { ok: true, status: 200, body: {} };
  }
  if (!read.ok) return { ok: false, status: read.status, error: read.error, created: false };
  const a1 = read.body?.values?.[0]?.[0];
  if (a1 !== undefined && a1 !== '') return { ok: true, status: 200, error: null, created: false };

  const writeUrl = `${SHEETS}/${sheetId}/values/${rangeOf(tab, 'A1')}?valueInputOption=RAW`;
  const wrote = await sheetsCall(fetchImpl, token, 'PUT', writeUrl, {
    range: `'${tab}'!A1`,
    majorDimension: 'ROWS',
    values: [Array.from(header)],
  });
  return { ok: wrote.ok, status: wrote.status, error: wrote.error ?? null, created: wrote.ok };
}

// ---------------------------------------------------------------------------
// Credentials

/**
 * Access token from the environment, else the GCE metadata server, else null.
 *
 * SHEETS_ACCESS_TOKEN is how a laptop run works (gcloud impersonating the
 * service account). The metadata server is how Cloud Run will work: the
 * service identity's token, no key file anywhere. The value is read at call
 * time and never printed (CLAUDE.md rule 7).
 */
export async function tokenFromEnvOrMetadata({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.SHEETS_ACCESS_TOKEN) return env.SHEETS_ACCESS_TOKEN;
  try {
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json?.access_token === 'string' && json.access_token ? json.access_token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestration

/**
 * Log one verdict. Never throws. Returns { ok, error }.
 *
 * @param tokenProvider async () => token string or null.
 */
export async function logVerdict({
  now = new Date(),
  config,
  options,
  incidents = null,
  verdict,
  extras = {},
  tokenProvider = tokenFromEnvOrMetadata,
  fetchImpl = fetch,
}) {
  try {
    const sheetId = config?.log?.sheet_id;
    const tab = config?.log?.sheet_tab ?? 'verdicts';
    if (!sheetId) return { ok: false, error: 'no sheet id configured' };

    const token = await tokenProvider();
    if (!token) return { ok: false, error: 'no credentials' };

    const row = buildRow({ now, config, options, incidents, verdict, extras });
    const target = { sheetId, tab, token, fetchImpl };

    const header = await ensureHeader({ ...target, header: headerFor(extras) });
    if (!header.ok) return { ok: false, error: header.error ?? `header check failed (${header.status})` };

    const appended = await appendRow(row, target);
    if (!appended.ok) return { ok: false, error: appended.error ?? `append failed (${appended.status})` };
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: `unexpected: ${cause?.message ?? cause}` };
  }
}

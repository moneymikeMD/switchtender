// Maryland live incidents and closures on the route, from CHART.
//
// CHART (the Maryland DOT traffic operations system) publishes its live
// incident and closure map layers as JSON at two public endpoints, no key.
// This module counts the records that sit on the configured driving route and
// keeps a short description of each, so the verdict can say "two incidents on
// the Maryland leg" and lower its confidence accordingly.
//
// Live payload shape, observed 2026-09-16 on both endpoints:
//
//   { data: [record...], error, success, totalCount, warnings }
//
// Each record carries (events endpoint; closures adds a few more):
//   id, name, description        description reads like
//                                "Action Event @ MD 202 (LANDOVER RD) @ FIRE HOUSE RD"
//                                or "Active Closure @ US 50 WEST BETWEEN ..."
//   lat, lon                     numbers, present on every record seen
//   county                       "Prince George's", "Montgomery", ...
//   direction                    "North", "West", "" ...
//   incidentType                 "Other", "Utility Problem", "Debris In Roadway"
//   lanesStatus                  free text: "All lanes open",
//                                "2/3 Eastbound-2 right Traffic Lanes, right Shoulder closed"
//   lanes                        array of { laneDescription, laneStatus, laneType, ... }
//   startDateTime, createTime    epoch milliseconds
//   lastCachedDataUpdateTime     epoch milliseconds
//   closed                       boolean, false on every live record (closed ones drop out)
//   type                         a numeric CHART event code (249 seen), meaning undocumented
// Closure records additionally have closureStartDate/closureEndDate (-1 when
// unset), lanesClosed, planned, reason, publicComments, trackingNumber.
//
// The feed is undocumented and can change without notice, so an unrecognised
// shape is a degraded result, never a thrown error (CLAUDE.md rule 4: unknown
// is null, not 0; rule 3: this moves confidence, never the verdict).
//
// Freshness is two tests (rule 5). The source: its newest record (by
// lastCachedDataUpdateTime, else startDateTime) must fall in the current
// month, or the whole signal is stale; an empty feed has nothing to date and
// is a real clear, as in trackwork.js. The record: its window must cover now,
// so a closure whose closureEndDate has passed, or whose start is still ahead,
// is not on the road this morning. Records with no dates at all are kept: the
// feed lists them as active and nothing here can disprove it. Nothing is
// filtered by createTime.
//
// Matching is geometric, against the decoded route polyline, never by road
// name: CHART's descriptions are free text and the route's road names are not
// exposed in a comparable form.

import { getJson } from './http.js';
import { nearPolyline } from './polyline.js';

export const CHART_EVENTS_URL = 'https://chartexp1.sha.maryland.gov/CHARTExportClientService/getEventMapDataJSON.do';
export const CHART_CLOSURES_URL = 'https://chartexp1.sha.maryland.gov/CHARTExportClientService/getActiveClosureMapDataJSON.do';

// How close an incident must be to a polyline point to count as "on the
// route". A tuning guess, not a measured value. The polyline at HIGH_QUALITY
// puts points every few tens of metres on curves and at most a few hundred
// metres apart on straights, so 400 m catches an incident sitting between two
// points on a straight highway stretch while excluding the parallel road a
// block over in most suburban geometry. Too tight and straight-stretch
// incidents fall through the gaps; too loose and cross streets and frontage
// roads count. Revisit once logged counts can be compared with what actually
// slowed the drive.
export const DEFAULT_RADIUS_METRES = 400;

// Spoken descriptions are capped so the verdict stays short.
const MAX_DESCRIPTIONS = 5;

const UNKNOWN_REASON = 'maryland incidents unavailable';

export const STALE_REASON = 'maryland records source stale';

/** The unknown shape: every count null, the reason naming the failure class. */
export function unknownChart(reason) {
  return { onRoute: null, total: null, descriptions: [], reasons: [`${UNKNOWN_REASON}: ${reason}`], score: null, sourceLive: null };
}

const unknown = unknownChart;

// Stale is distinct from unavailable, as in closures.js: the feed answered,
// and its newest record disqualifies it (rule 5).
function stale() {
  return { ...unknown(''), reasons: [STALE_REASON], sourceLive: false };
}

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

const epochMs = (v) => {
  const n = Number(v);
  // CHART uses -1 for "unset" on closure dates; anything non-positive is unknown.
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

function normaliseOne(raw, kind) {
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  return {
    kind,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    county: str(raw?.county),
    direction: str(raw?.direction),
    type: str(raw?.incidentType),
    lanes: str(raw?.lanesStatus),
    description: str(raw?.description) ?? str(raw?.name) ?? kind,
    startedAt: epochMs(raw?.startDateTime),
    // Closures carry an end date (-1 when unset); events have none.
    endsAt: epochMs(raw?.closureEndDate),
    updatedAt: epochMs(raw?.lastCachedDataUpdateTime),
  };
}

/**
 * CHART JSON -> array of normalised records.
 *
 * Returns null, not [], when the input is not a recognisable response: null
 * is "could not tell", [] is a real "nothing active in Maryland". `kind` tags
 * each record 'incident' or 'closure' so the two feeds can be merged and the
 * closures still named as such when spoken.
 */
export function normaliseChart(vendorJson, kind = 'incident') {
  const list = vendorJson?.data;
  if (!Array.isArray(list)) return null;
  return list.filter((r) => r && typeof r === 'object').map((r) => normaliseOne(r, kind));
}

/**
 * True when the incident lies within radiusMetres of the route polyline
 * (segments included; see polyline.nearPolyline). An incident with no
 * coordinates is never on the route.
 */
export function nearRoute(points, incident, radiusMetres = DEFAULT_RADIUS_METRES) {
  if (incident?.lat == null || incident?.lon == null) return false;
  return nearPolyline(points, [incident.lat, incident.lon], radiusMetres);
}

/**
 * Source freshness (rule 5, first test): the newest record falls in the
 * current month, compared in UTC as closures.js does. No records means
 * nothing to date, which is a clear, not a stale source. Records without any
 * date cannot vouch for the feed, so a non-empty feed with no dates is null:
 * could not tell.
 */
export function sourceIsLive(records, now = Date.now()) {
  if (!Array.isArray(records)) return null;
  if (records.length === 0) return true;
  let newest = null;
  for (const r of records) {
    const at = r.updatedAt ?? r.startedAt;
    if (at != null && (newest === null || at > newest)) newest = at;
  }
  if (newest === null) return null;
  const a = new Date(newest);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * Record freshness (rule 5, second test): the record's window covers now. A
 * start in the future or an end in the past rules it out; a missing bound is
 * open, since the feed lists the record as active.
 */
export function relevant(record, now = Date.now()) {
  if (!record) return false;
  if (record.startedAt != null && record.startedAt > now) return false;
  if (record.endsAt != null && record.endsAt < now) return false;
  return true;
}

// "Active Closure @ US 50 WEST BETWEEN SECOND ST AND MULBERRY DR (MM 66.0-64.0)"
// -> "closure: US 50 WEST BETWEEN SECOND ST AND MULBERRY DR". CHART prefixes
// its own event class before the "@"; the kind tag replaces it. Trailing
// mile-marker parentheticals are dropped to keep the spoken line short.
function describe(incident) {
  let text = incident.description
    .replace(/^[^@]*@\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  if (text.length > 80) text = `${text.slice(0, 77).trimEnd()}...`;
  const type = incident.type && incident.type !== 'Other' ? incident.type.toLowerCase() : incident.kind;
  return `${type}: ${text}`;
}

/**
 * Count normalised CHART records on the route.
 *
 * onRoute       records within the radius of the polyline, or null when unknown
 * total         records in the feed(s), or null when unknown
 * descriptions  up to five short strings, one per on-route record
 * reasons       spoken strings for the verdict
 * score         always null for now. The ticket logs and speaks the count; it
 *               does not score it, because no logged history yet shows that
 *               a CHART record on the route predicts a slower drive. Until it
 *               does, a number here would be a guess dressed as a measurement.
 */
export function assessChart(incidents, points, { now = Date.now(), radiusMetres = DEFAULT_RADIUS_METRES, sourceLive = null } = {}) {
  if (!Array.isArray(incidents)) return unknown('no data');
  if (!Array.isArray(points) || points.length === 0) return unknown('no route polyline');

  const hits = incidents.filter((i) => relevant(i, now) && nearRoute(points, i, radiusMetres));
  const descriptions = hits.slice(0, MAX_DESCRIPTIONS).map(describe);
  const reasons = [];
  if (hits.length > 0) {
    const noun = hits.length === 1 ? 'record' : 'records';
    reasons.push(`${hits.length} maryland ${noun} on the route: ${descriptions.join('; ')}`);
  }
  return { onRoute: hits.length, total: incidents.length, descriptions, reasons, score: null, sourceLive };
}

async function fetchOne(url, kind, fetchImpl, signal) {
  const { data, error } = await getJson(url, { fetchImpl, signal });
  if (error) return { error: `${kind}s ${error}` };
  // The envelope carries its own verdict on itself; success false with HTTP
  // 200 has not been seen but costs nothing to honour.
  if (data?.success === false) return { error: `${kind}s reported ${str(data?.error) ?? 'an error'}` };
  const normalised = normaliseChart(data, kind);
  if (normalised === null) return { error: `${kind}s response had no data list` };
  return { records: normalised };
}

/**
 * Fetch CHART events and closures in parallel and apply the source freshness
 * test, without assessing them, so the requests can go out before routing
 * has answered and assessChart can wait for the route polyline.
 *
 * Returns { records } or { failure }. If either feed fails the whole signal
 * is unknown: a count from half the feeds would read as a real count and
 * understate the road. Never throws.
 */
export async function loadChart(fetchImpl = fetch, { now = Date.now(), signal } = {}) {
  try {
    const results = await Promise.all([fetchOne(CHART_EVENTS_URL, 'incident', fetchImpl, signal), fetchOne(CHART_CLOSURES_URL, 'closure', fetchImpl, signal)]);
    const failed = results.find((r) => r.error);
    if (failed) return { failure: unknown(failed.error) };
    const records = results.flatMap((r) => r.records);
    const live = sourceIsLive(records, now);
    if (live === null) return { failure: unknown('no record carries a date') };
    if (!live) return { failure: stale() };
    return { records };
  } catch (cause) {
    return { failure: unknown(`unexpected error (${cause?.name ?? 'Error'})`) };
  }
}

/**
 * Fetch both CHART feeds and assess them against the decoded route polyline
 * ([[lat, lon], ...], from decodePolyline): loadChart then assessChart.
 * Never throws.
 */
export async function fetchChart(points, fetchImpl = fetch, { now = Date.now(), radiusMetres = DEFAULT_RADIUS_METRES, signal } = {}) {
  if (!Array.isArray(points) || points.length === 0) return unknown('no route polyline');
  const loaded = await loadChart(fetchImpl, { now, signal });
  if (loaded.failure) return loaded.failure;
  return assessChart(loaded.records, points, { now, radiusMetres, sourceLive: true });
}

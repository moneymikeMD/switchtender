// District planned road closures, read from the DDOT TOPS permit feed.
//
// A live incident feed sees a closure once the cones are out. A permit feed
// sees it weeks earlier, which is the whole point: a road on the approach that
// is booked shut for the next four months is a reason to trust the drive
// estimate less, even on a morning when nothing has gone wrong yet.
//
// Provider: the DDOT TOPS ArcGIS FeatureServer (CMB-23). No key. The
// "Active" layers are 10 (construction permits)
// and 11 (occupancy permits); layers 0 and 1 carry history back to 2010 and
// are not used.
//
// Schema, verified live 2026-09-16 against the service metadata:
//
//   layer 10 Active Construction Permit  no IsRoadClosed field; Status is an
//                                        integer (9 = Issued)
//   layer 11 Active Occupancy Permit     IsRoadClosed is a string 'Y' | 'N' |
//                                        null; Status is a string ('ISSUED')
//
// Both layers carry StatusDescription (string, 'Issued'), EffectiveDate,
// ExpirationDate and WorkLocationFullAddress. Dates arrive as epoch
// milliseconds. Because only layer 11 can say a road is closed, the default
// closure query reads layer 11 alone: the District-wide count of 114 issued
// closures in the ticket is exactly layer 11 with IsRoadClosed = 'Y'. Layer
// 10 is still addressable through closuresRequest for a future caller, but its
// records come back with roadClosed null (unknown, not false) and never count.
// Pulling it by default would fetch ~16,700 construction permits for the
// District box and learn nothing about the road.
//
// Rules this module answers to (CLAUDE.md): the bounding box comes from
// config.incidents and never from source; unknown is null, never 0; freshness
// is two tests (rule 5): the source is live only if its newest EffectiveDate
// falls in the current month, and a record is relevant only if its
// EffectiveDate..ExpirationDate window covers now. Records are never filtered
// by creation or issue date: a permit issued weeks ago whose window covers
// this morning is precisely the closure that matters. This signal moves
// confidence and the spoken reason, never the verdict.
//
// Route matching (CMB-28): the District box holds about 80 active closures on
// any given morning and almost none of them are on the drive. Permits are
// point features (a geocoded block midpoint), so each one is matched to the
// decoded drive polyline the way chart.js does it: point-to-vertex haversine
// within a radius. The box-wide count is kept as `total` for the log; `active`
// is the on-route count when route geometry is available.
//
// Geometry, verified live 2026-09-16: the layer's default output spatial
// reference is Web Mercator (wkid 102100) even for a WGS84 query, so the
// request asks for outSR=4326. With that, geometry.x is longitude and
// geometry.y is latitude.
//
// Why no server-side envelope. The ArcGIS envelope filter on layer 11 cost
// 6 to 7 seconds per query against a District-sized box (measured 2026-09-17)
// and returned the same 115 features as the bare where clause, which answers
// in a third of a second. Every record carries a point, so the bounding box
// is applied here, client side, and the box query no longer sits on the
// driver's wait. exceededTransferLimit is checked so a page cut short by the
// server's record cap is unknown rather than a short count.

import { getJson } from './http.js';
import { nearPolyline } from './polyline.js';

const ENDPOINT = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DDOT/TOPS/FeatureServer';

/** What each Active layer can say. Only 11 has a closure flag. */
export const LAYERS = {
  10: { name: 'construction', closedField: null },
  11: { name: 'occupancy', closedField: 'IsRoadClosed' },
};

/** Layers fetchClosures reads for closure records. See the header for why 10 is absent. */
export const CLOSURE_LAYERS = [11];

/** Layer whose newest EffectiveDate decides whether the source is live. */
export const LIVENESS_LAYER = 11;

const COMMON_FIELDS = ['WorkLocationFullAddress', 'StatusDescription', 'EffectiveDate', 'ExpirationDate'];

// Only issued permits. Rejected, cancelled and expired permits are absent from
// the Active layers in practice, but the clause costs nothing and guards
// against the layer's definition changing under us.
const ISSUED = "StatusDescription = 'Issued'";

const MAX_SPOKEN = 5;

// How close a permit point must be to a polyline vertex to count as on the
// route. A tuning guess, like chart.js's 400 m. Permits are geocoded to a
// block midpoint, and a DC block runs roughly 100 to 200 m, so 300 m reaches a
// permit on the block the route passes through (or its far end) while staying
// tighter than the CHART radius, since a permit two blocks over on a parallel
// street is noise. Revisit once logged on-route counts can be compared with
// what actually slowed the drive.
export const DEFAULT_RADIUS_METRES = 300;

export class ClosureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClosureError';
  }
}

function checkLayer(layer) {
  if (!LAYERS[layer]) {
    throw new ClosureError(`closures: layer ${layer} is not an Active TOPS layer (10 or 11)`);
  }
  return LAYERS[layer];
}

/** Throw unless the box has all four sides. The box is applied client side; see the header. */
export function checkBox(bbox) {
  for (const k of ['min_lon', 'min_lat', 'max_lon', 'max_lat']) {
    if (typeof bbox?.[k] !== 'number') {
      throw new ClosureError(`closures: bounding box is missing "${k}"`);
    }
  }
  return bbox;
}

/** True when the record has coordinates and they fall inside the box. Unplaceable is outside. */
export function inBox(record, bbox) {
  if (record?.lat == null || record?.lon == null) return false;
  return (
    record.lon >= bbox.min_lon && record.lon <= bbox.max_lon &&
    record.lat >= bbox.min_lat && record.lat <= bbox.max_lat
  );
}

/**
 * Build a FeatureServer query for one Active layer. No spatial filter (see
 * the header). Layer 11 adds the road-closed clause; layer 10 has no such
 * field and gets the issued clause alone. Point geometry comes back in WGS84
 * (outSR 4326) for the box test and route matching; the address stays the
 * spoken location.
 */
export function closuresRequest(layer = LIVENESS_LAYER) {
  const def = checkLayer(layer);
  const where = def.closedField ? `${def.closedField} = 'Y' AND ${ISSUED}` : ISSUED;
  const outFields = def.closedField ? [...COMMON_FIELDS, def.closedField] : COMMON_FIELDS;
  return {
    url: `${ENDPOINT}/${layer}/query`,
    params: {
      f: 'json',
      where,
      outFields: outFields.join(','),
      returnGeometry: 'true',
      outSR: '4326',
    },
  };
}

/**
 * Build the source-liveness query: the newest EffectiveDate across the whole
 * layer, no spatial filter. ExpirationDate would be wrong here (permits run
 * years into the future) and so would IssueDate (rule 5: never creation
 * dates). EffectiveDate is the newest thing the feed has started, which is
 * what "still being maintained" means.
 */
export function livenessRequest(layer = LIVENESS_LAYER) {
  checkLayer(layer);
  return {
    url: `${ENDPOINT}/${layer}/query`,
    params: {
      f: 'json',
      where: '1=1',
      outStatistics: JSON.stringify([
        { statisticType: 'max', onStatisticField: 'EffectiveDate', outStatisticFieldName: 'newest' },
      ]),
      returnGeometry: 'false',
    },
  };
}

// Epoch milliseconds, or null. An empty string is absent, not 1970: Number('')
// is 0, which would make a dateless permit effective since the epoch.
const epochMs = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// A coordinate is only a coordinate if it is a finite number. Anything else
// (absent geometry, a string, NaN) is null: an unplaceable permit, not one at
// the origin.
const coordinate = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function normaliseOne(feature, layer) {
  const a = feature?.attributes ?? {};
  const def = LAYERS[layer];
  let roadClosed = null;
  if (def?.closedField) {
    const flag = a[def.closedField];
    roadClosed = flag == null ? null : String(flag).toUpperCase() === 'Y';
  }
  // ArcGIS point geometry with outSR 4326: x is longitude, y is latitude.
  const g = feature?.geometry ?? {};
  return {
    address: typeof a.WorkLocationFullAddress === 'string' && a.WorkLocationFullAddress.trim()
      ? a.WorkLocationFullAddress.trim()
      : null,
    status: typeof a.StatusDescription === 'string' ? a.StatusDescription : null,
    effectiveAt: epochMs(a.EffectiveDate),
    expiresAt: epochMs(a.ExpirationDate),
    roadClosed,
    lat: coordinate(g.y),
    lon: coordinate(g.x),
    layer,
  };
}

/**
 * ArcGIS query JSON -> array of normalised permit records.
 *
 * Returns null, not [], when the input is not a recognisable response
 * (including an ArcGIS error envelope, which arrives with HTTP 200). An empty
 * array is a real "no closures in the box"; null is "could not tell".
 */
export function normaliseClosures(arcgisJson, layer = LIVENESS_LAYER) {
  if (arcgisJson?.error) return null;
  const list = arcgisJson?.features;
  if (!Array.isArray(list)) return null;
  return list.map((f) => normaliseOne(f, layer));
}

/**
 * Newest EffectiveDate (epoch ms) from a liveness response, or null.
 */
export function newestEffective(arcgisJson) {
  if (arcgisJson?.error) return null;
  return epochMs(arcgisJson?.features?.[0]?.attributes?.newest);
}

/**
 * Source freshness (rule 5, first test): does the newest record fall in the
 * current month? Compared in UTC; a permit effective on the 1st at midnight
 * local is still this month's in either zone for our purposes.
 */
export function sourceIsLive(newestMs, now = Date.now()) {
  if (newestMs == null) return null;
  const a = new Date(newestMs);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * Record freshness (rule 5, second test): does the permit's window cover now?
 * A null expiry is open-ended and counts. A null start cannot be placed and
 * does not. When the permit was created or issued plays no part.
 */
export function relevant(record, now = Date.now()) {
  if (record?.effectiveAt == null) return false;
  if (record.effectiveAt > now) return false;
  if (record.expiresAt == null) return true;
  return now <= record.expiresAt;
}

// '1300 MAINE AVENUE SW' -> '1300 Maine Avenue SW'. Quadrants stay upper so
// the speech engine says "south west" rather than trying to pronounce "sw".
const QUADRANT = /^(NW|NE|SW|SE)$/i;

export function spokenAddress(address) {
  if (!address) return 'an unnamed location';
  return address
    .split(/\s+/)
    .map((w) => (QUADRANT.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * True when the permit lies within radiusMetres of the drive polyline
 * (segments included; see polyline.nearPolyline). A permit with no
 * coordinates is never on the route: unknown is not near.
 */
export function nearRoute(points, record, radiusMetres = DEFAULT_RADIUS_METRES) {
  if (record?.lat == null || record?.lon == null) return false;
  return nearPolyline(points, [record.lat, record.lon], radiusMetres);
}

const UNKNOWN_REASON = 'planned closures unavailable';

export const STALE_REASON = 'planned closures source stale';

export const NO_ROUTE_REASON = 'planned closures counted District-wide: route geometry unavailable';

/** The unknown shape: every count null, the reason naming the failure class. */
export function unknownClosures(reason) {
  return {
    active: null, total: null, addresses: [], reasons: [`${UNKNOWN_REASON}: ${reason}`], score: null, sourceLive: null,
  };
}

const unknown = unknownClosures;

// Stale is a distinct outcome from unavailable: the feed answered, and its
// answer disqualifies it (rule 5). sourceLive false records that finding.
function stale() {
  return { active: null, total: null, addresses: [], reasons: [STALE_REASON], score: null, sourceLive: false };
}

/**
 * Reduce permit records to one planned-closure signal.
 *
 * active      closures whose window covers now AND that sit within
 *             radiusMetres of the drive polyline, or null when the input is
 *             null. Without route geometry (points null or empty) it falls
 *             back to the box-wide count and says so in reasons.
 * total       closures whose window covers now anywhere in the box, for the
 *             log. Equal to active in the fallback.
 * addresses   up to five distinct addresses of the counted closures
 * reasons     spoken strings, one per listed address, on-route ones first;
 *             in the fallback the route-unavailable note comes last
 * score       always null for now. The ticket asks for confidence and a
 *             spoken reason, not a scored verdict input; that waits for
 *             logged history showing a permit predicts a slower drive.
 * sourceLive  whether the source passed the current-month test, or null
 *             when nobody checked
 *
 * Only records the layer positively flags as a road closure count. Layer 10
 * records (roadClosed null) are unknown, and unknown is not a closure. A
 * relevant permit with no coordinates counts in total but never in the
 * on-route active count: it cannot be placed, and unplaceable is not near.
 */
export function assessClosures(
  records,
  { now = Date.now(), sourceLive = null, points = null, radiusMetres = DEFAULT_RADIUS_METRES } = {},
) {
  if (!Array.isArray(records)) return unknown('no data');
  const haveRoute = Array.isArray(points) && points.length > 0;
  const addresses = [];
  let active = 0;
  let total = 0;
  for (const r of records) {
    if (r.roadClosed !== true || !relevant(r, now)) continue;
    total += 1;
    if (haveRoute && !nearRoute(points, r, radiusMetres)) continue;
    active += 1;
    if (r.address && !addresses.includes(r.address) && addresses.length < MAX_SPOKEN) {
      addresses.push(r.address);
    }
  }
  const reasons = addresses.map((a) => `planned road closure at ${spokenAddress(a)}`);
  if (!haveRoute) reasons.push(NO_ROUTE_REASON);
  return { active, total, addresses, reasons, score: null, sourceLive };
}

/**
 * Fetch the closure layers and the liveness query in parallel, apply the
 * freshness test (rule 5, first test) and the configured box, and return the
 * records without assessing them, so the requests can go out before routing
 * has answered and assessClosures can wait for the route polyline.
 *
 * Returns { records, sourceLive: true } or { failure } where failure is the
 * unknown shape, or the stale shape when the source's newest record is
 * before this month: a feed nobody maintains can say nothing about this
 * morning, however many records it returned. Never throws.
 */
export async function loadClosures(config, fetchImpl = fetch, { now = Date.now(), signal } = {}) {
  try {
    let bbox;
    let requests;
    try {
      bbox = checkBox(config?.incidents);
      requests = CLOSURE_LAYERS.map((layer) => ({ layer, request: closuresRequest(layer) }));
    } catch (cause) {
      return { failure: unknown(cause.message) };
    }

    const [liveness, ...layers] = await Promise.all([
      getJson(livenessRequest(LIVENESS_LAYER), { fetchImpl, signal }),
      ...requests.map(({ request }) => getJson(request, { fetchImpl, signal })),
    ]);

    if (liveness.error) return { failure: unknown(`liveness ${liveness.error}`) };
    const newest = newestEffective(liveness.data);
    if (newest == null) return { failure: unknown('liveness response had no date') };
    if (!sourceIsLive(newest, now)) return { failure: stale() };

    const records = [];
    for (let i = 0; i < layers.length; i += 1) {
      const { layer } = requests[i];
      if (layers[i].error) return { failure: unknown(layers[i].error) };
      if (layers[i].data?.exceededTransferLimit === true) {
        return { failure: unknown(`layer ${layer} response was cut short by the server`) };
      }
      const normalised = normaliseClosures(layers[i].data, layer);
      if (normalised === null) return { failure: unknown(`layer ${layer} response had no feature list`) };
      records.push(...normalised.filter((r) => inBox(r, bbox)));
    }
    return { records, sourceLive: true };
  } catch (cause) {
    return { failure: unknown(`unexpected error (${cause?.name ?? 'Error'})`) };
  }
}

/**
 * Fetch planned closures for the configured box and assess them against the
 * route: loadClosures then assessClosures. Never throws.
 *
 * `points` is the decoded drive polyline ([lat, lon] pairs) used to pick out
 * the on-route closures; without it the result counts the whole box and says
 * so. The engine calls the two halves itself so the fetch overlaps routing.
 */
export async function fetchClosures(
  config,
  fetchImpl = fetch,
  { now = Date.now(), points = null, radiusMetres = DEFAULT_RADIUS_METRES, signal } = {},
) {
  const loaded = await loadClosures(config, fetchImpl, { now, signal });
  if (loaded.failure) return loaded.failure;
  return assessClosures(loaded.records, { now, sourceLive: true, points, radiusMetres });
}

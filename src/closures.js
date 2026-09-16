// District planned road closures, read from the DDOT TOPS permit feed.
//
// A live incident feed sees a closure once the cones are out. A permit feed
// sees it weeks earlier, which is the whole point: a road on the approach that
// is booked shut for the next four months is a reason to trust the drive
// estimate less, even on a morning when nothing has gone wrong yet.
//
// Provider: the DDOT TOPS ArcGIS FeatureServer (CMB-23). No key, supports an
// envelope geometry filter. The "Active" layers are 10 (construction permits)
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

/**
 * Build a FeatureServer query for the configured bounding box.
 *
 * Envelope geometry in WGS84 (inSR 4326), intersecting. Layer 11 adds the
 * road-closed clause; layer 10 has no such field and gets the issued clause
 * alone. No geometry comes back: the address is the spoken location.
 */
export function closuresRequest(bbox, layer = LIVENESS_LAYER) {
  const def = checkLayer(layer);
  for (const k of ['min_lon', 'min_lat', 'max_lon', 'max_lat']) {
    if (typeof bbox?.[k] !== 'number') {
      throw new ClosureError(`closures: bounding box is missing "${k}"`);
    }
  }
  const where = def.closedField ? `${def.closedField} = 'Y' AND ${ISSUED}` : ISSUED;
  const outFields = def.closedField ? [...COMMON_FIELDS, def.closedField] : COMMON_FIELDS;
  return {
    url: `${ENDPOINT}/${layer}/query`,
    params: {
      f: 'json',
      where,
      geometry: JSON.stringify({
        xmin: bbox.min_lon,
        ymin: bbox.min_lat,
        xmax: bbox.max_lon,
        ymax: bbox.max_lat,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: outFields.join(','),
      returnGeometry: 'false',
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

const epochMs = (value) => {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? null : n;
};

function normaliseOne(feature, layer) {
  const a = feature?.attributes ?? {};
  const def = LAYERS[layer];
  let roadClosed = null;
  if (def?.closedField) {
    const flag = a[def.closedField];
    roadClosed = flag == null ? null : String(flag).toUpperCase() === 'Y';
  }
  return {
    address: typeof a.WorkLocationFullAddress === 'string' && a.WorkLocationFullAddress.trim()
      ? a.WorkLocationFullAddress.trim()
      : null,
    status: typeof a.StatusDescription === 'string' ? a.StatusDescription : null,
    effectiveAt: epochMs(a.EffectiveDate),
    expiresAt: epochMs(a.ExpirationDate),
    roadClosed,
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

const UNKNOWN_REASON = 'planned closures unavailable';

export const STALE_REASON = 'planned closures source stale';

function unknown(reason) {
  return { active: null, addresses: [], reasons: [`${UNKNOWN_REASON}: ${reason}`], score: null, sourceLive: null };
}

// Stale is a distinct outcome from unavailable: the feed answered, and its
// answer disqualifies it (rule 5). sourceLive false records that finding.
function stale() {
  return { active: null, addresses: [], reasons: [STALE_REASON], score: null, sourceLive: false };
}

/**
 * Reduce permit records to one planned-closure signal.
 *
 * active      closures whose window covers now, or null when the input is null
 * addresses   up to five distinct addresses of those closures
 * reasons     spoken strings, one per listed address
 * score       always null for now. The ticket asks for confidence and a
 *             spoken reason, not a scored verdict input; that waits for
 *             logged history showing a permit predicts a slower drive.
 * sourceLive  whether the source passed the current-month test, or null
 *             when nobody checked
 *
 * Only records the layer positively flags as a road closure count. Layer 10
 * records (roadClosed null) are unknown, and unknown is not a closure.
 */
export function assessClosures(records, { now = Date.now(), sourceLive = null } = {}) {
  if (!Array.isArray(records)) return unknown('no data');
  const addresses = [];
  let active = 0;
  for (const r of records) {
    if (r.roadClosed !== true || !relevant(r, now)) continue;
    active += 1;
    if (r.address && !addresses.includes(r.address) && addresses.length < MAX_SPOKEN) {
      addresses.push(r.address);
    }
  }
  return {
    active,
    addresses,
    reasons: addresses.map((a) => `planned road closure at ${spokenAddress(a)}`),
    score: null,
    sourceLive,
  };
}

async function getJson(request, fetchImpl) {
  const url = new URL(request.url);
  for (const [k, v] of Object.entries(request.params)) url.searchParams.set(k, v);
  let response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (cause) {
    return { error: `network error (${cause?.name ?? 'Error'})` };
  }
  if (!response.ok) return { error: `HTTP ${response.status}` };
  try {
    return { data: await response.json() };
  } catch {
    return { error: 'unparseable response' };
  }
}

/**
 * Fetch planned closures for the configured box and assess them.
 *
 * The closure layers and the liveness query run in parallel. A stale source
 * (newest record before this month) is unknown with the reason 'planned
 * closures source stale', however many records it returned: a feed nobody
 * maintains can say nothing about this morning. Never throws.
 */
export async function fetchClosures(config, fetchImpl = fetch, { now = Date.now() } = {}) {
  let requests;
  try {
    requests = CLOSURE_LAYERS.map((layer) => ({ layer, request: closuresRequest(config?.incidents, layer) }));
  } catch (cause) {
    return unknown(cause.message);
  }

  const [liveness, ...layers] = await Promise.all([
    getJson(livenessRequest(LIVENESS_LAYER), fetchImpl),
    ...requests.map(({ request }) => getJson(request, fetchImpl)),
  ]);

  if (liveness.error) return unknown(`liveness ${liveness.error}`);
  const newest = newestEffective(liveness.data);
  if (newest == null) return unknown('liveness response had no date');
  if (!sourceIsLive(newest, now)) return stale();

  const records = [];
  for (let i = 0; i < layers.length; i += 1) {
    if (layers[i].error) return unknown(layers[i].error);
    const normalised = normaliseClosures(layers[i].data, requests[i].layer);
    if (normalised === null) return unknown(`layer ${requests[i].layer} response had no feature list`);
    records.push(...normalised);
  }
  return assessClosures(records, { now, sourceLive: true });
}

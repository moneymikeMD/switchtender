// Live District incidents, reduced to one trajectory signal.
//
// A traffic-adjusted drive duration says the road is slow now. It says nothing
// about whether it is about to get worse. Congestion behind a fresh crash or a
// closure that has just gone in has a rising trajectory; steady rush-hour
// congestion does not. The routing API cannot tell those apart, so this module
// asks a live incident source for the cause and boils the answer down to one
// question: is the drive estimate stable?
//
// Provider: TomTom Traffic Incident Details v5, chosen over MapQuest on a live
// query against the real box (CMB-22; MapQuest's delay fields were all zero
// for DC). The vendor is hidden behind normaliseIncidents so a swap touches
// this file only. The engine consumes the normalised shape, never the vendor's.
//
// Rules this module answers to (CLAUDE.md): the bounding box comes from
// config.incidents and never from source; the key is read at call time and
// never logged; unknown is null, never 0; this signal moves confidence and the
// spoken reason, never the verdict.

const ENDPOINT = 'https://api.tomtom.com/traffic/services/5/incidentDetails';

// Fields requested from the vendor. A brace expression, per the v5 docs.
const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,' +
  'events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';

/**
 * TomTom iconCategory -> normalised category.
 *
 * Source: https://developer.tomtom.com/traffic-api/documentation/traffic-incidents/incident-details
 * (Response data, properties.iconCategory), read 2026-09-16.
 *
 *   code  TomTom meaning         normalised
 *   ----  ---------------------  ----------
 *    0    Unknown                other
 *    1    Accident               accident
 *    2    Fog                    hazard
 *    3    Dangerous Conditions   hazard
 *    4    Rain                   hazard
 *    5    Ice                    hazard
 *    6    Jam                    jam
 *    7    Lane Closed            closure    (a lane, not the road; see FRESH_CLOSURE_MS)
 *    8    Road Closed            closure
 *    9    Road Works             roadworks
 *   10    Wind                   hazard
 *   11    Flooding               hazard
 *   14    Broken Down Vehicle    hazard
 *
 * Codes not in the table (12, 13, anything new) fall through to 'other'.
 */
export const ICON_CATEGORY = {
  0: 'other',
  1: 'accident',
  2: 'hazard',
  3: 'hazard',
  4: 'hazard',
  5: 'hazard',
  6: 'jam',
  7: 'closure',
  8: 'closure',
  9: 'roadworks',
  10: 'hazard',
  11: 'hazard',
  14: 'hazard',
};

export const CATEGORIES = ['accident', 'closure', 'roadworks', 'jam', 'hazard', 'other'];

// magnitudeOfDelay, same doc: 0 unknown, 1 minor, 2 moderate, 3 major,
// 4 undefined ("used for road closures"). So 4 is not "worse than major"; it
// is the vendor declining to measure a road that is shut.
const SEVERITY_MAX = 4;

// A closure counts toward instability only while it is new. The live DC box
// on 2026-09-16 held 19 road closures, most of them weeks old with no end
// time: streets shut for construction that the routing API has long since
// routed around. Those are steady state, not a rising trajectory. A closure
// that went in within this window is the one whose queue is still forming.
// Tuning knob; two hours is a first guess, not a measured value.
export const FRESH_CLOSURE_MS = 2 * 60 * 60 * 1000;

// An accident counts unless the vendor has measured its delay and called it
// minor. Unknown magnitude (0) counts: a crash reported a minute ago has no
// measured delay yet, and that is precisely the case this signal exists for.
// Unknown is not clear.
const ACCIDENT_MIN_SEVERITY = 2;

// How much each triggering incident pushes the 0..1 score. Unknown magnitude
// is treated as moderate rather than as nothing. Descriptive weights, not a
// calibrated model; the verdict rule decides what the number is worth.
const SEVERITY_WEIGHT = { 0: 0.5, 1: 0.25, 2: 0.5, 3: 0.75, 4: 0.75 };

export class IncidentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncidentError';
  }
}

/**
 * Build the request from the configured bounding box. No key here: the key is
 * added at call time so this object can be logged or asserted on safely.
 */
export function incidentsRequest(bbox) {
  for (const k of ['min_lon', 'min_lat', 'max_lon', 'max_lat']) {
    if (typeof bbox?.[k] !== 'number') {
      throw new IncidentError(`incidents: bounding box is missing "${k}"`);
    }
  }
  return {
    url: ENDPOINT,
    params: {
      // TomTom wants lon,lat,lon,lat: min corner then max corner.
      bbox: [bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat].join(','),
      fields: FIELDS,
      language: 'en-GB',
      // Only incidents in force now. Future-dated planned closures are the
      // DDOT TOPS source's job, not this one's.
      timeValidityFilter: 'present',
    },
  };
}

const clampSeverity = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, SEVERITY_MAX);
};

function normaliseOne(raw) {
  const p = raw?.properties ?? {};
  const events = Array.isArray(p.events) ? p.events : [];
  const iconCategory = p.iconCategory ?? events[0]?.iconCategory;
  const descriptions = events
    .map((e) => e?.description)
    .filter((d) => typeof d === 'string' && d.length > 0);
  const delay = Number(p.delay);
  return {
    category: ICON_CATEGORY[iconCategory] ?? 'other',
    severity: clampSeverity(p.magnitudeOfDelay),
    delaySeconds: p.delay == null || !Number.isFinite(delay) ? null : Math.round(delay),
    description: descriptions.length > 0 ? descriptions.join('; ') : 'incident',
    road: Array.isArray(p.roadNumbers) && p.roadNumbers.length > 0 ? String(p.roadNumbers[0]) : null,
    from: typeof p.from === 'string' ? p.from : null,
    to: typeof p.to === 'string' ? p.to : null,
    startedAt: typeof p.startTime === 'string' ? p.startTime : null,
  };
}

/**
 * Vendor JSON -> array of normalised incidents.
 *
 * Returns null, not [], when the input is not a recognisable response. An
 * empty array is a real "nothing in the box"; null is "could not tell".
 */
export function normaliseIncidents(vendorJson) {
  const list = vendorJson?.incidents;
  if (!Array.isArray(list)) return null;
  return list.map(normaliseOne);
}

const UNKNOWN_REASON = 'live incidents unavailable';

function unknown(reason) {
  return {
    unstable: false,
    score: null,
    count: null,
    byCategory: {},
    reasons: [`${UNKNOWN_REASON}: ${reason}`],
  };
}

function isFresh(incident, now) {
  if (!incident.startedAt) return false;
  const started = Date.parse(incident.startedAt);
  if (!Number.isFinite(started)) return false;
  return now - started <= FRESH_CLOSURE_MS;
}

function triggers(incident, now) {
  if (incident.category === 'accident') {
    return incident.severity === 0 || incident.severity >= ACCIDENT_MIN_SEVERITY;
  }
  if (incident.category === 'closure') {
    return isFresh(incident, now);
  }
  return false;
}

function describe(incident) {
  const where = incident.from
    ? incident.to
      ? `${incident.from} to ${incident.to}`
      : incident.from
    : incident.road ?? 'an unnamed road';
  const delay =
    incident.delaySeconds != null && incident.delaySeconds > 0
      ? `, ${Math.round(incident.delaySeconds / 60)} minutes of delay`
      : '';
  return `${incident.category} on ${where}${delay}`;
}

/**
 * Reduce a list of incidents to one instability signal.
 *
 * unstable   true when a triggering accident or fresh closure exists
 * score      0..1, or null when the input is null (unknown, not clear)
 * count      incidents in the box, or null when unknown
 * byCategory incident count per normalised category
 * reasons    spoken strings, one per triggering incident
 *
 * Jams and roadworks are counted and reported but never trigger: they are
 * steady state, and the traffic-aware duration already contains them.
 */
export function assessTrajectory(incidents, { now = Date.now() } = {}) {
  if (!Array.isArray(incidents)) return unknown('no data');

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const reasons = [];
  let weight = 0;
  for (const incident of incidents) {
    byCategory[incident.category] = (byCategory[incident.category] ?? 0) + 1;
    if (triggers(incident, now)) {
      weight += SEVERITY_WEIGHT[incident.severity] ?? SEVERITY_WEIGHT[0];
      reasons.push(describe(incident));
    }
  }
  return {
    unstable: reasons.length > 0,
    score: Math.min(1, weight),
    count: incidents.length,
    byCategory,
    reasons,
  };
}

/**
 * Fetch live incidents for the configured box and assess them.
 *
 * Never throws: this is an optional signal, and losing it is a lower
 * confidence, not a missing verdict. Any failure yields the unknown shape with
 * a reason that names the failure class and never the key or the URL.
 */
export async function fetchIncidents(config, apiKey, fetchImpl = fetch) {
  if (!apiKey) return unknown('no TRAFFIC_API_KEY');

  let request;
  try {
    request = incidentsRequest(config?.incidents);
  } catch (cause) {
    return unknown(cause.message);
  }

  const url = new URL(request.url);
  for (const [k, v] of Object.entries(request.params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey);

  let response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (cause) {
    // A network error's message can embed the URL, and the URL carries the key.
    return unknown(`network error (${cause?.name ?? 'Error'})`);
  }
  if (!response.ok) return unknown(`HTTP ${response.status}`);

  let data;
  try {
    data = await response.json();
  } catch {
    return unknown('unparseable response');
  }

  const normalised = normaliseIncidents(data);
  if (normalised === null) return unknown('response had no incident list');
  return assessTrajectory(normalised);
}

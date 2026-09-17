// The two onward options, measured from the fork.
//
// Everything before the fork is common to both choices and cancels out, so it
// is never requested for the verdict. Two options come back:
//
//   keep driving   one DRIVE request, fork to the parking spot (or the
//                  destination when no separate parking is configured), plus
//                  the configured walk from the car to the door (CMB-31)
//   park and ride  one DRIVE request fork to the park-and-ride, plus the
//                  configured park-to-platform buffer, plus one TRANSIT
//                  request from there to the destination, departing when
//                  the driver would actually reach the platform (CMB-29)
//
// Three requests, because the optimal traffic preference applies to driving
// only and transit must therefore be asked for separately. The two drives go
// out together; the transit request waits for the drive-to-lot answer, since
// its departure time depends on it.
//
// On request (CMB-30) the same three legs are measured from the origin
// instead, for a whole-trip estimate before leaving home. The rule is the
// same; only the starting point moves.

import { decodePolyline, cumulativeDistances } from './polyline.js';

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// How much each speed class counts toward the congestion score. NORMAL is
// free, a jam is the whole cost, slow is half. These are weights on a
// descriptive measure, not a calibrated model; the verdict rule consumes the
// score and decides what it is worth.
const SPEED_WEIGHT = { NORMAL: 0, SLOW: 0.5, TRAFFIC_JAM: 1 };

const DRIVE_FIELDS = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.travelAdvisory.speedReadingIntervals',
].join(',');

const TRANSIT_FIELDS = ['routes.duration', 'routes.distanceMeters'].join(',');

export class RouteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteError';
  }
}

const waypoint = ({ lat, lon }) => ({ location: { latLng: { latitude: lat, longitude: lon } } });

/** "1234s" -> 1234. The API returns durations as second-suffixed strings. */
export function parseDuration(value) {
  if (typeof value !== 'string' || !value.endsWith('s')) {
    throw new RouteError(`routes: unexpected duration format ${JSON.stringify(value)}`);
  }
  const seconds = Number(value.slice(0, -1));
  if (!Number.isFinite(seconds)) {
    throw new RouteError(`routes: unparseable duration ${JSON.stringify(value)}`);
  }
  return Math.round(seconds);
}

/**
 * Collapse speed intervals into one congestion measure, weighted by distance.
 *
 * Returns a score from 0 (all clear) to 1 (jammed end to end), the metres in
 * each class, and the share of the route each class covers. The score is the
 * number the verdict rule reads; the breakdown is what gets spoken and logged,
 * because "eleven minutes of it is jammed" is a sentence and 0.42 is not.
 *
 * Intervals that are absent, empty, or unaccompanied by a polyline yield a
 * null score rather than a zero. Zero would claim the road is clear, which is
 * a different and much worse statement than not knowing.
 */
export function summariseCongestion(route) {
  const intervals = route?.travelAdvisory?.speedReadingIntervals;
  const encoded = route?.polyline?.encodedPolyline;
  if (!Array.isArray(intervals) || intervals.length === 0 || !encoded) {
    return { score: null, metres: {}, share: {}, totalMetres: 0, unknown: true };
  }

  const cumulative = cumulativeDistances(decodePolyline(encoded));
  const lastIndex = cumulative.length - 1;
  const metres = { NORMAL: 0, SLOW: 0, TRAFFIC_JAM: 0 };

  for (const interval of intervals) {
    const start = Math.max(0, Math.min(interval.startPolylinePointIndex ?? 0, lastIndex));
    const end = Math.max(0, Math.min(interval.endPolylinePointIndex ?? 0, lastIndex));
    if (end <= start) continue;
    const speed = interval.speed;
    if (!(speed in metres)) continue;
    metres[speed] += cumulative[end] - cumulative[start];
  }

  const totalMetres = metres.NORMAL + metres.SLOW + metres.TRAFFIC_JAM;
  if (totalMetres === 0) {
    return { score: null, metres, share: {}, totalMetres: 0, unknown: true };
  }

  let weighted = 0;
  const share = {};
  for (const [speed, m] of Object.entries(metres)) {
    weighted += SPEED_WEIGHT[speed] * m;
    share[speed] = m / totalMetres;
  }
  return { score: weighted / totalMetres, metres, share, totalMetres, unknown: false };
}

async function computeRoute(body, fieldMask, { apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Deliberately does not include the body verbatim: an error response can
    // echo the request, and the request contains the origin coordinate.
    throw new RouteError(`routes: request failed with HTTP ${response.status}`);
  }
  const data = await response.json();
  const route = data?.routes?.[0];
  if (!route) {
    throw new RouteError('routes: response contained no route');
  }
  return route;
}

export const driveRequest = (from, to) => ({
  origin: waypoint(from),
  destination: waypoint(to),
  travelMode: 'DRIVE',
  routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
  extraComputations: ['TRAFFIC_ON_POLYLINE'],
  polylineQuality: 'HIGH_QUALITY',
});

// The transit leg is Metrorail from the lot, so the planner is told to use
// rail only: left to itself it may splice in a bus the driver would never
// take from a station car park (CMB-29).
export const TRANSIT_MODES = Object.freeze(['RAIL', 'SUBWAY']);

/**
 * The transit request. `departureTime` is when the driver stands on the
 * platform, as an ISO string; without it the planner assumes a train leaving
 * now, which is the wrong train by the length of the drive to the lot.
 */
export const transitRequest = (from, to, { departureTime = null } = {}) => ({
  origin: waypoint(from),
  destination: waypoint(to),
  travelMode: 'TRANSIT',
  transitPreferences: { allowedTravelModes: [...TRANSIT_MODES] },
  ...(departureTime ? { departureTime } : {}),
});

/** Where to start measuring: the fork for the verdict, the origin for a whole-trip estimate. */
export const START_POINTS = Object.freeze(['fork', 'origin']);

/**
 * Turn raw API routes into the two comparable options.
 *
 * @param walkMinutes  minutes from the parking spot to the destination door
 *                     (CMB-31). Folded into the drive-through total so both
 *                     options end at the same place; kept separately so the
 *                     log can tell drive from walk.
 */
export function buildOptions(
  { driveThrough, driveToParkAndRide, transit },
  parkToPlatformMinutes,
  { walkMinutes = 0 } = {},
) {
  const bufferSeconds = parkToPlatformMinutes * 60;
  const driveSeconds = parseDuration(driveToParkAndRide.duration);
  const transitSeconds = parseDuration(transit.duration);
  const throughDriveSeconds = parseDuration(driveThrough.duration);
  const walkSeconds = Math.round(walkMinutes * 60);
  return {
    driveThrough: {
      totalSeconds: throughDriveSeconds + walkSeconds,
      driveSeconds: throughDriveSeconds,
      walkSeconds,
      distanceMeters: driveThrough.distanceMeters ?? null,
      congestion: summariseCongestion(driveThrough),
      // Decoded geometry of the onward drive, for feeds that match incidents
      // to the route spatially (CMB-16). Null when the API sent no polyline.
      points: driveThrough.polyline?.encodedPolyline
        ? decodePolyline(driveThrough.polyline.encodedPolyline)
        : null,
    },
    parkAndRide: {
      totalSeconds: driveSeconds + bufferSeconds + transitSeconds,
      driveSeconds,
      bufferSeconds,
      transitSeconds,
      // The drive leg to the park-and-ride is short and its congestion is not
      // the deciding factor, but it is recorded so a jam on the way to the
      // garage is visible rather than silently folded into a total.
      congestion: summariseCongestion(driveToParkAndRide),
    },
  };
}

/**
 * Fetch both options. Requires network.
 *
 * @param options.from  'fork' (default) measures the onward legs for the
 *                      verdict; 'origin' measures the whole trip (CMB-30).
 * @param options.now   Date the driver sets off; the transit leg departs
 *                      this plus the drive to the lot plus the buffer.
 */
export async function computeOptions(
  config,
  apiKey,
  fetchImpl = fetch,
  { from = 'fork', now = new Date() } = {},
) {
  if (!START_POINTS.includes(from)) {
    throw new RouteError(`routes: unknown start point ${JSON.stringify(from)}`);
  }
  const { origin, decision_point: fork, destination, park_and_ride: pnr, parking } = config.route;
  const start = from === 'origin' ? origin : fork;
  // With a separate parking spot the car stops there, not at the door.
  const driveTarget = parking ?? destination;
  const walkMinutes = parking?.walk_to_destination_minutes ?? 0;

  const [driveThrough, driveToParkAndRide] = await Promise.all([
    computeRoute(driveRequest(start, driveTarget), DRIVE_FIELDS, { apiKey, fetchImpl }),
    computeRoute(driveRequest(start, pnr), DRIVE_FIELDS, { apiKey, fetchImpl }),
  ]);
  const platformAt = new Date(
    now.getTime() +
      (parseDuration(driveToParkAndRide.duration) + pnr.park_to_platform_minutes * 60) * 1000,
  );
  const transit = await computeRoute(
    transitRequest(pnr, destination, { departureTime: platformAt.toISOString() }),
    TRANSIT_FIELDS,
    { apiKey, fetchImpl },
  );

  const options = buildOptions(
    { driveThrough, driveToParkAndRide, transit },
    pnr.park_to_platform_minutes,
    { walkMinutes },
  );
  options.measuredFrom = from;
  options.startLabel = start.label ?? null;
  options.parkingLabel = parking?.label ?? null;
  return options;
}

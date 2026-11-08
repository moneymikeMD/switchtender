// Fork finding and approach-point geometry for onboarding: where the drive to work and the drive to
// the park-and-ride lot part ways, and where the app should wake up before that point.

import { distanceToPolylineMetres, cumulativeDistances } from './polyline.js';

export const FORK_TOLERANCE_METRES = 30;

export const METRES_PER_MILE = 1609.344;
export const LEAD_MIN_MILES = 0.5;
export const LEAD_MAX_MILES = 4;
export const LEAD_DEFAULT_MILES = 1.5;

const EARTH_RADIUS_M = 6371008.8;

/**
 * Convert a lead distance in miles to metres, defaulting to 1.5 miles; throws RangeError outside 0.5 to 4 miles.
 * The caller passes the result to approachPoint.
 */
export function leadMetres(miles = LEAD_DEFAULT_MILES) {
  if (!Number.isFinite(miles) || miles < LEAD_MIN_MILES || miles > LEAD_MAX_MILES) {
    throw new RangeError(`lead must be between ${LEAD_MIN_MILES} and ${LEAD_MAX_MILES} miles`);
  }
  return miles * METRES_PER_MILE;
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Last point of driveToWork's leading run that stays within FORK_TOLERANCE_METRES of driveToLot, as
 * { status, point, index } where index is the driveToWork segment holding the point. Status is "identical" when the whole
 * route is shared (point is its end) and "disjoint" when even the first vertex is off driveToLot (point is null).
 */
export function findFork(driveToWork, driveToLot, toleranceMetres = FORK_TOLERANCE_METRES) {
  if (!Array.isArray(driveToWork) || driveToWork.length === 0 || !Array.isArray(driveToLot) || driveToLot.length === 0) {
    return { status: 'disjoint', point: null, index: null };
  }
  const shared = (p) => distanceToPolylineMetres(driveToLot, p) <= toleranceMetres;
  if (!shared(driveToWork[0])) return { status: 'disjoint', point: null, index: null };

  let last = 0;
  while (last + 1 < driveToWork.length && shared(driveToWork[last + 1])) last++;
  if (last === driveToWork.length - 1) {
    return { status: 'identical', point: driveToWork[last], index: Math.max(0, last - 1) };
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (shared(lerp(driveToWork[last], driveToWork[last + 1], mid))) lo = mid;
    else hi = mid;
  }
  return { status: 'diverges', point: lerp(driveToWork[last], driveToWork[last + 1], lo), index: last };
}

function alongMetres(polyline, cumulative, here) {
  const [lat0, lon0] = here;
  const kLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const kLon = kLat * Math.cos((lat0 * Math.PI) / 180);
  const project = ([lat, lon]) => [(lon - lon0) * kLon, (lat - lat0) * kLat];
  let best = Infinity;
  let along = 0;
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = project(polyline[i - 1]);
    const [bx, by] = project(polyline[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      along = cumulative[i - 1] + t * (cumulative[i] - cumulative[i - 1]);
    }
  }
  return along;
}

/**
 * Walk back along the polyline from `fork` ([lat, lon], snapped to the nearest point on the route) by `metres`
 * and return { point, truncated }. When the route before the fork is shorter than `metres` the start is returned
 * with truncated true; throws on an empty polyline, a missing fork or a negative or non-finite distance.
 */
export function approachPoint(polyline, fork, metres) {
  if (!Array.isArray(polyline) || polyline.length === 0) throw new TypeError('polyline must be a non-empty array');
  if (!Array.isArray(fork) || fork.length < 2) throw new TypeError('fork must be a [lat, lon] point');
  if (!Number.isFinite(metres) || metres < 0) throw new RangeError('metres must be a non-negative number');

  const cumulative = cumulativeDistances(polyline);
  const target = polyline.length === 1 ? 0 - metres : alongMetres(polyline, cumulative, fork) - metres;
  if (target <= 0) return { point: polyline[0], truncated: target < 0 };

  let i = 1;
  while (i < polyline.length - 1 && cumulative[i] < target) i++;
  const seg = cumulative[i] - cumulative[i - 1];
  const t = seg === 0 ? 0 : (target - cumulative[i - 1]) / seg;
  return { point: lerp(polyline[i - 1], polyline[i], t), truncated: false };
}

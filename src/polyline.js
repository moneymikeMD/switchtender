// Encoded polyline decoding, distance along a route, and distance to a route.
//
// This exists so congestion can be weighted by distance rather than by point
// index. The speed intervals the routing API returns are indexed by polyline
// point, and polyline points are not evenly spaced: an encoder emits many
// points through curves and few along a straight. Weighting by index therefore
// over-counts twisty urban blocks and under-counts the highway miles where a
// jam actually costs time, which is backwards for this use.
//
// The route-matching feeds (incidents, closures, CHART) all ask the same
// question of the drive geometry: is this place within so many metres of the
// road? nearPolyline answers it once, against segments rather than vertices,
// so a point midway along a straight highway stretch between two sparse
// vertices is still on the route.

const EARTH_RADIUS_M = 6371008.8;

/** Decode a Google-encoded polyline into [lat, lon] pairs. */
export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    for (const axis of ['lat', 'lon']) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      // Low bit set means the value was negative before the zigzag encoding.
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/** Great-circle distance in metres between two [lat, lon] points. */
export function haversineMetres([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Cumulative distance in metres at each point index.
 * Index 0 is always 0; the last entry is the route length.
 */
export function cumulativeDistances(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMetres(points[i - 1], points[i]));
  }
  return cumulative;
}

/**
 * Metres from `here` ([lat, lon]) to the nearest point on the polyline,
 * segments included. Uses a local equirectangular projection around `here`,
 * which is accurate to well under a metre at the distances this is used for
 * (hundreds of metres) and needs no trigonometry per segment. A single-vertex
 * polyline is a point; an empty one is infinitely far.
 */
export function distanceToPolylineMetres(points, here) {
  if (!Array.isArray(points) || points.length === 0) return Infinity;
  const [lat0, lon0] = here;
  const kLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const kLon = kLat * Math.cos((lat0 * Math.PI) / 180);
  const project = ([lat, lon]) => [(lon - lon0) * kLon, (lat - lat0) * kLat];
  let best = Infinity;
  let [ax, ay] = project(points[0]);
  best = Math.hypot(ax, ay);
  for (let i = 1; i < points.length; i++) {
    const [bx, by] = project(points[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Parameter of the foot of the perpendicular from the origin (here) onto
    // the segment, clamped to the segment.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/**
 * True when `here` ([lat, lon]) lies within radiusMetres of the polyline.
 * A place with no coordinates is never on the route: unplaceable is not near.
 */
export function nearPolyline(points, here, radiusMetres) {
  if (!Array.isArray(points) || points.length === 0) return false;
  if (!Array.isArray(here) || !Number.isFinite(here[0]) || !Number.isFinite(here[1])) return false;
  return distanceToPolylineMetres(points, here) <= radiusMetres;
}

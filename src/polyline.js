// Encoded polyline decoding, and cumulative distance along a route.
//
// This exists so congestion can be weighted by distance rather than by point
// index. The speed intervals the routing API returns are indexed by polyline
// point, and polyline points are not evenly spaced: an encoder emits many
// points through curves and few along a straight. Weighting by index therefore
// over-counts twisty urban blocks and under-counts the highway miles where a
// jam actually costs time, which is backwards for this use.

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

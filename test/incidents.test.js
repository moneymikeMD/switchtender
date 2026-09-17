// Tests for the live-incident trajectory signal. No network: every case runs
// against a recorded TomTom response, a hand-built one, or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  incidentsRequest,
  normaliseIncidents,
  assessTrajectory,
  loadIncidents,
  fetchIncidents,
  nearRoute,
  ICON_CATEGORY,
  CATEGORIES,
  FRESH_CLOSURE_MS,
  DEFAULT_RADIUS_METRES,
  IncidentError,
} from '../src/incidents.js';
import { decodePolyline } from '../src/polyline.js';

// Recorded live 2026-09-16 against the District box, key stripped.
const live = JSON.parse(readFileSync('test/fixtures/tomtom-incidents-dc.json', 'utf8'));
// Hand-built: one major accident, one roadworks. The live box had no accident.
const synthetic = JSON.parse(readFileSync('test/fixtures/tomtom-incidents-synthetic.json', 'utf8'));

// Not a real place. Any box works; the point is that it flows through.
const bbox = { min_lon: -71.2, min_lat: 42.3, max_lon: -71.0, max_lat: 42.5 };
const config = { incidents: bbox };

// The synthetic Boston-area drive from the routes fixture (due north along
// one meridian); never a real commute.
const route = decodePolyline(
  JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8')).driveThrough.polyline.encodedPolyline,
);

// A GeoJSON LineString (lon, lat order) `metresEast` of the route's vertices 2..4.
function lineEastOf(metresEast) {
  const coords = route.slice(2, 5).map(([lat, lon]) => [lon + metresEast / (111_320 * Math.cos((lat * Math.PI) / 180)), lat]);
  return { type: 'LineString', coordinates: coords };
}
const accidentAt = (geometry) => ({ type: 'Feature', geometry, properties: { iconCategory: 1, magnitudeOfDelay: 3, from: 'A St', to: 'B St' } });

test('the request takes its bounding box from config, lon,lat order, min then max', () => {
  const { url, params } = incidentsRequest(bbox);
  assert.match(url, /^https:\/\/api\.tomtom\.com\/traffic\/services\/5\/incidentDetails$/);
  assert.equal(params.bbox, '-71.2,42.3,-71,42.5');
  assert.equal(params.timeValidityFilter, 'present');
  assert.match(params.fields, /iconCategory/);
  assert.match(params.fields, /magnitudeOfDelay/);
  assert.match(params.fields, /delay/);
  assert.match(params.fields, /roadNumbers/);
  assert.match(params.fields, /geometry/);
  // The key is never part of the request object.
  assert.equal(JSON.stringify({ url, params }).includes('key'), false);
});

test('a bounding box with a missing side is an error, not a request for the whole world', () => {
  assert.throws(() => incidentsRequest({ min_lon: 1, min_lat: 2, max_lon: 3 }), IncidentError);
  assert.throws(() => incidentsRequest(undefined), IncidentError);
});

test('every mapped iconCategory lands in a known category', () => {
  for (const category of Object.values(ICON_CATEGORY)) {
    assert.ok(CATEGORIES.includes(category), category);
  }
  assert.equal(ICON_CATEGORY[1], 'accident');
  assert.equal(ICON_CATEGORY[6], 'jam');
  assert.equal(ICON_CATEGORY[8], 'closure');
  assert.equal(ICON_CATEGORY[9], 'roadworks');
});

test('the live fixture normalises to the recorded category mix', () => {
  const incidents = normaliseIncidents(live);
  assert.equal(incidents.length, 75);
  const count = (c) => incidents.filter((i) => i.category === c).length;
  // 44 jams (6), 1 lane closed (7) + 19 road closed (8), 11 roadworks (9).
  assert.equal(count('jam'), 44);
  assert.equal(count('closure'), 20);
  assert.equal(count('roadworks'), 11);
  assert.equal(count('accident'), 0);
  for (const i of incidents) {
    assert.ok(CATEGORIES.includes(i.category));
    assert.ok(Number.isInteger(i.severity) && i.severity >= 0 && i.severity <= 4);
    assert.ok(i.delaySeconds === null || Number.isInteger(i.delaySeconds));
    assert.equal(typeof i.description, 'string');
    assert.ok(i.road === null || typeof i.road === 'string');
  }
});

test('a missing delay is null, never zero', () => {
  const incidents = normaliseIncidents(live);
  const closed = incidents.find((i) => i.category === 'closure' && i.description === 'Closed');
  assert.ok(closed, 'fixture should contain a plain closure');
  assert.equal(closed.delaySeconds, null);
  const jam = incidents.find((i) => i.category === 'jam' && i.delaySeconds !== null);
  assert.ok(jam.delaySeconds > 0);
});

test('an unrecognised response normalises to null, not to an empty list', () => {
  assert.equal(normaliseIncidents(null), null);
  assert.equal(normaliseIncidents({}), null);
  assert.equal(normaliseIncidents({ incidents: 'nope' }), null);
  assert.deepEqual(normaliseIncidents({ incidents: [] }), []);
});

test('an unknown iconCategory becomes other rather than throwing', () => {
  const [i] = normaliseIncidents({ incidents: [{ properties: { iconCategory: 99, magnitudeOfDelay: 7 } }] });
  assert.equal(i.category, 'other');
  assert.equal(i.severity, 4, 'severity is clamped to the documented range');
  assert.equal(i.description, 'incident');
});

test('an empty box is a real clear: score 0, not null', () => {
  const result = assessTrajectory([]);
  assert.equal(result.score, 0);
  assert.equal(result.unstable, false);
  assert.equal(result.count, 0);
  assert.deepEqual(result.reasons, []);
});

test('no data is unknown: score null, not 0', () => {
  for (const input of [null, undefined, 'x']) {
    const result = assessTrajectory(input);
    assert.equal(result.score, null);
    assert.equal(result.count, null);
    assert.equal(result.unstable, null, 'unknown is not steady');
    assert.equal(result.routeMatched, false);
    assert.match(result.reasons[0], /^live incidents unavailable/);
  }
});

test('geometry is kept as [lat, lon] points: LineString, Point, or null', () => {
  const [line] = normaliseIncidents({ incidents: [accidentAt(lineEastOf(0))] });
  assert.equal(line.points.length, 3);
  assert.deepEqual(line.points[0], route[2]);
  const [point] = normaliseIncidents({ incidents: [accidentAt({ type: 'Point', coordinates: [route[2][1], route[2][0]] })] });
  assert.deepEqual(point.points, [route[2]]);
  const [none] = normaliseIncidents({ incidents: [{ properties: { iconCategory: 1 } }] });
  assert.equal(none.points, null);
  for (const i of normaliseIncidents(live)) assert.ok(Array.isArray(i.points) && i.points.length > 0, 'every live record carries geometry');
});

test('with route geometry only an incident on the route triggers; the box still counts', () => {
  const on = accidentAt(lineEastOf(30));
  const off = accidentAt(lineEastOf(DEFAULT_RADIUS_METRES + 200));
  const incidents = normaliseIncidents({ incidents: [on, off] });
  assert.equal(nearRoute(route, incidents[0]), true);
  assert.equal(nearRoute(route, incidents[1]), false);
  assert.equal(nearRoute(route, incidents[1], 1000), true, 'the radius is a parameter');
  assert.equal(nearRoute(route, { points: null }), false);

  const matched = assessTrajectory(incidents, { points: route });
  assert.equal(matched.unstable, true);
  assert.equal(matched.count, 2);
  assert.equal(matched.onRoute, 1);
  assert.equal(matched.routeMatched, true);
  assert.equal(matched.reasons.length, 1);

  const boxWide = assessTrajectory(incidents);
  assert.equal(boxWide.onRoute, 2, 'without geometry the whole box counts, as before');
  assert.equal(boxWide.routeMatched, false);

  const onlyOff = assessTrajectory([incidents[1]], { points: route });
  assert.equal(onlyOff.unstable, false);
  assert.equal(onlyOff.score, 0);
  assert.equal(onlyOff.count, 1);
});

test('the live box, with its old closures and rush jams, is stable', () => {
  // 44 jams and 19 closures, but no accident and every closure weeks old.
  // A permanently lowered confidence would make the signal useless.
  const now = Date.parse('2026-09-16T23:45:00Z');
  const result = assessTrajectory(normaliseIncidents(live), { now });
  assert.equal(result.unstable, false);
  assert.equal(result.score, 0);
  assert.equal(result.count, 75);
  assert.equal(result.byCategory.jam, 44);
  assert.equal(result.byCategory.closure, 20);
});

test('a major accident makes the estimate unstable and is spoken as the reason', () => {
  const now = Date.parse('2026-09-16T23:45:00Z');
  const result = assessTrajectory(normaliseIncidents(synthetic), { now });
  assert.equal(result.unstable, true);
  assert.ok(result.score > 0 && result.score <= 1, `score ${result.score}`);
  assert.equal(result.count, 2);
  assert.equal(result.byCategory.accident, 1);
  assert.equal(result.byCategory.roadworks, 1);
  assert.equal(result.reasons.length, 1, 'roadworks do not trigger');
  assert.match(result.reasons[0], /accident on Example Pkwy to Sample St, 9 minutes of delay/);
});

test('an accident with unknown magnitude still triggers; a minor one does not', () => {
  const at = (magnitudeOfDelay) =>
    assessTrajectory(normaliseIncidents({ incidents: [{ properties: { iconCategory: 1, magnitudeOfDelay } }] }));
  assert.equal(at(0).unstable, true, 'unknown is not minor');
  assert.equal(at(1).unstable, false);
  assert.equal(at(2).unstable, true);
  assert.equal(at(3).unstable, true);
});

test('a closure triggers only while fresh', () => {
  const now = Date.parse('2026-09-16T23:45:00Z');
  const closure = (startTime) => ({
    incidents: [{ properties: { iconCategory: 8, magnitudeOfDelay: 4, startTime, from: 'A St', to: 'B St' } }],
  });
  const fresh = new Date(now - FRESH_CLOSURE_MS / 2).toISOString();
  const stale = new Date(now - FRESH_CLOSURE_MS * 2).toISOString();
  assert.equal(assessTrajectory(normaliseIncidents(closure(fresh)), { now }).unstable, true);
  assert.equal(assessTrajectory(normaliseIncidents(closure(stale)), { now }).unstable, false);
  assert.equal(assessTrajectory(normaliseIncidents(closure(undefined)), { now }).unstable, false);
});

test('the score saturates at one however many incidents pile up', () => {
  const many = { incidents: Array.from({ length: 10 }, () => ({ properties: { iconCategory: 1, magnitudeOfDelay: 3 } })) };
  assert.equal(assessTrajectory(normaliseIncidents(many)).score, 1);
});

test('fetchIncidents adds the key at call time and sends the configured box', async () => {
  let seen;
  const stub = async (url) => {
    seen = new URL(url);
    return { ok: true, status: 200, json: async () => synthetic };
  };
  const result = await fetchIncidents(config, 'test-key', stub);
  assert.equal(seen.searchParams.get('key'), 'test-key');
  assert.equal(seen.searchParams.get('bbox'), '-71.2,42.3,-71,42.5');
  assert.equal(result.unstable, true);
  assert.equal(result.count, 2);
});

test('loadIncidents fetches without assessing, so the route can be matched afterwards; the deadline rides along', async () => {
  const inits = [];
  const signal = AbortSignal.timeout(10_000);
  const stub = async (_url, init) => {
    inits.push(init);
    return { ok: true, status: 200, json: async () => ({ incidents: [accidentAt(lineEastOf(30))] }) };
  };
  const loaded = await loadIncidents(config, 'k', stub, { signal });
  assert.equal(loaded.failure, undefined);
  assert.equal(loaded.incidents.length, 1);
  assert.equal(inits[0].signal, signal);
  assert.deepEqual(assessTrajectory(loaded.incidents, { points: route }), await fetchIncidents(config, 'k', stub, { points: route }));
  const noKey = await loadIncidents(config, null, stub);
  assert.match(noKey.failure.reasons[0], /no TRAFFIC_API_KEY/);
});

test('an HTTP failure is unknown with a reason, and the key is not in it', async () => {
  const stub = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const result = await fetchIncidents(config, 'sekrit', stub);
  assert.equal(result.score, null);
  assert.equal(result.count, null);
  assert.equal(result.unstable, null);
  assert.match(result.reasons[0], /live incidents unavailable: HTTP 500/);
  assert.equal(JSON.stringify(result).includes('sekrit'), false);
});

test('a network error, bad JSON, or a missing key never throws and never leaks', async () => {
  const boom = async () => {
    throw new TypeError('fetch failed: https://api.tomtom.com/?key=sekrit');
  };
  const network = await fetchIncidents(config, 'sekrit', boom);
  assert.equal(network.score, null);
  assert.match(network.reasons[0], /network error/);
  assert.equal(JSON.stringify(network).includes('sekrit'), false);

  const garbage = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  assert.equal((await fetchIncidents(config, 'k', garbage)).score, null);

  const noList = async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) });
  assert.equal((await fetchIncidents(config, 'k', noList)).score, null);

  const neverCalled = async () => assert.fail('no request without a key');
  const noKey = await fetchIncidents(config, undefined, neverCalled);
  assert.equal(noKey.score, null);
  assert.match(noKey.reasons[0], /TRAFFIC_API_KEY/);

  const noBox = await fetchIncidents({}, 'k', neverCalled);
  assert.equal(noBox.score, null);

  const broken = await fetchIncidents(config, 'k', () => { throw new RangeError('no'); });
  assert.equal(broken.score, null);
  assert.match(broken.reasons[0], /\(RangeError\)/);
});

test('an empty live response is a real clear through the full path', async () => {
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ incidents: [] }) });
  const result = await fetchIncidents(config, 'k', stub);
  assert.equal(result.score, 0);
  assert.equal(result.unstable, false);
  assert.equal(result.count, 0);
});

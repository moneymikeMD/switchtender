// Tests for the DDOT planned-closure signal. No network: every case runs
// against a recorded TOPS response, a hand-built record, or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  closuresRequest,
  livenessRequest,
  normaliseClosures,
  newestEffective,
  sourceIsLive,
  relevant,
  spokenAddress,
  nearRoute,
  assessClosures,
  fetchClosures,
  CLOSURE_LAYERS,
  LIVENESS_LAYER,
  DEFAULT_RADIUS_METRES,
  STALE_REASON,
  NO_ROUTE_REASON,
  ClosureError,
} from '../src/closures.js';
import { decodePolyline, haversineMetres } from '../src/polyline.js';

// Recorded live 2026-09-16 against the District box with outSR=4326, trimmed
// to 20 features. Maine Avenue (the approach-road staging area from CMB-28)
// is first, the off-route Perry Place NE permit second.
const l11 = JSON.parse(readFileSync('test/fixtures/ddot-closures-l11.json', 'utf8'));
const l10 = JSON.parse(readFileSync('test/fixtures/ddot-closures-l10.json', 'utf8'));
const liveness = JSON.parse(readFileSync('test/fixtures/ddot-liveness.json', 'utf8'));
const routes = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));

// The morning the fixtures were recorded.
const NOW = Date.parse('2026-09-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Not a real place. Any box works; the point is that it flows through.
const bbox = { min_lon: -71.2, min_lat: 42.3, max_lon: -71.0, max_lat: 42.5 };
const config = { incidents: bbox };

// The synthetic Boston-area drive from the routes fixture: 15 vertices due
// north along one meridian, 50 m apart for the first ten and about 2 km apart
// after that. Real DC route geometry never appears in this repo.
const route = decodePolyline(routes.driveThrough.polyline.encodedPolyline);

// Move a [lat, lon] point by metres east (a small-angle offset, exact enough
// for tests that check against a 300 m radius).
function eastOf([lat, lon], metres) {
  const metresPerDegreeLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return [lat, lon + metres / metresPerDegreeLon];
}

// A hand-built relevant closure record at a point.
function permitAt([lat, lon], address) {
  return {
    address, status: 'Issued', roadClosed: true, layer: 11, lat, lon,
    effectiveAt: NOW - DAY, expiresAt: NOW + DAY,
  };
}

test('the closure request takes its envelope from the argument, WGS84, layer 11 flags closures', () => {
  const { url, params } = closuresRequest(bbox, 11);
  assert.equal(url, 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DDOT/TOPS/FeatureServer/11/query');
  const geometry = JSON.parse(params.geometry);
  assert.deepEqual(geometry, {
    xmin: -71.2, ymin: 42.3, xmax: -71.0, ymax: 42.5, spatialReference: { wkid: 4326 },
  });
  assert.equal(params.geometryType, 'esriGeometryEnvelope');
  assert.equal(params.inSR, '4326');
  assert.equal(params.f, 'json');
  assert.match(params.where, /IsRoadClosed = 'Y'/);
  assert.match(params.where, /StatusDescription = 'Issued'/);
  for (const field of ['IsRoadClosed', 'EffectiveDate', 'ExpirationDate', 'WorkLocationFullAddress', 'StatusDescription']) {
    assert.ok(params.outFields.split(',').includes(field), `outFields has ${field}`);
  }
  // The layer answers in Web Mercator by default; route matching needs WGS84.
  assert.equal(params.returnGeometry, 'true');
  assert.equal(params.outSR, '4326');
});

test('layer 10 has no closure flag, so its request filters on issued status only', () => {
  const { url, params } = closuresRequest(bbox, 10);
  assert.match(url, /\/10\/query$/);
  assert.equal(params.where, "StatusDescription = 'Issued'");
  assert.equal(params.outFields.includes('IsRoadClosed'), false);
});

test('a missing box key or a history layer is a ClosureError, not a silent District-wide query', () => {
  assert.throws(() => closuresRequest({ min_lon: -71.2, min_lat: 42.3, max_lon: -71.0 }, 11), ClosureError);
  assert.throws(() => closuresRequest(undefined, 11), ClosureError);
  assert.throws(() => closuresRequest(bbox, 0), ClosureError);
  assert.throws(() => closuresRequest(bbox, 1), ClosureError);
});

test('the liveness request is a max over EffectiveDate across the whole layer', () => {
  const { url, params } = livenessRequest(11);
  assert.match(url, /\/11\/query$/);
  assert.equal(params.where, '1=1');
  assert.equal(params.geometry, undefined);
  const stats = JSON.parse(params.outStatistics);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].statisticType, 'max');
  assert.equal(stats[0].onStatisticField, 'EffectiveDate');
  assert.equal(stats[0].outStatisticFieldName, 'newest');
});

test('normalise turns the recorded layer 11 response into typed records', () => {
  const records = normaliseClosures(l11, 11);
  assert.equal(records.length, 20);
  for (const r of records) {
    assert.equal(r.layer, 11);
    assert.equal(r.status, 'Issued');
    assert.equal(r.roadClosed, true);
    assert.equal(typeof r.effectiveAt, 'number');
    assert.ok(r.expiresAt === null || typeof r.expiresAt === 'number');
    assert.equal(typeof r.address, 'string');
    assert.equal(typeof r.lat, 'number', 'every recorded permit carries a latitude');
    assert.equal(typeof r.lon, 'number', 'every recorded permit carries a longitude');
  }
  const maine = records.find((r) => r.address === '1300 MAINE AVENUE SW');
  assert.ok(maine, 'the approach-road closure from the ticket is in the fixture');
  assert.equal(new Date(maine.effectiveAt).toISOString().slice(0, 10), '2026-08-13');
  assert.equal(new Date(maine.expiresAt).toISOString().slice(0, 10), '2027-01-25');
});

test('normalise reads WGS84 point geometry as lat from y and lon from x', () => {
  assert.equal(l11.spatialReference.wkid, 4326, 'the fixture was recorded with outSR=4326');
  const [maine] = normaliseClosures(l11, 11);
  assert.equal(maine.address, '1300 MAINE AVENUE SW');
  assert.equal(maine.lat, l11.features[0].geometry.y);
  assert.equal(maine.lon, l11.features[0].geometry.x);
  // Sanity: the point is in the District, which is south of the Boston box.
  assert.ok(maine.lat > 38.8 && maine.lat < 39.0);
  assert.ok(maine.lon > -77.1 && maine.lon < -76.9);
});

test('a feature with no geometry, or non-numeric geometry, normalises to lat and lon null', () => {
  const [none] = normaliseClosures({ features: [{ attributes: { IsRoadClosed: 'Y' } }] }, 11);
  assert.equal(none.lat, null);
  assert.equal(none.lon, null);
  const [bad] = normaliseClosures({ features: [{ attributes: {}, geometry: { x: 'nope', y: NaN } }] }, 11);
  assert.equal(bad.lat, null);
  assert.equal(bad.lon, null);
});

test('Maine Avenue acceptance: the normalised record is placeable and a route vertex 50 m away counts it', () => {
  const [maine] = normaliseClosures(l11, 11);
  // A synthetic single-vertex "route" 50 m east of the permit point. No real
  // DC route geometry: just the permit's own public location, nudged.
  const vertex = eastOf([maine.lat, maine.lon], 50);
  assert.ok(Math.abs(haversineMetres(vertex, [maine.lat, maine.lon]) - 50) < 1);
  assert.equal(nearRoute([vertex], maine), true);
  const result = assessClosures([maine], { now: NOW, points: [vertex], sourceLive: true });
  assert.equal(result.active, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.reasons, ['planned road closure at 1300 Maine Avenue SW']);
});

test('nearRoute: inside the radius is true, outside is false, boundary inclusive, unplaceable never', () => {
  const on = permitAt(eastOf(route[5], 100), 'ON ST');
  const edge = permitAt(eastOf(route[5], DEFAULT_RADIUS_METRES - 0.5), 'EDGE ST');
  const off = permitAt(eastOf(route[5], DEFAULT_RADIUS_METRES + 50), 'OFF ST');
  assert.equal(nearRoute(route, on), true);
  assert.equal(nearRoute(route, edge), true);
  assert.equal(nearRoute(route, off), false);
  assert.equal(nearRoute(route, off, 1000), true, 'the radius is a parameter');
  assert.equal(nearRoute(route, { ...on, lat: null }), false);
  assert.equal(nearRoute(route, { ...on, lon: null }), false);
  assert.equal(nearRoute(null, on), false);
  assert.equal(nearRoute([], on), false);
  assert.equal(DEFAULT_RADIUS_METRES, 300);
});

test('layer 10 records carry roadClosed null: the layer cannot say, and unknown is not false', () => {
  const records = normaliseClosures(l10, 10);
  assert.equal(records.length, 20);
  for (const r of records) {
    assert.equal(r.layer, 10);
    assert.equal(r.roadClosed, null);
  }
});

test('normalise returns null for an unrecognised shape or an ArcGIS error envelope', () => {
  assert.equal(normaliseClosures(null), null);
  assert.equal(normaliseClosures({}), null);
  assert.equal(normaliseClosures({ features: 'nope' }), null);
  assert.equal(normaliseClosures({ error: { code: 400, message: 'Invalid field' } }), null);
  assert.deepEqual(normaliseClosures({ features: [] }), []);
});

test('missing attributes become null, and an N flag is false', () => {
  const [r] = normaliseClosures({ features: [{ attributes: { IsRoadClosed: 'N' } }] }, 11);
  assert.equal(r.address, null);
  assert.equal(r.status, null);
  assert.equal(r.effectiveAt, null);
  assert.equal(r.expiresAt, null);
  assert.equal(r.roadClosed, false);
  const [none] = normaliseClosures({ features: [{ attributes: { IsRoadClosed: null } }] }, 11);
  assert.equal(none.roadClosed, null);
});

test('the recorded liveness response yields a date in the recorded month', () => {
  const newest = newestEffective(liveness);
  assert.equal(typeof newest, 'number');
  assert.equal(new Date(newest).toISOString().slice(0, 7), '2026-09');
  assert.equal(sourceIsLive(newest, NOW), true);
  assert.equal(sourceIsLive(newest, Date.parse('2026-11-01T12:00:00Z')), false);
  assert.equal(sourceIsLive(null, NOW), null);
  assert.equal(newestEffective({ features: [] }), null);
  assert.equal(newestEffective({ error: {} }), null);
});

test('relevant() is the window test: start <= now <= end, boundaries inclusive', () => {
  const window = { effectiveAt: NOW - 10 * DAY, expiresAt: NOW + 10 * DAY };
  assert.equal(relevant(window, NOW), true);
  assert.equal(relevant(window, NOW - 10 * DAY), true, 'at the start');
  assert.equal(relevant(window, NOW + 10 * DAY), true, 'at the end');
  assert.equal(relevant(window, NOW - 10 * DAY - 1), false, 'a millisecond before the start');
  assert.equal(relevant(window, NOW + 10 * DAY + 1), false, 'a millisecond after the end');
});

test('relevant(): open-ended expiry counts, a missing start does not, and issue date plays no part', () => {
  assert.equal(relevant({ effectiveAt: NOW - DAY, expiresAt: null }, NOW), true);
  assert.equal(relevant({ effectiveAt: null, expiresAt: NOW + DAY }, NOW), false);
  assert.equal(relevant(null, NOW), false);
  assert.equal(relevant({ effectiveAt: NOW + DAY, expiresAt: NOW + 30 * DAY }, NOW), false, 'not started yet');
  // Created and issued weeks ago; the window covers now. This is the record
  // rule 5 exists to protect. It MUST count.
  const oldButActive = {
    effectiveAt: Date.parse('2026-08-13T00:00:00Z'),
    expiresAt: Date.parse('2027-01-25T00:00:00Z'),
    issuedAt: Date.parse('2026-08-14T00:00:00Z'),
  };
  assert.equal(relevant(oldButActive, NOW), true);
});

test('spoken addresses are title case with the quadrant left upper', () => {
  assert.equal(spokenAddress('1300 MAINE AVENUE SW'), '1300 Maine Avenue SW');
  assert.equal(spokenAddress('1400 14TH STREET NW'), '1400 14th Street NW');
  assert.equal(spokenAddress(null), 'an unnamed location');
});

test('assess without route geometry counts the fixture closures in force District-wide, names the approach road, and says why', () => {
  const result = assessClosures(normaliseClosures(l11, 11), { now: NOW, sourceLive: true });
  assert.ok(result.active > 0);
  assert.ok(result.active <= 20);
  assert.equal(result.total, result.active, 'the fallback count is the box count');
  assert.ok(result.addresses.includes('1300 MAINE AVENUE SW'));
  assert.ok(result.addresses.length <= 5);
  assert.equal(result.reasons.length, result.addresses.length + 1);
  assert.ok(result.reasons.includes('planned road closure at 1300 Maine Avenue SW'));
  assert.equal(result.reasons.at(-1), NO_ROUTE_REASON);
  assert.match(NO_ROUTE_REASON, /route geometry unavailable/);
  assert.equal(result.score, null, 'no scored verdict input until history exists');
  assert.equal(result.sourceLive, true);
});

test('assess with a route far from every fixture permit: active 0, total still the box count, no route note', () => {
  // The Boston route is hundreds of kilometres from every District permit.
  const fallback = assessClosures(normaliseClosures(l11, 11), { now: NOW });
  const result = assessClosures(normaliseClosures(l11, 11), { now: NOW, points: route });
  assert.equal(result.active, 0);
  assert.equal(result.total, fallback.total);
  assert.ok(result.total > 0);
  assert.deepEqual(result.addresses, []);
  assert.deepEqual(result.reasons, []);
});

test('assess classifies on-route against off-route permits and keeps the box total', () => {
  const records = [
    permitAt(eastOf(route[2], 80), 'ON APPROACH ST'),
    permitAt(eastOf(route[12], 200), 'ON HIGHWAY ST'),
    permitAt(eastOf(route[2], 900), 'PARALLEL ST'),
    permitAt(eastOf(route[14], 5000), 'FAR AWAY ST'),
    // Relevant and flagged but unplaceable: in the box total, never on route.
    { ...permitAt(route[0], 'NO GEOMETRY ST'), lat: null, lon: null },
    // On the route but expired: neither count.
    { ...permitAt(route[3], 'EXPIRED ST'), effectiveAt: NOW - 30 * DAY, expiresAt: NOW - DAY },
  ];
  const result = assessClosures(records, { now: NOW, points: route, sourceLive: true });
  assert.equal(result.active, 2);
  assert.equal(result.total, 5);
  assert.deepEqual(result.addresses, ['ON APPROACH ST', 'ON HIGHWAY ST']);
  assert.deepEqual(result.reasons, [
    'planned road closure at On Approach St',
    'planned road closure at On Highway St',
  ]);
  assert.equal(result.score, null);

  const wider = assessClosures(records, { now: NOW, points: route, radiusMetres: 1000 });
  assert.equal(wider.active, 3, 'the radius is a parameter');
  assert.ok(wider.addresses.includes('PARALLEL ST'));
});

test('assess with points null or empty falls back to the box count and appends the route note after the addresses', () => {
  const records = [permitAt(eastOf(route[2], 80), 'ON ST'), permitAt(eastOf(route[2], 5000), 'OFF ST')];
  for (const points of [null, undefined, []]) {
    const result = assessClosures(records, { now: NOW, points });
    assert.equal(result.active, 2, `points ${JSON.stringify(points)}`);
    assert.equal(result.total, 2);
    assert.deepEqual(result.addresses, ['ON ST', 'OFF ST']);
    assert.deepEqual(result.reasons, [
      'planned road closure at On St',
      'planned road closure at Off St',
      NO_ROUTE_REASON,
    ]);
  }
});

test('assess: expired, future, unflagged and layer-10 records do not count; duplicates are spoken once', () => {
  const base = { status: 'Issued', roadClosed: true, layer: 11 };
  const records = [
    { ...base, address: 'A ST NW', effectiveAt: NOW - DAY, expiresAt: NOW + DAY },
    { ...base, address: 'A ST NW', effectiveAt: NOW - 2 * DAY, expiresAt: NOW + DAY },
    { ...base, address: 'B ST NW', effectiveAt: NOW - 30 * DAY, expiresAt: NOW - DAY },
    { ...base, address: 'C ST NW', effectiveAt: NOW + DAY, expiresAt: NOW + 30 * DAY },
    { ...base, address: 'D ST NW', effectiveAt: NOW - DAY, expiresAt: NOW + DAY, roadClosed: false },
    { ...base, address: 'E ST NW', effectiveAt: NOW - DAY, expiresAt: NOW + DAY, roadClosed: null, layer: 10 },
  ];
  const result = assessClosures(records, { now: NOW });
  assert.equal(result.active, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.addresses, ['A ST NW']);
  assert.deepEqual(result.reasons, ['planned road closure at A St NW', NO_ROUTE_REASON]);
});

test('assess caps the spoken list at five and leaves the count honest', () => {
  const records = Array.from({ length: 8 }, (_, i) => ({
    address: `${i} ST NW`, status: 'Issued', roadClosed: true, layer: 11,
    effectiveAt: NOW - DAY, expiresAt: NOW + DAY,
  }));
  const result = assessClosures(records, { now: NOW });
  assert.equal(result.active, 8);
  assert.equal(result.addresses.length, 5);
  assert.equal(result.reasons.length, 5 + 1, 'five addresses plus the route note');
});

test('assess of null is unknown, and an empty list is a real zero', () => {
  const unknown = assessClosures(null);
  assert.equal(unknown.active, null);
  assert.equal(unknown.total, null);
  assert.equal(unknown.score, null);
  assert.equal(unknown.sourceLive, null);
  assert.match(unknown.reasons[0], /^planned closures unavailable: /);
  const empty = assessClosures([], { now: NOW, points: route });
  assert.equal(empty.active, 0);
  assert.equal(empty.total, 0);
  assert.equal(assessClosures([], { now: NOW }).active, 0);
});

// A stub that answers the liveness query and the closure layers from fixtures.
function stubFrom({ liveness: live = liveness, layers = { 11: l11, 10: l10 } } = {}) {
  const seen = [];
  const stub = async (url) => {
    const u = new URL(url);
    seen.push(u);
    const layer = Number(u.pathname.match(/\/(\d+)\/query$/)[1]);
    const body = u.searchParams.has('outStatistics') ? live : layers[layer];
    return { ok: true, status: 200, json: async () => body };
  };
  return { stub, seen };
}

test('fetch runs liveness and the closure layers in parallel from the config box and assesses', async () => {
  const { stub, seen } = stubFrom();
  const result = await fetchClosures(config, stub, { now: NOW });
  assert.equal(seen.length, 1 + CLOSURE_LAYERS.length);
  const livenessCalls = seen.filter((u) => u.searchParams.has('outStatistics'));
  assert.equal(livenessCalls.length, 1);
  assert.match(livenessCalls[0].pathname, new RegExp(`/${LIVENESS_LAYER}/query$`));
  const closureCalls = seen.filter((u) => !u.searchParams.has('outStatistics'));
  for (const u of closureCalls) {
    assert.deepEqual(JSON.parse(u.searchParams.get('geometry')).xmin, -71.2);
  }
  assert.equal(result.sourceLive, true);
  assert.ok(result.active > 0);
  assert.equal(result.total, result.active, 'no points: the box count stands in');
  assert.ok(result.reasons.includes('planned road closure at 1300 Maine Avenue SW'));
  assert.equal(result.reasons.at(-1), NO_ROUTE_REASON);
  assert.equal(result.score, null);
});

test('fetch passes the route points through: a Boston route matches none of the District permits, the box total stays', async () => {
  const { stub } = stubFrom();
  const result = await fetchClosures(config, stub, { now: NOW, points: route });
  assert.equal(result.sourceLive, true);
  assert.equal(result.active, 0);
  assert.ok(result.total > 0);
  assert.deepEqual(result.addresses, []);
  assert.deepEqual(result.reasons, []);
});

test('fetch with points: a permit placed on the route is counted and spoken, one off it is only in the total', async () => {
  const onRoute = { attributes: {
    WorkLocationFullAddress: 'ON ROUTE ST', StatusDescription: 'Issued', IsRoadClosed: 'Y',
    EffectiveDate: NOW - DAY, ExpirationDate: NOW + DAY,
  }, geometry: (([lat, lon]) => ({ x: lon, y: lat }))(eastOf(route[4], 60)) };
  const offRoute = { attributes: {
    WorkLocationFullAddress: 'OFF ROUTE ST', StatusDescription: 'Issued', IsRoadClosed: 'Y',
    EffectiveDate: NOW - DAY, ExpirationDate: NOW + DAY,
  }, geometry: (([lat, lon]) => ({ x: lon, y: lat }))(eastOf(route[4], 2000)) };
  const layer = { ...l11, features: [offRoute, onRoute] };
  const { stub } = stubFrom({ layers: { 11: layer, 10: l10 } });
  const result = await fetchClosures(config, stub, { now: NOW, points: route });
  assert.equal(result.active, 1);
  assert.equal(result.total, 2);
  assert.deepEqual(result.addresses, ['ON ROUTE ST']);
  assert.deepEqual(result.reasons, ['planned road closure at On Route St']);
  const wider = await fetchClosures(config, stub, { now: NOW, points: route, radiusMetres: 2500 });
  assert.equal(wider.active, 2);
});

test('a source whose newest record is older than the current month is stale, however many records it has', async () => {
  const { stub } = stubFrom();
  const result = await fetchClosures(config, stub, { now: Date.parse('2026-11-16T12:00:00Z'), points: route });
  assert.equal(result.active, null);
  assert.equal(result.total, null);
  assert.deepEqual(result.addresses, []);
  assert.deepEqual(result.reasons, [STALE_REASON]);
  assert.equal(result.sourceLive, false);
  assert.equal(result.score, null);
});

test('a liveness response with no date is unknown, not live', async () => {
  const { stub } = stubFrom({ liveness: { features: [] } });
  const result = await fetchClosures(config, stub, { now: NOW });
  assert.equal(result.active, null);
  assert.equal(result.sourceLive, null);
  assert.match(result.reasons[0], /planned closures unavailable: liveness response had no date/);
});

test('an HTTP failure is unknown with a reason', async () => {
  const stub = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const result = await fetchClosures(config, stub, { now: NOW });
  assert.equal(result.active, null);
  assert.equal(result.total, null);
  assert.equal(result.score, null);
  assert.equal(result.sourceLive, null);
  assert.match(result.reasons[0], /planned closures unavailable: .*HTTP 500/);
});

test('a network error, bad JSON, an ArcGIS error envelope, or a bad config never throws', async () => {
  const boom = async () => { throw new TypeError('fetch failed'); };
  const network = await fetchClosures(config, boom, { now: NOW });
  assert.equal(network.active, null);
  assert.match(network.reasons[0], /network error/);

  const garbage = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  assert.equal((await fetchClosures(config, garbage, { now: NOW })).active, null);

  const { stub: envelope } = stubFrom({ layers: { 11: { error: { code: 400, message: 'Invalid field' } }, 10: l10 } });
  const bad = await fetchClosures(config, envelope, { now: NOW });
  assert.equal(bad.active, null);
  assert.match(bad.reasons[0], /no feature list/);

  const noBox = await fetchClosures({}, boom, { now: NOW });
  assert.equal(noBox.active, null);
  assert.match(noBox.reasons[0], /bounding box is missing/);
});

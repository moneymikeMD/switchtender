import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodePolyline } from '../src/polyline.js';
import {
  CHART_EVENTS_URL,
  CHART_CLOSURES_URL,
  STALE_REASON,
  normaliseChart,
  nearRoute,
  sourceIsLive,
  relevant,
  assessChart,
  loadChart,
  fetchChart,
} from '../src/chart.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const events = fixture('chart-events.json');
const closures = fixture('chart-closures.json');

// The morning the fixtures were recorded; the freshness test is against it.
const NOW = Date.parse('2026-09-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Boston-area synthetic route from the routes fixture; never a real commute.
const points = decodePolyline(fixture('routes-congested.json').driveThrough.polyline.encodedPolyline);

// One incident placed exactly on a polyline vertex, one roughly 55 km away.
const onRoute = { lat: points[3][0], lon: points[3][1], description: 'Action Event @ SYNTHETIC RD @ TEST ST', type: 'Other', kind: 'incident', startDateTime: NOW - DAY, lastCachedDataUpdateTime: NOW };
const farAway = { lat: points[3][0] + 0.5, lon: points[3][1], description: 'Action Event @ ELSEWHERE', type: 'Other', kind: 'incident', startDateTime: NOW - DAY, lastCachedDataUpdateTime: NOW };

test('normaliseChart maps the live events fixture to the normalised shape', () => {
  const list = normaliseChart(events);
  assert.equal(list.length, events.data.length);
  const first = list[0];
  assert.deepEqual(Object.keys(first).sort(), [
    'county', 'description', 'direction', 'endsAt', 'kind', 'lanes', 'lat', 'lon', 'startedAt', 'type', 'updatedAt',
  ]);
  assert.equal(first.updatedAt, events.data[0].lastCachedDataUpdateTime);
  assert.equal(first.endsAt, null, 'events carry no end date');
  assert.equal(first.kind, 'incident');
  assert.equal(typeof first.lat, 'number');
  assert.equal(typeof first.lon, 'number');
  assert.equal(first.county, events.data[0].county);
  assert.equal(first.type, events.data[0].incidentType);
  assert.equal(first.startedAt, events.data[0].startDateTime);
  assert.ok(Number.isInteger(first.startedAt));
});

test('normaliseChart tags closures and keeps empty strings as null', () => {
  const list = normaliseChart(closures, 'closure');
  assert.equal(list.length, closures.data.length);
  assert.ok(list.every((r) => r.kind === 'closure'));
  const blankLanes = list.find((r, i) => closures.data[i].lanesStatus === '');
  if (blankLanes) assert.equal(blankLanes.lanes, null);
  const norm = normaliseChart({ data: [{ lat: 1, lon: 2, description: 'x', startDateTime: -1, closureEndDate: -1, lanesStatus: '' }] });
  assert.equal(norm[0].startedAt, null);
  assert.equal(norm[0].endsAt, null, '-1 is unset, not 1969');
  assert.equal(norm[0].lanes, null);
});

test('rule 5, first test: the newest record must fall in the current month; an empty feed is a clear', () => {
  const records = normaliseChart(events);
  assert.equal(sourceIsLive(records, NOW), true);
  assert.equal(sourceIsLive(records, Date.parse('2026-11-01T12:00:00Z')), false);
  assert.equal(sourceIsLive([], Date.parse('2030-01-01T00:00:00Z')), true);
  assert.equal(sourceIsLive([{ lat: 1, lon: 2 }], NOW), null, 'no dates at all cannot vouch for the feed');
  assert.equal(sourceIsLive(null, NOW), null);
});

test('rule 5, second test: a record counts only while its window covers now', () => {
  assert.equal(relevant({ startedAt: NOW - DAY, endsAt: null }, NOW), true);
  assert.equal(relevant({ startedAt: NOW + DAY, endsAt: null }, NOW), false, 'not started yet');
  assert.equal(relevant({ startedAt: NOW - 10 * DAY, endsAt: NOW - DAY }, NOW), false, 'ended');
  assert.equal(relevant({ startedAt: null, endsAt: null }, NOW), true, 'undated but listed as active');
  assert.equal(relevant(null, NOW), false);
  // An ended closure on the route is not on the road this morning.
  const ended = { ...onRoute, kind: 'closure', startedAt: NOW - 10 * DAY, endsAt: NOW - DAY };
  const result = assessChart([normaliseChart({ data: [onRoute] })[0], ended], points, { now: NOW });
  assert.equal(result.onRoute, 1);
  assert.equal(result.total, 2);
});

test('normaliseChart returns null for an unrecognised shape, not an empty list', () => {
  assert.equal(normaliseChart(null), null);
  assert.equal(normaliseChart({}), null);
  assert.equal(normaliseChart({ data: 'nope' }), null);
  assert.equal(normaliseChart({ incidents: [] }), null);
  assert.deepEqual(normaliseChart({ data: [] }), []);
});

test('nearRoute is true on the polyline and false far from it', () => {
  assert.equal(nearRoute(points, onRoute), true);
  assert.equal(nearRoute(points, farAway), false);
  assert.equal(nearRoute(points, { lat: null, lon: null }), false);
  assert.equal(nearRoute([], onRoute), false);
});

test('nearRoute honours the radius', () => {
  // The synthetic polyline runs north-south, so step sideways in longitude:
  // 0.003 degrees at this latitude is roughly 250 m off the line.
  const nearby = { lat: points[3][0], lon: points[3][1] + 0.003 };
  assert.equal(nearRoute(points, nearby, 400), true);
  assert.equal(nearRoute(points, nearby, 100), false);
});

test('assessChart counts on-route against total and describes the hits', () => {
  const closure = { ...onRoute, kind: 'closure', description: 'Active Closure @ SYNTHETIC RD BETWEEN A AND B (MM 1.0-2.0)' };
  const result = assessChart([onRoute, farAway, closure], points, { now: NOW });
  assert.equal(result.onRoute, 2);
  assert.equal(result.total, 3);
  assert.equal(result.score, null);
  assert.deepEqual(result.descriptions, [
    'incident: SYNTHETIC RD @ TEST ST',
    'closure: SYNTHETIC RD BETWEEN A AND B',
  ]);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /^2 maryland records on the route: /);
});

test('assessChart with nothing on the route is a real zero, and caps descriptions at five', () => {
  const none = assessChart([farAway], points, { now: NOW });
  assert.equal(none.onRoute, 0);
  assert.equal(none.total, 1);
  assert.deepEqual(none.reasons, []);
  const many = assessChart(Array.from({ length: 7 }, () => onRoute), points, { now: NOW });
  assert.equal(many.onRoute, 7);
  assert.equal(many.descriptions.length, 5);
});

test('assessChart with null input or no polyline is unknown, not zero', () => {
  const noData = assessChart(null, points);
  assert.equal(noData.onRoute, null);
  assert.equal(noData.total, null);
  assert.match(noData.reasons[0], /^maryland incidents unavailable: /);
  const noRoute = assessChart([onRoute], []);
  assert.equal(noRoute.onRoute, null);
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('fetchChart merges both feeds and passes the events and closures URLs', async () => {
  const calls = [];
  const stub = async (url) => {
    calls.push(url);
    if (url === CHART_EVENTS_URL) return ok({ data: [{ ...onRoute }] });
    if (url === CHART_CLOSURES_URL) return ok({ data: [{ ...onRoute, description: 'Active Closure @ X' }, farAway] });
    throw new Error(`unexpected url ${url}`);
  };
  const result = await fetchChart(points, stub, { now: NOW });
  assert.deepEqual(calls.sort(), [CHART_CLOSURES_URL, CHART_EVENTS_URL].sort());
  assert.equal(result.total, 3);
  assert.equal(result.onRoute, 2);
  assert.equal(result.sourceLive, true);
  assert.ok(result.descriptions.some((d) => d.startsWith('closure: ')));
});

test('the recorded feeds are live on the day they were fetched and stale two months on', async () => {
  const stub = async (url) => ok(url === CHART_EVENTS_URL ? events : closures);
  const live = await loadChart(stub, { now: NOW });
  assert.ok(Array.isArray(live.records));
  assert.equal(live.records.length, events.data.length + closures.data.length);

  const later = await fetchChart(points, stub, { now: Date.parse('2026-11-16T12:00:00Z') });
  assert.equal(later.onRoute, null);
  assert.equal(later.sourceLive, false);
  assert.deepEqual(later.reasons, [STALE_REASON]);

  const undated = await fetchChart(points, async () => ok({ data: [{ lat: 1, lon: 2 }] }), { now: NOW });
  assert.equal(undated.onRoute, null);
  assert.match(undated.reasons[0], /no record carries a date/);
});

test('a feed that answers success:false is unknown, and the deadline rides along on the request', async () => {
  const stub = async () => ok({ success: false, error: 'maintenance', data: [] });
  assert.match((await fetchChart(points, stub, { now: NOW })).reasons[0], /reported maintenance/);
  const inits = [];
  const signal = AbortSignal.timeout(10_000);
  await fetchChart(points, async (url, init) => { inits.push(init); return ok({ data: [] }); }, { now: NOW, signal });
  assert.ok(inits.every((i) => i.signal === signal));
});

test('fetchChart with an HTTP 500 is unknown with a reason', async () => {
  const stub = async (url) => (url === CHART_EVENTS_URL ? { ok: false, status: 500 } : ok({ data: [] }));
  const result = await fetchChart(points, stub, { now: NOW });
  assert.equal(result.onRoute, null);
  assert.equal(result.total, null);
  assert.equal(result.score, null);
  assert.deepEqual(result.descriptions, []);
  assert.match(result.reasons[0], /^maryland incidents unavailable: .*HTTP 500/);
});

test('fetchChart with a throwing fetch is unknown and never throws', async () => {
  const boom = async () => {
    throw new TypeError('fetch failed');
  };
  const result = await fetchChart(points, boom, { now: NOW });
  assert.equal(result.onRoute, null);
  assert.match(result.reasons[0], /network error \(TypeError\)/);
  // A fetch that throws synchronously is a broken injection, not a crash.
  const broken = await fetchChart(points, () => { throw new RangeError('no'); }, { now: NOW });
  assert.match(broken.reasons[0], /\(RangeError\)/);
});

test('fetchChart with unparseable JSON or a changed shape is unknown', async () => {
  const bad = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  assert.match((await fetchChart(points, bad, { now: NOW })).reasons[0], /unparseable/);
  const changed = async () => ok({ features: [] });
  assert.match((await fetchChart(points, changed, { now: NOW })).reasons[0], /no data list/);
  const noRoute = await fetchChart([], ok, { now: NOW });
  assert.match(noRoute.reasons[0], /no route polyline/);
});

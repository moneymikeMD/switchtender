import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodePolyline } from '../src/polyline.js';
import {
  CHART_EVENTS_URL,
  CHART_CLOSURES_URL,
  normaliseChart,
  nearRoute,
  assessChart,
  fetchChart,
} from '../src/chart.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const events = fixture('chart-events.json');
const closures = fixture('chart-closures.json');

// Boston-area synthetic route from the routes fixture; never a real commute.
const points = decodePolyline(fixture('routes-congested.json').driveThrough.polyline.encodedPolyline);

// One incident placed exactly on a polyline vertex, one roughly 55 km away.
const onRoute = { lat: points[3][0], lon: points[3][1], description: 'Action Event @ SYNTHETIC RD @ TEST ST', type: 'Other', kind: 'incident' };
const farAway = { lat: points[3][0] + 0.5, lon: points[3][1], description: 'Action Event @ ELSEWHERE', type: 'Other', kind: 'incident' };

test('normaliseChart maps the live events fixture to the normalised shape', () => {
  const list = normaliseChart(events);
  assert.equal(list.length, events.data.length);
  const first = list[0];
  assert.deepEqual(Object.keys(first).sort(), [
    'county', 'description', 'direction', 'kind', 'lanes', 'lat', 'lon', 'startedAt', 'type',
  ]);
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
  const norm = normaliseChart({ data: [{ lat: 1, lon: 2, description: 'x', startDateTime: -1, lanesStatus: '' }] });
  assert.equal(norm[0].startedAt, null);
  assert.equal(norm[0].lanes, null);
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
  const result = assessChart([onRoute, farAway, closure], points);
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
  const none = assessChart([farAway], points);
  assert.equal(none.onRoute, 0);
  assert.equal(none.total, 1);
  assert.deepEqual(none.reasons, []);
  const many = assessChart(Array.from({ length: 7 }, () => onRoute), points);
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
  const result = await fetchChart(points, stub);
  assert.deepEqual(calls.sort(), [CHART_CLOSURES_URL, CHART_EVENTS_URL].sort());
  assert.equal(result.total, 3);
  assert.equal(result.onRoute, 2);
  assert.ok(result.descriptions.some((d) => d.startsWith('closure: ')));
});

test('fetchChart with an HTTP 500 is unknown with a reason', async () => {
  const stub = async (url) => (url === CHART_EVENTS_URL ? { ok: false, status: 500 } : ok({ data: [] }));
  const result = await fetchChart(points, stub);
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
  const result = await fetchChart(points, boom);
  assert.equal(result.onRoute, null);
  assert.match(result.reasons[0], /network error \(TypeError\)/);
});

test('fetchChart with unparseable JSON or a changed shape is unknown', async () => {
  const bad = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  assert.match((await fetchChart(points, bad)).reasons[0], /unparseable/);
  const changed = async () => ok({ features: [] });
  assert.match((await fetchChart(points, changed)).reasons[0], /no data list/);
  const noRoute = await fetchChart([], ok);
  assert.match(noRoute.reasons[0], /no route polyline/);
});

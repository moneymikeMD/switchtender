// Tests for the shared route-distance helpers (src/polyline.js) and the one
// HTTP helper every feed uses (src/http.js). Pure, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distanceToPolylineMetres, nearPolyline, haversineMetres } from '../src/polyline.js';
import { getJson, getText, USER_AGENT } from '../src/http.js';

// A straight north-south line at longitude -71.2 with two vertices 2 km
// apart, like the sparse tail of the routes fixture. Not a real place.
const a = [42.40, -71.2];
const b = [42.418, -71.2];
const line = [a, b];

test('distance to a polyline is to the nearest segment, not the nearest vertex', () => {
  // Midway along the segment, 100 m to the east.
  const mid = [(a[0] + b[0]) / 2, -71.2 + 100 / (111_320 * Math.cos((42.409 * Math.PI) / 180))];
  const toSegment = distanceToPolylineMetres(line, mid);
  const toVertex = Math.min(haversineMetres(a, mid), haversineMetres(b, mid));
  assert.ok(Math.abs(toSegment - 100) < 1, `segment distance ${toSegment}`);
  assert.ok(toVertex > 900, `vertex distance ${toVertex} would have missed it`);
  // Beyond the end the distance is to the end vertex.
  const past = [b[0] + 0.001, -71.2];
  assert.ok(Math.abs(distanceToPolylineMetres(line, past) - haversineMetres(b, past)) < 1);
  assert.equal(distanceToPolylineMetres([], mid), Infinity);
  assert.ok(Math.abs(distanceToPolylineMetres([a], mid) - haversineMetres(a, mid)) < 1);
});

test('nearPolyline honours the radius and never places the unplaceable', () => {
  const mid = [(a[0] + b[0]) / 2, -71.2 + 100 / (111_320 * Math.cos((42.409 * Math.PI) / 180))];
  assert.equal(nearPolyline(line, mid, 120), true);
  assert.equal(nearPolyline(line, mid, 80), false);
  assert.equal(nearPolyline(line, [null, -71.2], 1000), false);
  assert.equal(nearPolyline(null, mid, 1000), false);
  assert.equal(nearPolyline([], mid, 1000), false);
});

test('getJson and getText never throw, name the failure class, add the query at call time and send one User-Agent', async () => {
  const calls = [];
  const okJson = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ hi: 1 }), text: async () => 'hi' }; };
  const signal = AbortSignal.timeout(10_000);
  assert.deepEqual(await getJson({ url: 'https://x.test/a', params: { p: '1' } }, { fetchImpl: okJson, query: { key: 'k' }, signal }), { data: { hi: 1 } });
  assert.equal(calls[0].url, 'https://x.test/a?p=1&key=k');
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.deepEqual(await getText('https://x.test/b', { fetchImpl: okJson }), { text: 'hi' });
  assert.equal(calls[1].init.headers.Accept, 'text/html');

  const boom = async () => { throw new TypeError('fetch failed: https://x.test/a?key=k'); };
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: boom }), { error: 'network error (TypeError)' });
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: async () => ({ ok: false, status: 503 }) }), { error: 'HTTP 503' });
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: async () => undefined }), { error: 'HTTP unknown' });
  const bad = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); }, text: async () => { throw new Error('y'); } });
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: bad }), { error: 'unparseable response' });
  assert.deepEqual(await getText('https://x.test/a', { fetchImpl: bad }), { error: 'unparseable response' });
  const aborted = async (_url, init) => { throw init.signal.reason; };
  const result = await getJson('https://x.test/a', { fetchImpl: aborted, signal: AbortSignal.abort(new DOMException('t', 'TimeoutError')) });
  assert.deepEqual(result, { error: 'network error (TimeoutError)' });
});

// Tests for the two-option computation. No network: every case runs against a
// recorded-shape fixture or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseDuration,
  summariseCongestion,
  buildOptions,
  computeOptions,
  driveRequest,
  transitRequest,
  RouteError,
} from '../src/routes.js';
import { decodePolyline, cumulativeDistances } from '../src/polyline.js';

const fixture = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));

test('durations parse from the second-suffixed string form', () => {
  assert.equal(parseDuration('2700s'), 2700);
  assert.equal(parseDuration('0s'), 0);
  assert.throws(() => parseDuration(2700), RouteError);
  assert.throws(() => parseDuration('2700'), RouteError);
  assert.throws(() => parseDuration('abcs'), RouteError);
});

test('polyline round-trips to the geometry the fixture describes', () => {
  const points = decodePolyline(fixture.driveThrough.polyline.encodedPolyline);
  assert.equal(points.length, 15);
  const cumulative = cumulativeDistances(points);
  // Eleven closely spaced points covering about half a kilometre, then four
  // long hops covering about eight.
  assert.ok(Math.abs(cumulative[10] - 500) < 20, `dense section ${cumulative[10]}`);
  assert.ok(Math.abs(cumulative[14] - cumulative[10] - 8056) < 50);
});

test('congestion is weighted by distance, not by point index', () => {
  const { score, share, totalMetres } = summariseCongestion(fixture.driveThrough);

  // The jam covers 10 of 14 index spans. Index weighting would score about
  // 0.71 and call this a badly congested route. It is not: those ten spans are
  // 500 metres of an 8.5 kilometre drive.
  assert.ok(score < 0.1, `distance-weighted score should be small, got ${score}`);
  assert.ok(Math.abs(share.TRAFFIC_JAM - 500 / 8556) < 0.01);
  assert.ok(Math.abs(totalMetres - 8556) < 50);
});

test('an all-clear route scores zero and a fully jammed route scores one', () => {
  const polyline = fixture.driveThrough.polyline.encodedPolyline;
  const clear = {
    polyline: { encodedPolyline: polyline },
    travelAdvisory: {
      speedReadingIntervals: [
        { startPolylinePointIndex: 0, endPolylinePointIndex: 14, speed: 'NORMAL' },
      ],
    },
  };
  const jammed = {
    polyline: { encodedPolyline: polyline },
    travelAdvisory: {
      speedReadingIntervals: [
        { startPolylinePointIndex: 0, endPolylinePointIndex: 14, speed: 'TRAFFIC_JAM' },
      ],
    },
  };
  assert.equal(summariseCongestion(clear).score, 0);
  assert.equal(summariseCongestion(jammed).score, 1);
});

test('missing speed intervals report unknown, never clear', () => {
  // The distinction that matters: a score of 0 claims the road is clear. Not
  // knowing is a different statement and the verdict must be able to tell.
  for (const route of [
    {},
    { polyline: { encodedPolyline: 'abc' } },
    { travelAdvisory: { speedReadingIntervals: [] }, polyline: { encodedPolyline: 'abc' } },
  ]) {
    const summary = summariseCongestion(route);
    assert.equal(summary.score, null);
    assert.equal(summary.unknown, true);
  }
});

test('out-of-range interval indices are clamped rather than throwing', () => {
  const summary = summariseCongestion({
    polyline: { encodedPolyline: fixture.driveThrough.polyline.encodedPolyline },
    travelAdvisory: {
      speedReadingIntervals: [
        { startPolylinePointIndex: 0, endPolylinePointIndex: 9999, speed: 'NORMAL' },
      ],
    },
  });
  assert.equal(summary.score, 0);
  assert.ok(summary.totalMetres > 8000);
});

test('the two options are comparable totals measured from the fork', () => {
  const options = buildOptions(fixture, 5);
  assert.equal(options.driveThrough.totalSeconds, 2700);
  // 600 driving + 300 buffer + 1500 transit
  assert.equal(options.parkAndRide.totalSeconds, 2400);
  assert.equal(options.parkAndRide.bufferSeconds, 300);
  assert.equal(options.parkAndRide.driveSeconds, 600);
  assert.equal(options.parkAndRide.transitSeconds, 1500);
});

test('the park-to-platform buffer actually changes the total', () => {
  assert.equal(buildOptions(fixture, 0).parkAndRide.totalSeconds, 2100);
  assert.equal(buildOptions(fixture, 10).parkAndRide.totalSeconds, 2700);
});

test('driving asks for the optimal traffic preference and speed intervals', () => {
  const body = driveRequest({ lat: 1, lon: 2 }, { lat: 3, lon: 4 });
  assert.equal(body.travelMode, 'DRIVE');
  assert.equal(body.routingPreference, 'TRAFFIC_AWARE_OPTIMAL');
  assert.deepEqual(body.extraComputations, ['TRAFFIC_ON_POLYLINE']);
  assert.equal(body.origin.location.latLng.latitude, 1);
  assert.equal(body.destination.location.latLng.longitude, 4);
});

test('transit carries no routing preference, which the API rejects for it', () => {
  const body = transitRequest({ lat: 1, lon: 2 }, { lat: 3, lon: 4 });
  assert.equal(body.travelMode, 'TRANSIT');
  assert.equal(body.routingPreference, undefined);
  assert.equal(body.extraComputations, undefined);
});

test('computeOptions issues three requests from the fork, not from the origin', async () => {
  const seen = [];
  const stub = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const which =
      body.travelMode === 'TRANSIT'
        ? fixture.transit
        : seen.length === 1
          ? fixture.driveThrough
          : fixture.driveToParkAndRide;
    return { ok: true, json: async () => ({ routes: [which] }) };
  };

  const config = {
    route: {
      origin: { lat: 42.46, lon: -71.35, label: 'origin' },
      decision_point: { lat: 42.4, lon: -71.22, label: 'fork' },
      park_and_ride: { lat: 42.39, lon: -71.14, label: 'pnr', park_to_platform_minutes: 5 },
      destination: { lat: 42.35, lon: -71.06, label: 'destination' },
    },
  };

  const options = await computeOptions(config, 'test-key', stub);
  assert.equal(seen.length, 3);

  // Nothing requested starts at the origin. The shared leg is never measured.
  for (const body of seen) {
    assert.notEqual(body.origin.location.latLng.latitude, 42.46);
  }
  assert.equal(options.driveThrough.totalSeconds, 2700);
  assert.equal(options.parkAndRide.totalSeconds, 2400);
});

test('an HTTP failure raises a RouteError that does not echo the request', async () => {
  const stub = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const config = {
    route: {
      decision_point: { lat: 1, lon: 2 },
      park_and_ride: { lat: 3, lon: 4, park_to_platform_minutes: 5 },
      destination: { lat: 5, lon: 6 },
    },
  };
  await assert.rejects(
    () => computeOptions(config, 'k', stub),
    (e) => e instanceof RouteError && e.message.includes('403') && !e.message.includes('latLng'),
  );
});

test('an empty route list is an error, not an undefined duration', async () => {
  const stub = async () => ({ ok: true, json: async () => ({ routes: [] }) });
  const config = {
    route: {
      decision_point: { lat: 1, lon: 2 },
      park_and_ride: { lat: 3, lon: 4, park_to_platform_minutes: 5 },
      destination: { lat: 5, lon: 6 },
    },
  };
  await assert.rejects(() => computeOptions(config, 'k', stub), RouteError);
});

test('the drive-through option carries its decoded polyline for spatial feeds, or null without one', () => {
  const options = buildOptions(fixture, 5);
  assert.ok(Array.isArray(options.driveThrough.points));
  assert.ok(options.driveThrough.points.length > 2);
  assert.equal(options.driveThrough.points[0].length, 2);

  const bare = structuredClone(fixture);
  delete bare.driveThrough.polyline;
  assert.equal(buildOptions(bare, 5).driveThrough.points, null);
});

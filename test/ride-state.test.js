// Tests for the ride object store (src/ride/state.js). No network: every GCS
// call goes through a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RIDE_VERSION,
  CANCEL_REASONS,
  UPDATE_ATTEMPTS,
  STALE_LAUNCH_MS,
  RideStoreError,
  rideKey,
  newRide,
  claimRide,
  readRide,
  updateRide,
  withLaunch,
  relaunched,
  withFix,
  withCancel,
  launchStale,
  withLock,
  withTracking,
  withAlert,
  withStatus,
  withEnded,
  summary,
} from '../src/ride/state.js';

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const now = new Date('2026-10-21T11:15:00Z');
const fresh = () =>
  newRide({
    key: rideKey('2026-10-21', 'am'),
    leg: 'am',
    localDate: '2026-10-21',
    timeZone: 'America/New_York',
    fenceAt: '2026-10-21T11:14:30.000Z',
    now,
    gpsFrom: new Date('2026-10-21T11:20:00Z'),
    gpsUntil: new Date('2026-10-21T11:45:00Z'),
  });

test('a new ride has the documented shape: endpoint fields filled, Job fields empty, a random cancel token', () => {
  assert.equal(rideKey('2026-10-21', 'pm'), 'rides/2026-10-21-pm.json');
  const ride = fresh();
  assert.match(ride.cancel_token, /^[A-Za-z0-9_-]{32,}$/);
  assert.notEqual(ride.cancel_token, fresh().cancel_token);
  const { cancel_token, ...rest } = ride;
  assert.deepEqual(rest, {
    version: RIDE_VERSION,
    key: 'rides/2026-10-21-am.json',
    leg: 'am',
    local_date: '2026-10-21',
    timezone: 'America/New_York',
    fence_at: '2026-10-21T11:14:30.000Z',
    claimed_at: '2026-10-21T11:15:00.000Z',
    gps_from: '2026-10-21T11:20:00.000Z',
    gps_until: '2026-10-21T11:45:00.000Z',
    status: 'launching',
    launch: null,
    fixes: [],
    cancel: null,
    lock: null,
    tracking: null,
    alerts: [],
    statuses: [],
    ended: null,
  });
  assert.deepEqual([...CANCEL_REASONS], ['off', 'not-riding']);
  assert.ok(!('cancel_token' in summary(ride)));
});

test('a launch is stale when it failed or when "launching" is older than STALE_LAUNCH_MS', () => {
  const ride = fresh();
  const later = new Date(now.getTime() + STALE_LAUNCH_MS + 1);
  assert.equal(launchStale(ride, now), false);
  assert.equal(launchStale(ride, new Date(now.getTime() + STALE_LAUNCH_MS)), false);
  assert.equal(launchStale(ride, later), true);
  assert.equal(launchStale(withLaunch(ride, { ok: true, now }), later), false);
  assert.equal(launchStale(withLaunch(ride, { ok: false, error: 'x', now }), now), true);
  assert.equal(launchStale({ ...ride, claimed_at: 'garbage' }, now), true);
});

test('the Job mutations: lock, tracking, alerts and statuses at most once per key, the first end wins', () => {
  const ride = fresh();
  const locked = withLock(ride, { trainId: '508', now, departedAt: '2026-10-21T11:22:00.000Z', meanDistanceM: 41 });
  assert.deepEqual(locked.lock, {
    method: 'gps',
    train_id: '508',
    at: '2026-10-21T11:15:00.000Z',
    departed_at: '2026-10-21T11:22:00.000Z',
    mean_distance_m: 41,
  });
  const tracked = withTracking(withTracking(locked, { phase: 'leg0', transfer_at: null, candidates: [] }), { candidates: ['1', '2'] });
  assert.deepEqual(tracked.tracking, { phase: 'leg0', transfer_at: null, candidates: ['1', '2'] });

  const alerted = withAlert(ride, { key: 'leg0', now, station: 'A01', trainId: '508', circuit: 1234, title: 'alert', text: 'Next stop.' });
  assert.deepEqual(alerted.alerts, [
    { key: 'leg0', at: '2026-10-21T11:15:00.000Z', station: 'A01', train_id: '508', circuit: 1234, title: 'alert', text: 'Next stop.' },
  ]);
  assert.equal(withAlert(alerted, { key: 'leg0', now, station: 'A01', trainId: '508', title: 'alert', text: 'again' }), null);
  assert.equal(withAlert(alerted, { key: 'leg1:0', now, station: 'F03', trainId: '9', title: 'alert', text: 'x' }).alerts.length, 2);

  const pushed = withStatus(ride, { key: 'lock', now, text: 'Tracking' });
  assert.deepEqual(pushed.statuses, [{ key: 'lock', at: '2026-10-21T11:15:00.000Z', text: 'Tracking' }]);
  assert.equal(withStatus(pushed, { key: 'lock', now, text: 'Tracking' }), null);

  const ended = withEnded(ride, { reason: 'done', now });
  assert.equal(ended.status, 'ended');
  assert.deepEqual(ended.ended, { reason: 'done', at: '2026-10-21T11:15:00.000Z' });
  assert.deepEqual(withEnded(ended, { reason: 'crash', now: new Date() }).ended, ended.ended);
  assert.deepEqual(ride.alerts, [], 'the input is not mutated');
});

test('claimRide creates the object with ifGenerationMatch=0 and a bearer token; a 412 means someone else did', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return json(200, { generation: '1760000000000001' });
  };
  const claimed = await claimRide({ bucket: 'rides-bucket', ride: fresh(), token: 'tok', fetchImpl });
  assert.deepEqual(claimed, { claimed: true, generation: '1760000000000001' });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://storage.googleapis.com/upload/storage/v1/b/rides-bucket/o?uploadType=media&name=rides%2F2026-10-21-am.json&ifGenerationMatch=0',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(calls[0].init.body).status, 'launching');

  const lost = await claimRide({ bucket: 'b', ride: fresh(), token: 'tok', fetchImpl: async () => json(412, { error: { message: 'Precondition Failed' } }) });
  assert.deepEqual(lost, { claimed: false, generation: null });

  await assert.rejects(
    claimRide({ bucket: 'b', ride: fresh(), token: 'tok', fetchImpl: async () => json(403, { error: { message: 'forbidden' } }) }),
    (e) => e instanceof RideStoreError && e.status === 403 && /gcs 403: forbidden/.test(e.message),
  );
  await assert.rejects(
    claimRide({
      bucket: 'b',
      ride: fresh(),
      token: 'tok',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }),
    /network \(TypeError\): fetch failed/,
  );
});

test('readRide returns the object and its generation from the media download, or null for 404', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return json(200, fresh(), { 'x-goog-generation': '42' });
  };
  const read = await readRide({ bucket: 'b', key: 'rides/2026-10-21-am.json', token: 'tok', fetchImpl });
  assert.equal(read.generation, '42');
  assert.equal(read.ride.leg, 'am');
  assert.deepEqual(calls, ['https://storage.googleapis.com/storage/v1/b/b/o/rides%2F2026-10-21-am.json?alt=media']);

  assert.equal(
    await readRide({ bucket: 'b', key: 'rides/x.json', token: 'tok', fetchImpl: async () => json(404, { error: { message: 'No such object' } }) }),
    null,
  );

  // Without the header the generation comes from a metadata read.
  const meta = async (url) => (url.endsWith('?alt=media') ? json(200, fresh()) : json(200, { generation: 7 }));
  assert.equal((await readRide({ bucket: 'b', key: 'rides/x.json', token: 'tok', fetchImpl: meta })).generation, '7');

  await assert.rejects(
    readRide({ bucket: 'b', key: 'rides/x.json', token: 'tok', fetchImpl: async () => new Response('not json', { status: 200 }) }),
    /is not JSON/,
  );
});

test('updateRide writes with the generation it read, retries on 412, and gives up after UPDATE_ATTEMPTS', async () => {
  let generation = 10;
  const writes = [];
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET')
      return json(200, { ...fresh(), fixes: writes.length ? [{ n: writes.length }] : [] }, { 'x-goog-generation': String(generation) });
    writes.push(url);
    // The first write races a concurrent writer; the second lands.
    if (writes.length === 1) {
      generation += 1;
      return json(412, { error: { message: 'Precondition Failed' } });
    }
    return json(200, { generation: String(generation + 1) });
  };
  const result = await updateRide({ bucket: 'b', key: 'rides/k.json', token: 'tok', fetchImpl, mutate: (r) => ({ ...r, cancel: { reason: 'off' } }) });
  assert.equal(result.updated, true);
  assert.equal(result.generation, '12');
  assert.deepEqual(result.ride.cancel, { reason: 'off' });
  // The mutation was applied to what was re-read, not to the stale copy.
  assert.deepEqual(result.ride.fixes, [{ n: 1 }]);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /ifGenerationMatch=10$/);
  assert.match(writes[1], /ifGenerationMatch=11$/);

  const always412 = async (url, init) =>
    init.method === 'GET' ? json(200, fresh(), { 'x-goog-generation': '1' }) : json(412, { error: { message: 'Precondition Failed' } });
  let attempts = 0;
  await assert.rejects(
    updateRide({
      bucket: 'b',
      key: 'k',
      token: 'tok',
      fetchImpl: async (url, init) => {
        if (init.method !== 'GET') attempts += 1;
        return always412(url, init);
      },
      mutate: (r) => r,
    }),
    (e) => e instanceof RideStoreError && e.status === 412,
  );
  assert.equal(attempts, UPDATE_ATTEMPTS);

  assert.equal(await updateRide({ bucket: 'b', key: 'k', token: 'tok', fetchImpl: async () => json(404), mutate: (r) => r }), null);

  // A mutate that returns null writes nothing.
  const quiet = [];
  const untouched = await updateRide({
    bucket: 'b',
    key: 'k',
    token: 'tok',
    fetchImpl: async (url, init) => {
      if (init.method !== 'GET') quiet.push(url);
      return json(200, fresh(), { 'x-goog-generation': '3' });
    },
    mutate: () => null,
  });
  assert.equal(untouched.updated, false);
  assert.equal(untouched.generation, '3');
  assert.deepEqual(quiet, []);
});

test('the mutations: launch outcome, relaunch, fix with m/s beside km/h, first cancel wins', () => {
  const ride = fresh();
  const launched = withLaunch(ride, { ok: true, operation: 'projects/p/locations/r/operations/1', now });
  assert.equal(launched.status, 'launched');
  assert.deepEqual(launched.launch, { ok: true, operation: 'projects/p/locations/r/operations/1', error: null, at: '2026-10-21T11:15:00.000Z' });
  const failed = withLaunch(ride, { ok: false, error: 'run 403: nope', now });
  assert.equal(failed.status, 'launch_failed');
  assert.equal(failed.launch.error, 'run 403: nope');

  const again = relaunched(failed, {
    now: new Date('2026-10-21T11:16:00Z'),
    fenceAt: '2026-10-21T11:15:50.000Z',
    gpsFrom: new Date('2026-10-21T11:21:00Z'),
    gpsUntil: new Date('2026-10-21T11:46:00Z'),
  });
  assert.equal(again.status, 'launching');
  assert.equal(again.launch, null);
  assert.equal(again.claimed_at, '2026-10-21T11:16:00.000Z');
  assert.equal(again.gps_until, '2026-10-21T11:46:00.000Z');

  const fixed = withFix(ride, {
    at: new Date('2026-10-21T11:21:00Z'),
    now: new Date('2026-10-21T11:21:02Z'),
    lat: 42.39,
    lon: -71.14,
    accuracyM: 13,
    speedKmh: 54,
  });
  assert.deepEqual(fixed.fixes, [
    { at: '2026-10-21T11:21:00.000Z', received_at: '2026-10-21T11:21:02.000Z', lat: 42.39, lon: -71.14, accuracy_m: 13, speed_kmh: 54, speed_mps: 15 },
  ]);
  assert.deepEqual(ride.fixes, [], 'the input is not mutated');
  const bare = withFix(ride, { at: now, now, lat: 1, lon: 2 });
  assert.deepEqual({ a: bare.fixes[0].accuracy_m, k: bare.fixes[0].speed_kmh, m: bare.fixes[0].speed_mps }, { a: null, k: null, m: null });

  const cancelled = withCancel(ride, { reason: 'not-riding', now });
  assert.deepEqual(cancelled.cancel, { reason: 'not-riding', at: '2026-10-21T11:15:00.000Z' });
  assert.deepEqual(withCancel(cancelled, { reason: 'off', now: new Date() }).cancel, cancelled.cancel);
});

test('summary tells the phone whether to keep sending', () => {
  assert.deepEqual(summary(fresh()), { status: 'launching', locked: false, cancelled: false, ended: false, done: false, fixes: 0 });
  assert.equal(summary({ ...fresh(), lock: { method: 'gps', train_id: '123' } }).done, true);
  assert.equal(summary({ ...fresh(), ended: { reason: 'exit' } }).done, true);
  assert.equal(summary(withCancel(fresh(), { reason: 'off', now })).done, true);
  // A Job that wrote a status the endpoints never set is reported as is.
  assert.equal(summary({ ...fresh(), status: 'tracking' }).status, 'tracking');
});

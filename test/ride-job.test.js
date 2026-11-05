// Tests for the ride Job (src/ride/job.js): whole simulated rides in
// milliseconds. No network and no real clock: the feed is synthesised over
// the recorded StandardRoutes fixture, the store is in memory, ntfy and WMATA
// are a stub fetch, and sleep advances a fake clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runRide, recordCrash, jobEnv, ENDPOINTS, POLL_MS, FAST_POLL_MS, MAX_RIDE_MS, END_AFTER_LAST_ALERT_MS, LOCK_GRACE_MS } from '../src/ride/job.js';
import { buildCircuitIndex, buildStationIndex, seqToPosition } from '../src/ride/track.js';
import { clockAt, NOT_TRACKING } from '../src/ride/plan.js';
import * as rideState from '../src/ride/state.js';

const { newRide, withLaunch, rideKey } = rideState;

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/ride/${name}`, import.meta.url), 'utf8'));
const standardRoutes = fixture('standard-routes.json');
const stationsJson = fixture('stations.json');
const index = buildCircuitIndex(standardRoutes);
const stations = buildStationIndex(stationsJson);
const circuitOf = new Map();
for (const [id, c] of index.circuits) circuitOf.set(`${c.line}:${c.track}:${c.seq}`, id);
const circuitAt = (line, track, seq) => {
  const id = circuitOf.get(`${line}:${track}:${seq}`);
  if (id === undefined) throw new Error(`no circuit ${line} ${track} ${seq}`);
  return id;
};

const TZ = 'America/New_York';
const MIN = 60_000;
const T0 = Date.parse('2026-10-21T11:15:00Z');
const GPS_FROM = T0 + 5 * MIN;
const GPS_UNTIL = GPS_FROM + 25 * MIN;
const KEY = rideKey('2026-10-21', 'am');
const TOPIC = 'r1d3t0p1c';
const SERVICE = 'https://svc.example.run.app';
const API_KEY = 'wmata-key-never-in-a-url';
const SEC_PER_SEQ = 4;
const DWELL_MS = 30_000;

const red = { line: 'Red', board: 'Shady Grove', alight: 'Gallery Place', board_code: 'A15', alight_code: 'B01', alert_code: null };
const green = { line: 'Green', board: 'Gallery Place', alight: 'Waterfront', board_code: 'F01', alight_code: 'F04', alert_code: null };
const config = {
  route: { timezone: TZ },
  log: { sheet_id: 'sheet', sheet_tab: 'verdicts', arrivals_tab: 'arrivals' },
  ride: { sheet_tab: 'rides', am: { legs: [red, green] }, pm: { legs: [] } },
};

// A train that sits at `from` for 90 s, leaves at `departAt`, runs at
// SEC_PER_SEQ per circuit and dwells DWELL_MS at every station to the end of
// the track, then leaves the feed. `vanishAt` drops it from the feed early.
function makeTrain({ id, line, track, from, dir, departAt, dest, service = 'Normal', vanishAt = Infinity }) {
  const list = index.tracks.get(`${line}:${track}`).stations;
  const start = list.findIndex((s) => s.code === from);
  const way = [{ at: departAt, seq: list[start].seq, code: from }];
  let t = departAt;
  let seq = list[start].seq;
  for (let i = start + dir; i >= 0 && i < list.length; i += dir) {
    const s = list[i];
    t += Math.abs(s.seq - seq) * SEC_PER_SEQ * 1000;
    seq = s.seq;
    way.push({ at: t, seq, code: s.code });
    t += DWELL_MS;
    way.push({ at: t, seq, code: s.code });
  }
  const seqAt = (now) => {
    if (now <= way[0].at) return way[0].seq;
    if (now >= way.at(-1).at) return way.at(-1).seq;
    for (let i = 1; i < way.length; i++) {
      const a = way[i - 1];
      const b = way[i];
      if (now >= a.at && now <= b.at) return a.seq + ((b.seq - a.seq) * (now - a.at)) / (b.at - a.at);
    }
    return way.at(-1).seq;
  };
  return {
    id,
    departAt,
    arrivalAt: (code) => way.find((w) => w.code === code && w.at > departAt)?.at ?? null,
    position: (now) => seqToPosition(index, stations, line, track, seqAt(now)),
    at(now) {
      if (now >= vanishAt || now < departAt - 90_000 || now > way.at(-1).at) return null;
      return {
        TrainId: id,
        TrainNumber: '118',
        CarCount: 8,
        DirectionNum: dir === 1 ? 1 : 2,
        CircuitId: circuitAt(line, track, Math.round(seqAt(now))),
        DestinationStationCode: dest,
        LineCode: line,
        SecondsAtLocation: 5,
        ServiceType: service,
      };
    },
  };
}

const fixesAlong = (train, times, { accuracy = 15, speedKmh = 64.8 } = {}) =>
  times.map((at) => {
    const pos = train.position(at);
    return {
      at: new Date(at).toISOString(),
      received_at: new Date(at + 2000).toISOString(),
      lat: pos.lat,
      lon: pos.lon,
      accuracy_m: accuracy,
      speed_kmh: speedKmh,
      speed_mps: Math.round((speedKmh / 3.6) * 100) / 100,
    };
  });

function morningTrains() {
  const r1 = makeTrain({ id: 'R1', line: 'RD', track: 1, from: 'A15', dir: 1, departAt: GPS_FROM + 1 * MIN, dest: 'B11' });
  const b01 = r1.arrivalAt('B01');
  const minute = (ms) => Math.ceil(ms / MIN) * MIN;
  return {
    r1,
    r0: makeTrain({ id: 'R0', line: 'RD', track: 1, from: 'A15', dir: 1, departAt: GPS_FROM - 3 * MIN, dest: 'B11' }),
    r2: makeTrain({ id: 'R2', line: 'RD', track: 1, from: 'A15', dir: 1, departAt: GPS_FROM + 1 * MIN + 30_000, dest: 'B11' }),
    g0: makeTrain({ id: 'G0', line: 'GR', track: 1, from: 'F01', dir: -1, departAt: b01 + 1 * MIN, dest: 'F11' }),
    g1: makeTrain({ id: 'G1', line: 'GR', track: 1, from: 'F01', dir: -1, departAt: minute(b01) + 4 * MIN, dest: 'F11' }),
    gx: makeTrain({ id: 'GX', line: 'GR', track: 1, from: 'F01', dir: 1, departAt: minute(b01) + 5 * MIN, dest: 'E10' }),
    g2: makeTrain({ id: 'G2', line: 'GR', track: 1, from: 'F01', dir: -1, departAt: minute(b01) + 7 * MIN, dest: 'F11' }),
    g3: makeTrain({ id: 'G3', line: 'GR', track: 1, from: 'F01', dir: -1, departAt: minute(b01) + 10 * MIN, dest: 'F11' }),
  };
}

const lockFixes = (r1) =>
  fixesAlong(
    r1,
    Array.from({ length: 12 }, (_, i) => r1.departAt + 30_000 * (i + 1)),
  );

function freshRide({ leg = 'am', gpsUntil = GPS_UNTIL } = {}) {
  const ride = newRide({
    key: rideKey('2026-10-21', leg),
    leg,
    localDate: '2026-10-21',
    timeZone: TZ,
    fenceAt: new Date(T0).toISOString(),
    now: new Date(T0),
    gpsFrom: new Date(GPS_FROM),
    gpsUntil: new Date(gpsUntil),
  });
  return withLaunch(ride, { ok: true, operation: 'op', now: new Date(T0 + 1000) });
}

// The whole world of one ride: a clock, a store the phone writes fixes into,
// a feed built from trains, ntfy and the Sheets row as recorders.
function world({ trains = [], fixes = [], ride = freshRide(), hooks = [], failPositions = () => false, failRoutes = false } = {}) {
  let clock = T0;
  let seq = 0;
  const w = { clock: () => clock, intervals: [], pushes: [], feedCalls: 0, rows: [], writes: [], ride, generation: 1 };
  const syncFixes = () => {
    const have = new Set(w.ride.fixes.map((f) => f.at));
    for (const f of fixes) if (Date.parse(f.at) <= clock && !have.has(f.at)) w.ride.fixes.push(f);
  };
  w.store = {
    ...rideState,
    async readRide({ key, token }) {
      assert.equal(token, 'tok');
      if (key !== w.ride.key) return null;
      syncFixes();
      return { ride: structuredClone(w.ride), generation: String(w.generation) };
    },
    async updateRide({ key, mutate }) {
      if (key !== w.ride.key) return null;
      syncFixes();
      const next = mutate(structuredClone(w.ride));
      if (next === null) return { ride: structuredClone(w.ride), generation: String(w.generation), updated: false };
      w.ride = next;
      w.generation += 1;
      w.writes.push({ n: seq++, alerts: next.alerts.map((a) => a.key), statuses: next.statuses.map((s) => s.key) });
      return { ride: structuredClone(next), generation: String(w.generation), updated: true };
    },
  };
  w.fetchImpl = async (url, init) => {
    assert.ok(!String(url).includes(API_KEY), 'the key is never in a URL');
    if (url === ENDPOINTS.routes || url === ENDPOINTS.stations) {
      assert.equal(init.headers.api_key, API_KEY);
      if (failRoutes) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (url === ENDPOINTS.routes ? standardRoutes : stationsJson) };
    }
    if (url === ENDPOINTS.positions) {
      assert.equal(init.headers.api_key, API_KEY);
      w.feedCalls += 1;
      if (failPositions(w.feedCalls)) throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ TrainPositions: trains.map((t) => t.at(clock)).filter(Boolean) }) };
    }
    if (url === `https://ntfy.sh/${TOPIC}`) {
      w.pushes.push({
        n: seq++,
        at: clock,
        title: init.headers.Title,
        priority: init.headers.Priority,
        actions: init.headers.Actions ?? null,
        body: init.body,
      });
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  w.deps = {
    key: ride.key,
    bucket: 'rides-bucket',
    config,
    topic: TOPIC,
    serviceUrl: SERVICE,
    apiKey: API_KEY,
    now: () => new Date(clock),
    sleep: async (ms) => {
      w.intervals.push(ms);
      for (const h of hooks) if (!h.done && clock + ms >= h.at) ((h.done = true), h.run(w));
      if (w.crash && w.crash(w)) throw new Error('simulated crash');
      clock += ms;
    },
    fetchImpl: w.fetchImpl,
    store: w.store,
    tokenProvider: async () => 'tok',
    log: async ({ ride: r }) => {
      w.rows.push(structuredClone(r));
      return { ok: true, error: null };
    },
    logger: () => {},
  };
  return w;
}

const alerts = (w) => w.pushes.filter((p) => p.title !== 'Ride status');
const statuses = (w) => w.pushes.filter((p) => p.title === 'Ride status');
const text = (p) => p.body.slice(0, p.body.lastIndexOf('|'));
const epoch = (p) => Number(p.body.slice(p.body.lastIndexOf('|') + 1));

test('a morning ride end to end: lock, one Metro Center alert, two Green alerts, the row, exit 0', async () => {
  const t = morningTrains();
  const w = world({ trains: Object.values(t), fixes: lockFixes(t.r1) });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'done', exitCode: 0 });

  const ride = w.ride;
  assert.equal(ride.status, 'ended');
  assert.deepEqual({ method: ride.lock.method, id: ride.lock.train_id, m: ride.lock.mean_distance_m < 100 }, { method: 'gps', id: 'R1', m: true });
  assert.ok(Date.parse(ride.lock.at) < t.r1.arrivalAt('A11'), 'locked on the above-ground stretch');
  assert.deepEqual(ride.tracking.candidates, ['G1', 'G2']);
  assert.equal(ride.tracking.phase, 'leg1');
  assert.deepEqual(
    ride.alerts.map((a) => [a.key, a.station, a.train_id, a.title]),
    [
      ['leg0', 'A01', 'R1', 'alert'],
      ['leg1:0', 'F03', 'G1', 'alert'],
      ['leg1:1', 'F03', 'G2', 'once'],
    ],
  );
  assert.deepEqual(
    ride.statuses.map((s) => s.key),
    ['lock'],
  );
  assert.equal(ride.ended.reason, 'done');
  const lastAlert = Date.parse(ride.alerts.at(-1).at);
  const endedAt = Date.parse(ride.ended.at);
  assert.ok(
    endedAt >= lastAlert + END_AFTER_LAST_ALERT_MS && endedAt < lastAlert + END_AFTER_LAST_ALERT_MS + POLL_MS,
    'ends five minutes after the last alert',
  );

  // The wire format, in order: the quiet lock status, then the three alerts.
  assert.equal(w.pushes.length, 4);
  const [lock, a0, a1, a2] = w.pushes;
  assert.deepEqual([lock.title, lock.priority, text(lock), lock.actions], ['Ride status', '3', 'Tracking the 7:21 from Shady Grove', null]);
  assert.deepEqual([a0.title, a0.priority, text(a0)], ['Ride alert', '5', 'Next stop Gallery Place. Transfer to Green.']);
  assert.deepEqual(
    [a1.title, a1.priority, text(a1)],
    ['Ride alert', '5', `Next stop Waterfront. You're on the ${clockAt(t.g1.departAt, TZ)} from Gallery Place.`],
  );
  assert.deepEqual([a2.title, a2.priority, text(a2)], ['Ride', '5', `Next stop Waterfront. You're on the ${clockAt(t.g2.departAt, TZ)} from Gallery Place.`]);
  for (const p of w.pushes) assert.equal(epoch(p), Math.floor(p.at / 1000), 'the body carries the send epoch');
  for (const p of [a0, a1, a2]) {
    assert.equal(
      p.actions,
      `http, I'm off, ${SERVICE}/ride/cancel?leg=am&reason=off&token=${ride.cancel_token}, clear=true; ` +
        `http, Not riding, ${SERVICE}/ride/cancel?leg=am&reason=not-riding&token=${ride.cancel_token}, clear=true`,
    );
  }
  // Each alert is in the object before it goes out.
  for (const [i, key] of ['leg0', 'leg1:0', 'leg1:1'].entries()) {
    const recorded = w.writes.find((x) => x.alerts.includes(key));
    assert.ok(recorded.n < [a0, a1, a2][i].n, `${key} recorded before sent`);
  }
  // The Metro Center alert lands while the train is still at Metro Center, before Gallery Place.
  assert.ok(a0.at >= t.r1.arrivalAt('A01') && a0.at < t.r1.arrivalAt('B01'));
  assert.ok(a1.at >= t.g1.arrivalAt('F03') && a1.at < t.g1.arrivalAt('F04'));
  assert.ok(a2.at >= t.g2.arrivalAt('F03') && a2.at < t.g2.arrivalAt('F04'));

  // Polling: 15 s, and 5 s once a tracked train is within one station of its alert.
  assert.ok(w.intervals.includes(POLL_MS) && w.intervals.includes(FAST_POLL_MS));
  assert.ok(new Set(w.intervals).size === 2);
  assert.ok(w.feedCalls > 100);

  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].ended.reason, 'done');
  assert.equal(w.rows[0].alerts.length, 3);
});

test('a restart mid-ride never resends an alert already in the object, and the lock status is not repeated', async () => {
  const t = morningTrains();
  const w = world({ trains: Object.values(t), fixes: lockFixes(t.r1) });
  w.crash = (x) => alerts(x).length === 1;
  await assert.rejects(runRide(w.deps), /simulated crash/);
  assert.equal(w.ride.status, 'tracking');
  assert.deepEqual(
    w.ride.alerts.map((a) => a.key),
    ['leg0'],
  );
  w.crash = null;
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'done', exitCode: 0 });
  assert.deepEqual(
    w.pushes.map((p) => [p.title, text(p).slice(0, 9)]),
    [
      ['Ride status', 'Tracking '],
      ['Ride alert', 'Next stop'],
      ['Ride alert', 'Next stop'],
      ['Ride', 'Next stop'],
    ],
  );
  assert.deepEqual(
    w.ride.alerts.map((a) => a.key),
    ['leg0', 'leg1:0', 'leg1:1'],
  );
  assert.equal(w.rows.length, 1);
});

test('a cancel in the object stops the loop with no further push', async () => {
  const t = morningTrains();
  const w = world({
    trains: Object.values(t),
    fixes: lockFixes(t.r1),
    hooks: [{ at: GPS_FROM + 8 * MIN, run: (x) => (x.ride.cancel = { reason: 'off', at: new Date(x.clock()).toISOString() }) }],
  });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'cancelled', exitCode: 0 });
  assert.deepEqual(
    w.pushes.map((p) => p.title),
    ['Ride status'],
  );
  assert.equal(w.ride.lock.train_id, 'R1');
  assert.deepEqual(w.ride.alerts, []);
  assert.equal(w.ride.ended.reason, 'cancelled');
  assert.ok(Date.parse(w.ride.ended.at) <= GPS_FROM + 8 * MIN + POLL_MS);
  assert.equal(w.rows[0].cancel.reason, 'off');
});

test('no lock by gps_until plus the grace: one vibrating status, end no-lock, never a guess', async () => {
  const t = morningTrains();
  const frozen = lockFixes(t.r1).map((f, i, all) => ({ ...f, lat: all[0].lat, lon: all[0].lon, speed_kmh: 0, speed_mps: 0, accuracy_m: 13 }));
  const w = world({ trains: Object.values(t), fixes: frozen });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'no-lock', exitCode: 0 });
  assert.equal(w.ride.lock, null);
  assert.deepEqual(
    w.pushes.map((p) => [p.title, p.priority, text(p), p.actions]),
    [['Ride status', '5', NOT_TRACKING, null]],
  );
  const endedAt = Date.parse(w.ride.ended.at);
  assert.ok(endedAt > GPS_UNTIL + LOCK_GRACE_MS && endedAt <= GPS_UNTIL + LOCK_GRACE_MS + POLL_MS);
  assert.deepEqual(w.ride.alerts, []);
  assert.equal(w.rows[0].ended.reason, 'no-lock');
});

test('the locked train leaving the feed is lost: one vibrating status, end lost', async () => {
  const t = morningTrains();
  t.r1 = makeTrain({ id: 'R1', line: 'RD', track: 1, from: 'A15', dir: 1, departAt: GPS_FROM + 1 * MIN, dest: 'B11', vanishAt: GPS_FROM + 6 * MIN });
  const w = world({ trains: Object.values(t), fixes: lockFixes(t.r1) });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'lost', exitCode: 0 });
  assert.equal(w.ride.lock.train_id, 'R1');
  assert.deepEqual(
    w.pushes.map((p) => [p.title, p.priority, text(p)]),
    [
      ['Ride status', '3', 'Tracking the 7:21 from Shady Grove'],
      ['Ride status', '5', NOT_TRACKING],
    ],
  );
  const endedAt = Date.parse(w.ride.ended.at);
  assert.ok(endedAt >= GPS_FROM + 6 * MIN + POLL_MS && endedAt <= GPS_FROM + 6 * MIN + 3 * POLL_MS, 'two missed polls');
  assert.deepEqual(w.ride.alerts, []);
});

test('the feed failing two polls in a row is one vibrating status; polling goes on', async () => {
  const t = morningTrains();
  const w = world({
    trains: Object.values(t),
    fixes: lockFixes(t.r1),
    failPositions: (n) => [3, 4, 10, 11, 12].includes(n),
    hooks: [{ at: T0 + 4 * MIN, run: (x) => (x.ride.cancel = { reason: 'not-riding', at: new Date(x.clock()).toISOString() }) }],
  });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'cancelled', exitCode: 0 });
  assert.deepEqual(
    w.pushes.map((p) => [p.title, p.priority, text(p)]),
    [['Ride status', '5', NOT_TRACKING]],
  );
  assert.ok(w.feedCalls >= 15);
  assert.deepEqual(
    w.ride.statuses.map((s) => s.key),
    ['feed'],
  );
});

test('a ride that never locks and never ends is capped at two hours', async () => {
  const w = world({ trains: [], ride: freshRide({ gpsUntil: T0 + 3 * 60 * MIN }) });
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'timeout', exitCode: 0 });
  assert.equal(Date.parse(w.ride.ended.at), T0 + MAX_RIDE_MS);
  assert.deepEqual(
    w.pushes.map((p) => [p.title, text(p)]),
    [['Ride status', NOT_TRACKING]],
  );
});

// The evening (CMB-161): Green from Waterfront, Red home from Gallery Place.
const homeGreen = {
  line: 'Green',
  board: 'Waterfront',
  alight: 'Gallery Place',
  board_code: 'F04',
  alight_code: 'F01',
  alert_code: null,
  gps_after_code: null,
};
const homeRed = { line: 'Red', board: 'Gallery Place', alight: 'Shady Grove', board_code: 'B01', alight_code: 'A15', alert_code: null, gps_after_code: 'A11' };
const pmConfig = { ...config, ride: { ...config.ride, pm: { gps_window_mins: 10, legs: [homeGreen, homeRed] } } };

function eveningTrains() {
  const minute = (ms) => Math.ceil(ms / MIN) * MIN;
  const g1 = makeTrain({ id: 'G1', line: 'GR', track: 1, from: 'F04', dir: 1, departAt: T0 + 2 * MIN, dest: 'E10' });
  const a1 = minute(g1.arrivalAt('F01'));
  return {
    g1,
    gx: makeTrain({ id: 'GX', line: 'GR', track: 1, from: 'F04', dir: -1, departAt: T0 + 3 * MIN, dest: 'F11' }),
    g2: makeTrain({ id: 'G2', line: 'GR', track: 1, from: 'F04', dir: 1, departAt: T0 + 8 * MIN, dest: 'E10' }),
    g3: makeTrain({ id: 'G3', line: 'GR', track: 1, from: 'F04', dir: 1, departAt: T0 + 14 * MIN, dest: 'E10' }),
    r1: makeTrain({ id: 'R1', line: 'RD', track: 1, from: 'B01', dir: -1, departAt: a1, dest: 'A15' }),
    r2: makeTrain({ id: 'R2', line: 'RD', track: 1, from: 'B01', dir: -1, departAt: a1 + 3 * MIN, dest: 'A15' }),
    rx: makeTrain({ id: 'RX', line: 'RD', track: 1, from: 'B01', dir: 1, departAt: a1 + 4 * MIN, dest: 'B11' }),
    r3: makeTrain({ id: 'R3', line: 'RD', track: 1, from: 'B01', dir: -1, departAt: a1 + 9 * MIN, dest: 'A15' }),
    r4: makeTrain({ id: 'R4', line: 'RD', track: 1, from: 'B01', dir: -1, departAt: a1 + 15 * MIN, dest: 'A15' }),
  };
}

function eveningRide() {
  const ride = newRide({
    key: rideKey('2026-10-21', 'pm'),
    leg: 'pm',
    localDate: '2026-10-21',
    timeZone: TZ,
    fenceAt: new Date(T0).toISOString(),
    now: new Date(T0),
    gpsFrom: new Date(T0),
    gpsUntil: new Date(T0),
  });
  return withLaunch(ride, { ok: true, operation: 'op', now: new Date(T0 + 1000) });
}

// Underground the phone reports a wide radius; on the surface past Grosvenor, R3's track.
// The two tight fixes on R2 come before the GPS window and must not count.
function eveningFixes(t) {
  const surfaced = t.r3.arrivalAt('A11') + 30_000;
  const early = fixesAlong(t.r2, [t.r2.departAt + 5 * MIN, t.r2.departAt + 5 * MIN + 30_000]);
  const underground = fixesAlong(t.r3, [surfaced - 120_000, surfaced - 60_000], { accuracy: 300, speedKmh: 0 });
  return [
    ...early,
    ...underground,
    ...fixesAlong(
      t.r3,
      Array.from({ length: 8 }, (_, i) => surfaced + 20_000 * (i + 1)),
      { speedKmh: 0 },
    ),
  ];
}

test('an evening ride: both Green candidates alert by name, Red candidates follow the transfer gap, GPS past Grosvenor locks one', async () => {
  const t = eveningTrains();
  const live = world({ trains: Object.values(t), fixes: eveningFixes(t), ride: eveningRide() });
  live.deps.config = pmConfig;
  // Long enough that R4 reaches Rockville while the ride is still running, so the lock is what keeps it quiet.
  live.deps.endAfterMs = 15 * MIN;
  const result = await runRide(live.deps);
  assert.deepEqual(result, { reason: 'done', exitCode: 0 });
  const ride = live.ride;

  assert.deepEqual(ride.tracking.boarding, ['G1', 'G2'], 'the wrong-way train and the third train are not candidates');
  assert.deepEqual(ride.tracking.picks, [
    ['R2', 'R3'],
    ['R3', 'R4'],
  ]);
  assert.deepEqual(ride.tracking.candidates, ['R2', 'R3', 'R4'], 'R1 left inside the transfer gap; RX goes the other way');
  assert.deepEqual(
    ride.alerts.map((a) => [a.key, a.station, a.train_id, a.title]),
    [
      ['leg0:0', 'F02', 'G1', 'alert'],
      ['leg0:1', 'F02', 'G2', 'once'],
      ['leg1:0', 'A14', 'R2', 'alert'],
      ['leg1:1', 'A14', 'R3', 'alert'],
    ],
    'R4 is narrowed away once R3 locks',
  );
  assert.deepEqual(
    ride.alerts.slice(0, 2).map((a) => a.text),
    [
      `Next stop Gallery Place. Transfer to Red. You're on the ${clockAt(t.g1.departAt, TZ)} from Waterfront.`,
      `Next stop Gallery Place. Transfer to Red. You're on the ${clockAt(t.g2.departAt, TZ)} from Waterfront.`,
    ],
  );
  assert.equal(ride.alerts[3].text, `Next stop Shady Grove. You're on the ${clockAt(t.r3.departAt, TZ)} from Gallery Place.`);

  // The GPS window opens when the leading Red candidate leaves Grosvenor, and the lock comes from surface fixes.
  const gpsAt = Date.parse(ride.tracking.gps_from);
  assert.ok(gpsAt >= t.r2.arrivalAt('A11') && gpsAt < t.r2.arrivalAt('A12'));
  assert.equal(Date.parse(ride.tracking.gps_until) - gpsAt, 10 * MIN);
  assert.equal(ride.lock.train_id, 'R3');
  assert.ok(Date.parse(ride.lock.at) > t.r3.arrivalAt('A11') && Date.parse(ride.lock.at) < t.r3.arrivalAt('A14'));
  assert.deepEqual(
    statuses(live).map((p) => [p.priority, text(p)]),
    [
      ['3', 'Sending GPS fixes to find your train.'],
      ['3', `Tracking the ${clockAt(t.r3.departAt, TZ)} from Gallery Place`],
    ],
  );
  assert.deepEqual(
    alerts(live).map((p) => [p.title, p.priority]),
    [
      ['Ride alert', '5'],
      ['Ride', '5'],
      ['Ride alert', '5'],
      ['Ride alert', '5'],
    ],
  );
  for (const p of alerts(live)) assert.match(p.actions, /ride\/cancel\?leg=pm&reason=off&token=/);
  assert.ok(alerts(live)[0].at < t.g1.arrivalAt('F01') && alerts(live)[3].at < t.r3.arrivalAt('A15'), 'each alert lands before the stop');
  assert.equal(live.rows.length, 1);
  assert.equal(live.rows[0].ended.reason, 'done');
});

test('an evening lock on the leading Red train quiets the others and ends the ride after its alert', async () => {
  const t = eveningTrains();
  const surfaced = t.r2.arrivalAt('A11') + 30_000;
  const fixes = fixesAlong(
    t.r2,
    Array.from({ length: 6 }, (_, i) => surfaced + 20_000 * (i + 1)),
    { speedKmh: 0 },
  );
  const w = world({ trains: Object.values(t), fixes, ride: eveningRide() });
  w.deps.config = pmConfig;
  assert.deepEqual(await runRide(w.deps), { reason: 'done', exitCode: 0 });
  assert.equal(w.ride.lock.train_id, 'R2');
  assert.deepEqual(
    w.ride.alerts.map((a) => [a.key, a.train_id, a.title]),
    [
      ['leg0:0', 'G1', 'alert'],
      ['leg0:1', 'G2', 'once'],
      ['leg1:0', 'R2', 'alert'],
    ],
  );
  assert.ok(Date.parse(w.ride.ended.at) < t.r3.arrivalAt('A14'), 'no wait for the trains it narrowed away');
});

test('an evening ride with no fix that matches still alerts every Red candidate', async () => {
  const t = eveningTrains();
  const poor = eveningFixes(t).map((f) => ({ ...f, accuracy_m: 120 }));
  const w = world({ trains: Object.values(t), fixes: poor, ride: eveningRide() });
  w.deps.config = pmConfig;
  const result = await runRide(w.deps);
  assert.deepEqual(result, { reason: 'done', exitCode: 0 });
  assert.equal(w.ride.lock, null);
  assert.deepEqual(
    w.ride.alerts.map((a) => [a.key, a.train_id, a.title]),
    [
      ['leg0:0', 'G1', 'alert'],
      ['leg0:1', 'G2', 'once'],
      ['leg1:0', 'R2', 'alert'],
      ['leg1:1', 'R3', 'once'],
      ['leg1:2', 'R4', 'once'],
    ],
  );
  assert.deepEqual(
    w.ride.statuses.map((s) => s.key),
    ['gps'],
  );
  assert.equal(w.rows[0].ended.reason, 'done');
});

test('an evening ride whose Green candidates all leave the feed before their alert ends lost, loudly', async () => {
  const t = eveningTrains();
  t.g1 = makeTrain({ id: 'G1', line: 'GR', track: 1, from: 'F04', dir: 1, departAt: T0 + 2 * MIN, dest: 'E10', vanishAt: T0 + 3 * MIN });
  t.g2 = makeTrain({ id: 'G2', line: 'GR', track: 1, from: 'F04', dir: 1, departAt: T0 + 8 * MIN, dest: 'E10', vanishAt: T0 + 9 * MIN });
  const w = world({ trains: Object.values(t), ride: eveningRide() });
  w.deps.config = pmConfig;
  assert.deepEqual(await runRide(w.deps), { reason: 'lost', exitCode: 0 });
  assert.deepEqual(w.ride.alerts, []);
  assert.deepEqual(
    w.pushes.map((p) => [p.title, p.priority, text(p)]),
    [['Ride status', '5', NOT_TRACKING]],
  );
});

test('bootstrap and config failures are loud and exit 1; an ended or missing ride is left alone', async () => {
  const down = world({ failRoutes: true });
  assert.deepEqual(await runRide(down.deps), { reason: 'feed', exitCode: 1 });
  assert.deepEqual(
    down.pushes.map((p) => [p.title, p.priority, text(p)]),
    [['Ride status', '5', NOT_TRACKING]],
  );
  assert.deepEqual(down.intervals, [5000, 5000]);
  assert.equal(down.ride.ended.reason, 'feed');

  const noCodes = world();
  noCodes.deps.config = { ...config, ride: { ...config.ride, am: { legs: [{ ...red, board_code: null }, green] } } };
  assert.deepEqual(await runRide(noCodes.deps), { reason: 'config', exitCode: 1 });
  assert.equal(noCodes.ride.ended.reason, 'config');
  assert.equal(noCodes.pushes.length, 1);

  const over = world({ ride: { ...freshRide(), status: 'ended', ended: { reason: 'done', at: 'x' } } });
  assert.deepEqual(await runRide(over.deps), { reason: 'done', exitCode: 0 });
  assert.deepEqual(over.pushes, []);
  assert.equal(over.rows.length, 0);

  const missing = world();
  missing.deps.key = 'rides/2026-10-22-am.json';
  assert.deepEqual(await runRide(missing.deps), { reason: 'no-ride', exitCode: 1 });
});

test('recordCrash marks the ride ended as crash, pushes once, writes the row, and is a no-op on an ended ride', async () => {
  const w = world();
  await recordCrash({ ...w.deps });
  assert.equal(w.ride.ended.reason, 'crash');
  assert.deepEqual(
    w.ride.statuses.map((s) => s.key),
    ['crash'],
  );
  assert.deepEqual(
    w.pushes.map((p) => [p.title, p.priority, text(p)]),
    [['Ride status', '5', NOT_TRACKING]],
  );
  assert.equal(w.rows.length, 1);
  await recordCrash({ ...w.deps });
  assert.equal(w.pushes.length, 1);
  await recordCrash({ ...w.deps, tokenProvider: async () => null });
  await recordCrash({
    ...w.deps,
    store: {
      updateRide: async () => {
        throw new Error('gcs down');
      },
    },
  });
});

test('jobEnv names the first missing variable and defaults the config path', () => {
  assert.deepEqual(jobEnv({}), { ok: false, error: 'RIDE_KEY is not set' });
  assert.deepEqual(jobEnv({ RIDE_KEY: 'k', RIDE_BUCKET: 'b' }), { ok: false, error: 'RIDE_NTFY_TOPIC is not set' });
  assert.deepEqual(jobEnv({ RIDE_KEY: 'k', RIDE_BUCKET: 'b', RIDE_NTFY_TOPIC: 't', RIDE_SERVICE_URL: 'u' }), {
    ok: false,
    error: 'TRANSIT_API_KEY is not set',
  });
  assert.deepEqual(jobEnv({ RIDE_KEY: ' k ', RIDE_BUCKET: 'b', RIDE_NTFY_TOPIC: 't', RIDE_SERVICE_URL: 'u', TRANSIT_API_KEY: 'a' }), {
    ok: true,
    key: 'k',
    bucket: 'b',
    topic: 't',
    serviceUrl: 'u',
    apiKey: 'a',
    configPath: 'config.toml',
  });
  assert.equal(
    jobEnv({ RIDE_KEY: 'k', RIDE_BUCKET: 'b', RIDE_NTFY_TOPIC: 't', RIDE_SERVICE_URL: 'u', TRANSIT_API_KEY: 'a', SWITCHTENDER_CONFIG: '/x.toml' }).configPath,
    '/x.toml',
  );
});

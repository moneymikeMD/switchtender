// Tests for the HTTP entry point (src/server.js). No network beyond loopback:
// the pipeline is injected, so nothing here talks to a feed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { createServer, keyMatches, KEY_HEADER } from '../src/server.js';
import { RouteError } from '../src/routes.js';
import * as rideState from '../src/ride/state.js';

const SECRET = 'correct-horse-battery-staple';
const config = { route: {}, decision: {}, secrets: { keys: {}, degraded: [] }, log: { enabled: false } };
const verdict = { choice: 'transit', confidence: 0.7, reasons: ['test'] };

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function start({ run, logger = () => {}, timeoutMs, push, recordArrival } = {}) {
  const lines = [];
  const server = createServer({
    config,
    secret: SECRET,
    run: run ?? (async () => ({ verdict, spoken: 'Take the train.' })),
    now: () => new Date('2026-09-16T12:00:00Z'),
    timeoutMs,
    push,
    recordArrival,
    logger: (line) => {
      lines.push(line);
      logger(line);
    },
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, lines };
}

test('the server refuses to build without a secret', () => {
  assert.throws(() => createServer({ config, secret: '' }), /SWITCHTENDER_SHARED_SECRET/);
  assert.throws(() => createServer({ config, secret: undefined }), /SWITCHTENDER_SHARED_SECRET/);
});

test('/health answers 200 without a key', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('/verdict without a key is 401 with an empty body', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/verdict`);
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('/verdict with a wrong key of the same length is 401', async () => {
  const { base } = await start();
  const wrong = 'x'.repeat(SECRET.length);
  assert.equal(wrong.length, SECRET.length);
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: wrong } });
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('/verdict with the right key returns the spoken line, the verdict and a timestamp', async () => {
  const { base, lines } = await start();
  const res = await fetch(`${base}/verdict`, { headers: { 'X-Switchtender-Key': SECRET } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.deepEqual(body, { spoken: 'Take the train.', verdict, computedAt: '2026-09-16T12:00:00.000Z', logged: null, notified: null });
  // One line per request, status and duration, never the key.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^GET \/verdict 200 \d+ms$/);
  assert.ok(!lines[0].includes(SECRET));
});

test('?notify=1 is ignored without a key: no push, plain 401', async () => {
  const { base } = await start({
    push: async () => {
      throw new Error('should not be reached before the key check');
    },
  });
  const res = await fetch(`${base}/verdict?notify=1`);
  assert.equal(res.status, 401);
});

test('without ?notify=1 nothing is pushed and notified is null', async () => {
  const { base } = await start({
    push: async () => {
      throw new Error('should not be called');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  const body = await res.json();
  assert.equal(body.notified, null);
});

test('?notify=1 pushes the choice and the spoken line after the run, every time (CMB-83)', async () => {
  const calls = [];
  const { base } = await start({
    push: async (args) => {
      calls.push(args);
      return { ok: true, sent: true, error: null };
    },
  });
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${base}/verdict?notify=1`, { headers: { [KEY_HEADER]: SECRET } });
    assert.deepEqual((await res.json()).notified, { ok: true, sent: true, error: null });
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].choice, verdict.choice);
  assert.equal(calls[0].spoken, 'Take the train.');
  assert.equal('previousChoice' in calls[0], false);
});

test('a failed push is logged but does not fail the request', async () => {
  const logged = [];
  const { base } = await start({ push: async () => ({ ok: false, sent: false, error: 'ntfy 500' }), logger: (line) => logged.push(line) });
  const res = await fetch(`${base}/verdict?notify=1`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.ok(logged.some((line) => line.includes('notify failed: ntfy 500')));
});

test('a RouteError from the pipeline is 503 and says only that the lookup failed', async () => {
  const { base } = await start({
    run: async () => {
      throw new RouteError('Routes API HTTP 500');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'lookup failed' });
});

test('a pipeline that outlives the timeout is 504', async () => {
  const { base } = await start({ run: () => new Promise(() => {}), timeoutMs: 50 });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'lookup timed out' });
});

test('unknown paths are 404 and non-GET on /verdict is 405, both before the key check', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/`)).status, 404);
  // No key sent: a 401 here would mean the key check ran first.
  assert.equal((await fetch(`${base}/verdict`, { method: 'POST' })).status, 405);
});

// Send a raw request line the HTTP parser accepts but the URL parser rejects.
function rawRequest(base, target) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('a request target the URL parser rejects is a 400, not a crashed instance', async () => {
  const { base, lines } = await start();
  for (const target of ['//[::1/verdict', 'http://[', 'http://[::1']) {
    const response = await rawRequest(base, target);
    assert.match(response, /^HTTP\/1\.1 400 /, target);
  }
  // The server is still up and still answering.
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.ok(
    lines.every((l) => !l.includes('error')),
    lines.join('\n'),
  );
});

test('a failed sheet write is logged by name and returned in the body; a good one is silent', async () => {
  const failed = await start({
    run: async () => ({ verdict, spoken: 'Take the train.', logged: { ok: false, error: 'sheets 403: The caller does not have permission' } }),
  });
  const res = await fetch(`${failed.base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).logged, { ok: false, error: 'sheets 403: The caller does not have permission' });
  assert.ok(
    failed.lines.some((l) => l === 'log failed: sheets 403: The caller does not have permission'),
    failed.lines.join('\n'),
  );

  const fine = await start({ run: async () => ({ verdict, spoken: 'Take the train.', logged: { ok: true, error: null } }) });
  await fetch(`${fine.base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.ok(!fine.lines.some((l) => l.startsWith('log failed')));
});

test('a pipeline that throws something other than a RouteError is a 500 with the message logged, not a crash', async () => {
  const { base, lines } = await start({
    run: async () => {
      throw new RangeError('Invalid time zone specified: America/Boston');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 500);
  assert.ok(lines.some((l) => l.includes('Invalid time zone')));
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('keyMatches is constant-length and never throws on mismatched lengths', () => {
  assert.equal(keyMatches(SECRET, SECRET), true);
  assert.doesNotThrow(() => keyMatches('short', SECRET));
  assert.equal(keyMatches('short', SECRET), false);
  assert.equal(keyMatches(`${SECRET}x`, SECRET), false);
  assert.equal(keyMatches('', SECRET), false);
  assert.equal(keyMatches(undefined, SECRET), false);
  assert.equal(keyMatches(SECRET, ''), false);
  assert.equal(keyMatches(['a', 'b'], SECRET), false, 'a repeated header arrives as an array');
});

test('?from=origin reaches the pipeline; anything else but fork is a 400 after the key check (CMB-30)', async () => {
  const calls = [];
  const { base } = await start({
    run: async (_config, opts) => {
      calls.push(opts.from);
      return { verdict, spoken: 'Take the train.' };
    },
  });
  const headers = { [KEY_HEADER]: SECRET };

  assert.equal((await fetch(`${base}/verdict`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?from=fork`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?from=origin`, { headers })).status, 200);
  assert.deepEqual(calls, ['fork', 'fork', 'origin']);

  const bad = await fetch(`${base}/verdict?from=garage`, { headers });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /fork, origin/);
  assert.equal(calls.length, 3);

  // Unauthenticated: 401, not 400. The parameter is not validated for strangers.
  assert.equal((await fetch(`${base}/verdict?from=garage`)).status, 401);
});

test('?trigger= reaches the pipeline, absent is null, and an unknown value is a 400 after the key check (CMB-81)', async () => {
  const calls = [];
  const { base } = await start({
    run: async (_config, opts) => {
      calls.push(opts.trigger);
      return { verdict, spoken: 'Take the train.' };
    },
  });
  const headers = { [KEY_HEADER]: SECRET };

  assert.equal((await fetch(`${base}/verdict`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?trigger=poll`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?notify=1&trigger=schedule`, { headers })).status, 200);
  assert.deepEqual(calls, [null, 'poll', 'schedule']);

  const bad = await fetch(`${base}/verdict?trigger=cron`, { headers });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /phone, schedule, poll/);
  assert.equal(calls.length, 3);

  assert.equal((await fetch(`${base}/verdict?trigger=cron`)).status, 401);
});

test('?direction=outbound reaches the pipeline and answers with no spoken line; notify is refused on it (CMB-82)', async () => {
  const calls = [];
  const { base } = await start({
    run: async (_config, opts) => {
      calls.push(opts.direction);
      return { verdict, spoken: opts.direction === 'outbound' ? null : 'Take the train.' };
    },
  });
  const headers = { [KEY_HEADER]: SECRET };

  assert.equal((await fetch(`${base}/verdict`, { headers })).status, 200);
  const home = await fetch(`${base}/verdict?direction=outbound&trigger=poll`, { headers });
  assert.equal(home.status, 200);
  assert.equal((await home.json()).spoken, null);
  assert.deepEqual(calls, ['inbound', 'outbound']);

  const bad = await fetch(`${base}/verdict?direction=sideways`, { headers });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /inbound, outbound/);
  assert.equal((await fetch(`${base}/verdict?direction=outbound&notify=1`, { headers })).status, 400);
  assert.equal(calls.length, 2);

  assert.equal((await fetch(`${base}/verdict?direction=sideways`)).status, 401);
});

// /arrived (CMB-41): the phone reports reaching the lot or the office door, so
// a verdict row can be scored against what the trip actually took.

const arrivedOk = async () => ({ ok: true, duplicate: false, verdictAt: '2026-09-16T08:30:00-04:00', error: null });

test('/arrived needs the key, the POST method and a place it knows', async () => {
  const { base } = await start({ recordArrival: arrivedOk });
  const unauthenticated = await fetch(`${base}/arrived?place=office`, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(await unauthenticated.text(), '');

  const wrongMethod = await fetch(`${base}/arrived?place=office`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(wrongMethod.status, 405);

  const noPlace = await fetch(`${base}/arrived`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(noPlace.status, 400);
  assert.match((await noPlace.json()).error, /place must be one of park, office/);

  const strangePlace = await fetch(`${base}/arrived?place=moon`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(strangePlace.status, 400);
});

test('/arrived records the arrival and names the verdict it belongs to', async () => {
  const seen = [];
  const { base } = await start({
    recordArrival: async (args) => {
      seen.push(args);
      return arrivedOk();
    },
  });
  const res = await fetch(`${base}/arrived?place=park`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    recorded: true,
    duplicate: false,
    place: 'park',
    took: null,
    at: '2026-09-16T12:00:00.000Z',
    verdictAt: '2026-09-16T08:30:00-04:00',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].place, 'park');
  assert.equal(seen[0].now.toISOString(), '2026-09-16T12:00:00.000Z');
});

test('/arrived takes the arrival time from the caller when it is given, and refuses nonsense', async () => {
  const seen = [];
  const { base } = await start({
    recordArrival: async (args) => {
      seen.push(args.now.toISOString());
      return arrivedOk();
    },
  });
  const res = await fetch(`${base}/arrived?place=office&at=2026-09-16T09:59:00-04:00`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).at, '2026-09-16T13:59:00.000Z');
  assert.deepEqual(seen, ['2026-09-16T13:59:00.000Z']);

  const bad = await fetch(`${base}/arrived?place=office&at=tuesday`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(bad.status, 400);
});

test('a second arrival for the same place is reported, not recorded twice', async () => {
  const { base } = await start({ recordArrival: async () => ({ ok: true, duplicate: true, verdictAt: null, error: null }) });
  const res = await fetch(`${base}/arrived?place=office`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.recorded, false);
});

test('a failed or stalled sheet write still answers the phone, and says so in the log', async () => {
  const failed = await start({ recordArrival: async () => ({ ok: false, duplicate: false, verdictAt: null, error: 'sheets 503: nope' }) });
  const res = await fetch(`${failed.base}/arrived?place=office`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).recorded, false);
  assert.ok(failed.lines.some((l) => l.includes('arrival log failed: sheets 503')));

  const stalled = await start({ timeoutMs: 10, recordArrival: () => new Promise(() => {}) });
  const slow = await fetch(`${stalled.base}/arrived?place=park`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(slow.status, 200);
  assert.equal((await slow.json()).recorded, false);
});

test('/arrived carries what was actually done, and refuses a mode it does not know', async () => {
  const seen = [];
  const { base } = await start({
    recordArrival: async (args) => {
      seen.push(args.took);
      return arrivedOk();
    },
  });
  const took = await fetch(`${base}/arrived?place=office&took=transit`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(took.status, 200);
  assert.equal((await took.json()).took, 'transit');

  // Absent stays null. The verdict's own advice is not evidence it was
  // followed, so nothing fills this in on the caller's behalf (CMB-41).
  const quiet = await fetch(`${base}/arrived?place=office`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal((await quiet.json()).took, null);
  assert.deepEqual(seen, ['transit', null]);

  const nonsense = await fetch(`${base}/arrived?place=office&took=helicopter`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(nonsense.status, 400);
  assert.match((await nonsense.json()).error, /took must be one of drive, transit/);
  assert.equal(seen.length, 2);
});

// /ride/* (CMB-151): the phone starts a ride from a fence, feeds it fixes and
// cancels it; the ride itself lives in a GCS object and a Cloud Run Job.

const rideConfig = {
  ...config,
  route: { timezone: 'America/New_York', park_and_ride: { addl_walk_mins: 5 } },
  ride: {
    sheet_tab: 'rides',
    am: { start: '05:30', end: '10:00', gps_window_mins: 25, legs: [] },
    pm: { start: '16:30', end: '22:30', gps_window_mins: 5, legs: [] },
  },
};
const rideEnv = { RIDE_BUCKET: 'rides-bucket', RIDE_JOB_PROJECT: 'proj', RIDE_JOB_REGION: 'us-east4', RIDE_JOB_NAME: 'switchtender-ride' };
// Wednesday 2026-10-21 07:15 EDT: inside the morning window.
const FENCE = new Date('2026-10-21T11:15:00Z');
const headers = { [KEY_HEADER]: SECRET, 'Content-Type': 'application/json' };

// An in-memory stand-in for the GCS object: the same claim-or-exists and
// generation semantics, no network.
function memoryStore(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { ride: v, generation: 1 }]));
  const calls = [];
  return {
    objects,
    calls,
    ...rideState,
    async claimRide({ ride }) {
      calls.push(`claim ${ride.key}`);
      if (objects.has(ride.key)) return { claimed: false, generation: null };
      objects.set(ride.key, { ride, generation: 1 });
      return { claimed: true, generation: '1' };
    },
    async readRide({ key }) {
      calls.push(`read ${key}`);
      const o = objects.get(key);
      return o ? { ride: structuredClone(o.ride), generation: String(o.generation) } : null;
    },
    async updateRide({ key, mutate }) {
      calls.push(`update ${key}`);
      const o = objects.get(key);
      if (!o) return null;
      const next = mutate(structuredClone(o.ride));
      if (next === null) return { ride: o.ride, generation: String(o.generation), updated: false };
      o.ride = next;
      o.generation += 1;
      return { ride: next, generation: String(o.generation), updated: true };
    },
  };
}

async function startRide({
  store = memoryStore(),
  launch,
  env = rideEnv,
  now = () => FENCE,
  tokenProvider = async () => 'tok',
  config: cfg = rideConfig,
  logger,
} = {}) {
  const launches = [];
  const server = createServer({
    config: cfg,
    secret: SECRET,
    run: async () => ({ verdict, spoken: 'x' }),
    now,
    store,
    env,
    tokenProvider,
    logger: logger ?? (() => {}),
    launch:
      launch ??
      (async (args) => {
        launches.push(args);
        return { ok: true, operation: 'projects/proj/locations/us-east4/operations/op-1', error: null };
      }),
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, store, launches };
}

test('/ride/* needs POST, the key, and a leg it knows, in that order', async () => {
  const { base } = await startRide();
  for (const action of ['start', 'fix', 'cancel']) {
    assert.equal((await fetch(`${base}/ride/${action}?leg=am`)).status, 405, action);
    const unauthenticated = await fetch(`${base}/ride/${action}?leg=am`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401, action);
    assert.equal(await unauthenticated.text(), '');
    const noLeg = await fetch(`${base}/ride/${action}`, { method: 'POST', headers });
    assert.equal(noLeg.status, 400, action);
    assert.match((await noLeg.json()).error, /leg must be one of am, pm/);
  }
  assert.equal((await fetch(`${base}/ride/other?leg=am`, { method: 'POST', headers })).status, 404);
});

test('/ride/start without [ride] or without the bucket and Job in the environment is a 503 that says which', async () => {
  const bare = await startRide({ config: { ...rideConfig, ride: null } });
  const noBlock = await fetch(`${bare.base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(noBlock.status, 503);
  assert.match((await noBlock.json()).error, /no \[ride\] block/);

  const noEnv = await startRide({ env: {} });
  const res = await fetch(`${noEnv.base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'ride not configured: RIDE_BUCKET is not set' });
  assert.deepEqual(noEnv.store.calls, []);

  const noProject = await startRide({ env: { RIDE_BUCKET: 'b' } });
  assert.match((await (await fetch(`${noProject.base}/ride/start?leg=am`, { method: 'POST', headers })).json()).error, /RIDE_JOB_PROJECT is not set/);

  const noToken = await startRide({ tokenProvider: async () => null });
  const unauth = await fetch(`${noToken.base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(unauth.status, 503);
  assert.deepEqual(await unauth.json(), { error: 'no credentials' });
});

test('/ride/start claims the day object, launches the Job with the ride key, and tells the phone its GPS window', async () => {
  const { base, store, launches } = await startRide();
  const res = await fetch(`${base}/ride/start?leg=am&at=2026-10-21T07:14:30-04:00`, { method: 'POST', headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    started: true,
    leg: 'am',
    ride: 'rides/2026-10-21-am.json',
    status: 'launched',
    local_date: '2026-10-21',
    operation: 'projects/proj/locations/us-east4/operations/op-1',
    // fence 07:14:30 + 5 min walk, then 25 min.
    gps_from: '2026-10-21T11:19:30.000Z',
    gps_until: '2026-10-21T11:44:30.000Z',
    gps_from_epoch: 1792581570,
    gps_until_epoch: 1792583070,
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].rideKey, 'rides/2026-10-21-am.json');
  assert.deepEqual(launches[0].env, { ok: true, bucket: 'rides-bucket', project: 'proj', region: 'us-east4', job: 'switchtender-ride' });
  assert.equal(launches[0].token, 'tok');
  const stored = store.objects.get('rides/2026-10-21-am.json').ride;
  assert.equal(stored.status, 'launched');
  assert.equal(stored.fence_at, '2026-10-21T11:14:30.000Z');
  assert.equal(stored.launch.operation, 'projects/proj/locations/us-east4/operations/op-1');
  assert.deepEqual(store.calls, ['claim rides/2026-10-21-am.json', 'update rides/2026-10-21-am.json']);
});

test('a second start on the same leg and day is "already running", with no second launch', async () => {
  const { base, launches } = await startRide();
  assert.equal((await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers })).status, 200);
  const again = await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.started, false);
  assert.equal(body.reason, 'already running');
  assert.equal(body.status, 'launched');
  assert.equal(body.ride, 'rides/2026-10-21-am.json');
  assert.equal(body.gps_until, '2026-10-21T11:45:00.000Z');
  assert.equal(launches.length, 1);
});

test('a start outside the window or on a weekend is refused with 200 and a reason; a stale or absurd at is a 400', async () => {
  const { base, launches, store } = await startRide({ now: () => new Date('2026-10-21T15:00:30Z') });
  // 11:00:30 EDT, after the morning window closed.
  const late = await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(late.status, 200);
  assert.deepEqual(await late.json(), { started: false, reason: '11:00 is outside the am window 05:30-10:00', leg: 'am', local_date: '2026-10-21' });

  const stale = await fetch(`${base}/ride/start?leg=am&at=2026-10-21T10:55:00Z`, { method: 'POST', headers });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /at is stale/);
  const future = await fetch(`${base}/ride/start?leg=am&at=2026-10-21T15:05:00Z`, { method: 'POST', headers });
  assert.equal(future.status, 400);
  const garbage = await fetch(`${base}/ride/start?leg=am&at=tuesday`, { method: 'POST', headers });
  assert.equal(garbage.status, 400);
  assert.match((await garbage.json()).error, /ISO 8601/);

  const weekend = await startRide({ now: () => new Date('2026-10-24T11:15:00Z') });
  const sat = await fetch(`${weekend.base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(sat.status, 200);
  assert.match((await sat.json()).reason, /Saturday is not a weekday/);
  assert.equal(launches.length + weekend.launches.length, 0);
  assert.deepEqual(store.calls, []);
});

test('a failed launch marks the ride launch_failed and answers 502; the next start re-claims and launches again', async () => {
  let fail = true;
  const launches = [];
  const lines = [];
  const { base, store } = await startRide({
    logger: (l) => lines.push(l),
    launch: async (args) => {
      launches.push(args);
      return fail ? { ok: false, operation: null, error: 'run 403: Permission denied' } : { ok: true, operation: 'op-2', error: null };
    },
  });
  const first = await fetch(`${base}/ride/start?leg=pm`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  // 07:15 is outside the evening window; use the right leg for the clock.
  assert.equal(first.status, 200);
  assert.equal((await first.json()).started, false);

  const failed = await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    started: false,
    reason: 'launch failed',
    leg: 'am',
    ride: 'rides/2026-10-21-am.json',
    status: 'launch_failed',
    error: 'run 403: Permission denied',
  });
  assert.equal(store.objects.get('rides/2026-10-21-am.json').ride.status, 'launch_failed');
  assert.ok(
    lines.some((l) => l === 'ride launch failed: run 403: Permission denied'),
    lines.join('\n'),
  );

  fail = false;
  const retry = await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers });
  assert.equal(retry.status, 200);
  const body = await retry.json();
  assert.equal(body.started, true);
  assert.equal(body.operation, 'op-2');
  assert.equal(launches.length, 2);
  const stored = store.objects.get('rides/2026-10-21-am.json').ride;
  assert.equal(stored.status, 'launched');
  assert.equal(stored.launch.operation, 'op-2');
});

test('/ride/fix appends a fix from a JSON body or query params, in the units the phone sends, and says whether to stop', async () => {
  const { base, store } = await startRide();
  assert.equal((await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers })).status, 200);

  const fromBody = await fetch(`${base}/ride/fix?leg=am`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lat: 42.3954, lon: -71.1425, acc: 13.5, kmh: 54, at: '2026-10-21T07:21:00-04:00' }),
  });
  assert.equal(fromBody.status, 200);
  assert.deepEqual(await fromBody.json(), {
    recorded: true,
    leg: 'am',
    ride: 'rides/2026-10-21-am.json',
    status: 'launched',
    locked: false,
    cancelled: false,
    ended: false,
    done: false,
    fixes: 1,
  });

  const fromQuery = await fetch(`${base}/ride/fix?leg=am&lat=42.3960&lon=-71.1400&acc=600&kmh=0`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(fromQuery.status, 200);
  assert.equal((await fromQuery.json()).fixes, 2);

  const fixes = store.objects.get('rides/2026-10-21-am.json').ride.fixes;
  assert.deepEqual(fixes[0], {
    at: '2026-10-21T11:21:00.000Z',
    received_at: '2026-10-21T11:15:00.000Z',
    lat: 42.3954,
    lon: -71.1425,
    accuracy_m: 13.5,
    speed_kmh: 54,
    speed_mps: 15,
  });
  // Underground: a "successful" fix with a huge radius and no speed is kept as is.
  assert.deepEqual(fixes[1], {
    at: '2026-10-21T11:15:00.000Z',
    received_at: '2026-10-21T11:15:00.000Z',
    lat: 42.396,
    lon: -71.14,
    accuracy_m: 600,
    speed_kmh: 0,
    speed_mps: 0,
  });

  // Once the Job locks the train the phone is told to stop, and the fix is not stored.
  store.objects.get('rides/2026-10-21-am.json').ride.lock = { method: 'gps', train_id: '123' };
  const afterLock = await fetch(`${base}/ride/fix?leg=am&lat=1&lon=2`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  const locked = await afterLock.json();
  assert.equal(locked.recorded, false);
  assert.equal(locked.locked, true);
  assert.equal(locked.done, true);
  assert.equal(locked.fixes, 2);
});

test('/ride/fix rejects garbage with 400 and answers 404 when there is no ride today', async () => {
  const { base } = await startRide();
  assert.equal((await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers })).status, 200);
  const cases = [
    ['lat=91&lon=0', /lat and lon/],
    ['lat=0&lon=-181', /lat and lon/],
    ['lat=abc&lon=0', /lat and lon/],
    ['lon=0', /lat and lon/],
    ['lat=0&lon=0&acc=-1', /acc and kmh/],
    ['lat=0&lon=0&kmh=fast', /acc and kmh/],
    ['lat=0&lon=0&at=yesterday', /ISO 8601/],
  ];
  for (const [query, message] of cases) {
    const res = await fetch(`${base}/ride/fix?leg=am&${query}`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
    assert.equal(res.status, 400, query);
    assert.match((await res.json()).error, message, query);
  }
  const notJson = await fetch(`${base}/ride/fix?leg=am`, { method: 'POST', headers, body: '[1,2' });
  assert.equal(notJson.status, 400);
  assert.match((await notJson.json()).error, /JSON object/);
  const huge = await fetch(`${base}/ride/fix?leg=am`, { method: 'POST', headers, body: JSON.stringify({ lat: 1, lon: 2, pad: 'x'.repeat(5000) }) }).catch(
    () => null,
  );
  if (huge) assert.equal(huge.status, 400);

  const none = await fetch(`${base}/ride/fix?leg=pm&lat=1&lon=2`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } });
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { error: 'no ride', leg: 'pm', ride: 'rides/2026-10-21-pm.json' });
});

test('/ride/cancel marks the ride with a known reason; the first reason sticks; no ride is a 404', async () => {
  const { base, store } = await startRide();
  assert.equal((await fetch(`${base}/ride/start?leg=am`, { method: 'POST', headers })).status, 200);
  const bad = await fetch(`${base}/ride/cancel?leg=am&reason=bored`, { method: 'POST', headers });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /reason must be one of off, not-riding/);
  assert.equal((await fetch(`${base}/ride/cancel?leg=am`, { method: 'POST', headers })).status, 400);

  const res = await fetch(`${base}/ride/cancel?leg=am&reason=not-riding`, { method: 'POST', headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    cancelled: true,
    reason: 'not-riding',
    leg: 'am',
    ride: 'rides/2026-10-21-am.json',
    status: 'launched',
    locked: false,
    cancelled: true,
    ended: false,
    done: true,
    fixes: 0,
  });
  assert.deepEqual(store.objects.get('rides/2026-10-21-am.json').ride.cancel, { reason: 'not-riding', at: '2026-10-21T11:15:00.000Z' });
  const again = await fetch(`${base}/ride/cancel?leg=am&reason=off`, { method: 'POST', headers });
  assert.equal((await again.json()).reason, 'not-riding');
  // A fix after a cancel is not stored and tells the phone to stop.
  const fix = await fetch(`${base}/ride/fix?leg=am&lat=1&lon=2`, { method: 'POST', headers });
  assert.deepEqual((await fix.json()).recorded, false);

  const none = await fetch(`${base}/ride/cancel?leg=pm&reason=off`, { method: 'POST', headers });
  assert.equal(none.status, 404);
});

test('a GCS failure during a ride call is a 503 that names the store and is logged, never a crash', async () => {
  const lines = [];
  const store = {
    ...memoryStore(),
    claimRide: async () => {
      throw new rideState.RideStoreError('gcs 500: backend error', 500);
    },
    updateRide: async () => {
      throw new rideState.RideStoreError('gcs 500: backend error', 500);
    },
  };
  const { base } = await startRide({ store, logger: (l) => lines.push(l) });
  for (const action of ['start', 'fix?lat=1&lon=2', 'cancel?reason=off']) {
    const sep = action.includes('?') ? '&' : '?';
    const res = await fetch(`${base}/ride/${action}${sep}leg=am`, { method: 'POST', headers });
    assert.equal(res.status, 503, action);
    assert.deepEqual(await res.json(), { error: 'ride store failed' });
  }
  assert.ok(
    lines.some((l) => l.startsWith('ride start failed: gcs 500')),
    lines.join('\n'),
  );
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

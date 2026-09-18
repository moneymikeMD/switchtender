// Tests for the shared pipeline (src/engine.js). No network: routing answers
// from the recorded fixture and every other feed gets an HTTP failure, which
// each feed reports as unknown rather than throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runVerdict, SIGNAL_TIMEOUT_MS, LOG_TIMEOUT_MS } from '../src/engine.js';
import { computeOptions, RouteError } from '../src/routes.js';
import { decide, speak } from '../src/verdict.js';
import { parseConfig } from '../src/config.js';
import { FULL_HEADER } from '../src/log.js';

const fixture = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));
const ROUTES = 'https://routes.googleapis.com/';

function baseConfig({ traffic = false, log = false } = {}) {
  const config = parseConfig(readFileSync('config.example.toml', 'utf8'));
  config.log = { enabled: log, sheet_id: log ? 'sheet-123' : null, sheet_tab: 'verdicts' };
  config.secrets = {
    keys: { ROUTES_API_KEY: 'routes-key', ...(traffic ? { TRAFFIC_API_KEY: 'traffic-key' } : {}) },
    degraded: ['scheduled events', ...(traffic ? [] : ['live incidents'])],
  };
  return config;
}

/** Routes requests answer from the fixture; everything else fails with 503. */
function stubFetch(seen = []) {
  let drives = 0;
  return async (url, init = {}) => {
    seen.push(String(url));
    if (String(url).startsWith(ROUTES)) {
      const body = JSON.parse(init.body);
      let which;
      if (body.travelMode === 'TRANSIT') which = fixture.transit;
      else which = drives++ === 0 ? fixture.driveThrough : fixture.driveToParkAndRide;
      return { ok: true, json: async () => ({ routes: [which] }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
}

test('the engine returns the same verdict decide() gives for the same inputs', async () => {
  const config = baseConfig();
  const now = new Date('2026-09-17T12:00:00Z');
  const result = await runVerdict(config, { fetchImpl: stubFetch(), log: false, now });

  const options = await computeOptions(config, 'routes-key', stubFetch(), { now });
  // No `degraded` list: every optional feed reports its own missing key.
  const expected = decide(options, config.decision, {
    incidents: result.incidents,
    closures: result.closures,
    maryland: result.maryland,
    events: result.events,
    trackwork: result.trackwork,
    now,
    timeZone: config.route.timezone,
  });

  assert.deepEqual(result.verdict, expected);
  assert.equal(result.spoken, speak(expected));
  assert.equal(result.options.driveThrough.totalSeconds, 2700);
  assert.equal(result.options.parkAndRide.totalSeconds, 2400);
  assert.ok(result.spoken.length > 0);
});

test('a failed keyless feed is unknown, never zero, and logging off means logged is null', async () => {
  const result = await runVerdict(baseConfig(), { fetchImpl: stubFetch(), log: false });
  assert.equal(result.closures.active, null);
  assert.equal(result.maryland.onRoute, null);
  assert.equal(result.logged, null);
});

test('incidents are unknown without TRAFFIC_API_KEY, charged once, and fetched with it', async () => {
  const without = [];
  const a = await runVerdict(baseConfig(), { fetchImpl: stubFetch(without), log: false });
  assert.equal(a.incidents.score, null);
  assert.match(a.incidents.reasons[0], /no TRAFFIC_API_KEY/);
  assert.ok(!without.some((u) => u.includes('tomtom')), 'no TomTom call without a key');
  assert.equal(a.verdict.reasons.filter((r) => /live incidents/.test(r)).length, 1, 'one clause, one penalty');
  assert.equal(a.verdict.roadUnstable, null, 'unknown is not steady');

  const withKey = [];
  const b = await runVerdict(baseConfig({ traffic: true }), { fetchImpl: stubFetch(withKey), log: false });
  assert.notEqual(b.incidents, null);
  assert.equal(b.incidents.score, null, 'a failed lookup is unknown');
  assert.ok(
    withKey.some((u) => u.includes('tomtom')),
    'TomTom is called with a key',
  );
});

test('a RouteError propagates to the caller', async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => runVerdict(baseConfig(), { fetchImpl: failing, log: false }), RouteError);
});

test('an enabled log that cannot write reports failure instead of throwing, and never leaves the injected fetch', async () => {
  const seen = [];
  const result = await runVerdict(baseConfig({ log: true }), { fetchImpl: stubFetch(seen), now: new Date('2026-09-16T12:00:00Z') });
  assert.equal(result.logged.ok, false);
  assert.equal(typeof result.logged.error, 'string');
  assert.ok(result.verdict.choice);
  // The token lookup goes through the stub, so the suite never touches the
  // real metadata server (and on a GCE runner would never obtain a real token).
  assert.ok(
    seen.some((u) => u.includes('metadata.google.internal')),
    seen.join('\n'),
  );
});

test('every extra the engine logs has a column, in EXTRA_COLUMNS order, and the walk components sum', async () => {
  const rows = [];
  const inner = stubFetch();
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('metadata.google.internal')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (u.includes('sheets.googleapis.com')) {
      if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ values: [Array.from(FULL_HEADER)] }) };
      rows.push(JSON.parse(init.body).values[0]);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return inner(url, init);
  };
  const config = baseConfig({ log: true });
  config.route.parking = { lat: 42.3522, lon: -71.0629, label: 'garage', addl_walk_mins: 5 };
  const result = await runVerdict(config, { fetchImpl, now: new Date('2026-09-17T12:00:00Z') });
  assert.deepEqual(result.logged, { ok: true, error: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, FULL_HEADER.length);
  const col = (name) => rows[0][FULL_HEADER.indexOf(name)];
  assert.equal(col('drive_walk_seconds'), '300');
  assert.equal(col('transit_walk_seconds'), '0');
  assert.equal(col('measured_from'), 'fork');
  assert.equal(col('incidents_route_matched'), '', 'unknown incidents leave the cell empty');
  assert.equal(col('incidents_unstable'), '');
});

test('a stalled optional feed costs its signal, not the verdict; the deadlines are wired through', async () => {
  const inner = stubFetch();
  let signals = 0;
  const fetchImpl = (url, init = {}) => {
    if (String(url).startsWith(ROUTES)) return inner(url, init);
    signals += 1;
    assert.ok(init.signal instanceof AbortSignal, `${url} carries a deadline`);
    // Hang until the deadline aborts us, like a vendor that never answers.
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const started = Date.now();
  const result = await runVerdict(baseConfig({ traffic: true }), { fetchImpl, log: false, now: new Date('2026-09-17T12:00:00Z'), signalTimeoutMs: 50 });
  assert.ok(Date.now() - started < 2_000, 'the engine did not wait for undici');
  assert.ok(signals >= 4, `incidents, closures, chart and events were all asked (${signals})`);
  assert.ok(result.verdict.choice);
  assert.equal(result.incidents.score, null);
  assert.match(result.incidents.reasons[0], /TimeoutError/);
  assert.equal(result.closures.active, null);
  assert.equal(result.maryland.onRoute, null);
  assert.equal(result.events.unknown, true);
  assert.ok(SIGNAL_TIMEOUT_MS > 0 && LOG_TIMEOUT_MS > 0);
});

test('a stalled sheet write is cut off by its deadline and reported, and a module that throws does not take the process', async () => {
  const inner = stubFetch();
  const fetchImpl = (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(ROUTES)) return inner(url, init);
    if (u.includes('metadata.google.internal')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (u.includes('sheets.googleapis.com')) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return inner(url, init);
  };
  const result = await runVerdict(baseConfig({ log: true }), { fetchImpl, now: new Date('2026-09-17T12:00:00Z'), logTimeoutMs: 50 });
  assert.equal(result.logged.ok, false);
  assert.match(result.logged.error, /TimeoutError/);
  assert.ok(result.verdict.choice);
});

test("a vendor answer that breaks a module is that module's unknown, while routing is still in flight", async () => {
  // A numeric entity outside Unicode used to throw RangeError from the
  // track-work parser before routing had answered, and the rejection was
  // unhandled. The page must simply read as unknown or as itself.
  const config = baseConfig();
  config.transit.lines = ['Red'];
  const routesFetch = stubFetch();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('wmata.com')) {
      const html =
        '<table><tr><th>Start</th><th>End</th><th>Line</th><th>Impact</th></tr><tr><td>Sept. 19</td><td>Sept. 20</td><td>Red</td><td>&#1114112; work</td></tr></table>';
      return { ok: true, status: 200, text: async () => html };
    }
    // Routing answers after the page does.
    await new Promise((r) => setTimeout(r, 20));
    return routesFetch(url, init);
  };
  const result = await runVerdict(config, { fetchImpl, log: false, now: new Date('2026-09-17T12:00:00Z') });
  assert.ok(result.verdict.choice);
  assert.equal(result.trackwork.unknown, false);
  assert.equal(result.trackwork.upcoming, 1);
});

test('from=origin measures both legs from home, times the train off the lot arrival, and says so (CMB-29, CMB-30, CMB-32)', async () => {
  const config = baseConfig();
  const now = new Date('2026-09-17T12:00:00Z');
  const bodies = [];
  const seen = [];
  const inner = stubFetch(seen);
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith(ROUTES)) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  };

  const result = await runVerdict(config, { fetchImpl, log: false, now, from: 'origin' });

  // Both drives start at the origin, not the fork.
  const drives = bodies.filter((b) => b.travelMode === 'DRIVE');
  assert.equal(drives.length, 2);
  for (const b of drives) {
    assert.equal(b.origin.location.latLng.latitude, config.route.origin.lat);
  }
  // The train leaves when the driver is on the platform: 600 s drive + 300 s buffer.
  const transit = bodies.find((b) => b.travelMode === 'TRANSIT');
  assert.equal(transit.departureTime, '2026-09-17T12:15:00.000Z');
  assert.deepEqual(transit.transitPreferences.allowedTravelModes, ['RAIL', 'SUBWAY']);

  assert.equal(result.verdict.measuredFrom, 'origin');
  assert.equal(result.options.startLabel, config.route.origin.label);
  assert.ok(result.spoken.startsWith('Starting from home.'), result.spoken);
  // 12:00Z is 08:00 in the example's zone; transit is 40 min, drive 45.
  assert.equal(result.verdict.transitArrivalClock, '8:40 AM');
  assert.equal(result.verdict.driveArrivalClock, '8:45 AM');
  assert.match(result.spoken, /You would arrive at 8:40 AM\./);
});

test('a separate parking spot routes the drive there and adds the walk to the door (CMB-31)', async () => {
  const config = baseConfig();
  config.route.parking = { lat: 42.3522, lon: -71.0629, label: 'garage', addl_walk_mins: 5 };
  const bodies = [];
  const inner = stubFetch();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith(ROUTES)) bodies.push(JSON.parse(init.body));
    return inner(url, init);
  };

  const result = await runVerdict(config, { fetchImpl, log: false, now: new Date('2026-09-17T12:00:00Z') });

  const [driveThrough] = bodies.filter((b) => b.travelMode === 'DRIVE');
  assert.equal(driveThrough.destination.location.latLng.latitude, 42.3522);
  // The transit leg still ends at the destination door.
  const transit = bodies.find((b) => b.travelMode === 'TRANSIT');
  assert.equal(transit.destination.location.latLng.latitude, config.route.destination.lat);

  assert.equal(result.options.driveThrough.driveSeconds, 2700);
  assert.equal(result.options.driveThrough.walkSeconds, 300);
  assert.equal(result.options.driveThrough.totalSeconds, 3000);
  assert.equal(result.verdict.driveMinutes, 50);
  assert.equal(result.options.parkingLabel, 'garage');
});

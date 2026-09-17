// Tests for the shared pipeline (src/engine.js). No network: routing answers
// from the recorded fixture and every other feed gets an HTTP failure, which
// each feed reports as unknown rather than throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runVerdict } from '../src/engine.js';
import { computeOptions, RouteError } from '../src/routes.js';
import { decide, speak } from '../src/verdict.js';
import { parseConfig } from '../src/config.js';

const fixture = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));
const ROUTES = 'https://routes.googleapis.com/';

function baseConfig({ traffic = false, log = false } = {}) {
  const config = parseConfig(readFileSync('config.example.toml', 'utf8'));
  config.log = { enabled: log, sheet_id: log ? 'sheet-123' : null, sheet_tab: 'verdicts' };
  config.secrets = {
    keys: { ROUTES_API_KEY: 'routes-key', ...(traffic ? { TRAFFIC_API_KEY: 'traffic-key' } : {}) },
    degraded: ['scheduled events', 'rail alerts', ...(traffic ? [] : ['live incidents'])],
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
  const result = await runVerdict(config, { fetchImpl: stubFetch(), log: false });

  const options = await computeOptions(config, 'routes-key', stubFetch());
  const expected = decide(options, config.decision, {
    degraded: config.secrets.degraded,
    incidents: null,
    closures: result.closures,
    maryland: result.maryland,
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

test('incidents run only when TRAFFIC_API_KEY is set', async () => {
  const without = [];
  const a = await runVerdict(baseConfig(), { fetchImpl: stubFetch(without), log: false });
  assert.equal(a.incidents, null);
  assert.ok(!without.some((u) => u.includes('tomtom')), 'no TomTom call without a key');

  const withKey = [];
  const b = await runVerdict(baseConfig({ traffic: true }), { fetchImpl: stubFetch(withKey), log: false });
  assert.notEqual(b.incidents, null);
  assert.equal(b.incidents.score, null, 'a failed lookup is unknown');
  assert.ok(withKey.some((u) => u.includes('tomtom')), 'TomTom is called with a key');
});

test('a RouteError propagates to the caller', async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => runVerdict(baseConfig(), { fetchImpl: failing, log: false }), RouteError);
});

test('an enabled log that cannot write reports failure instead of throwing', async () => {
  const result = await runVerdict(baseConfig({ log: true }), {
    fetchImpl: stubFetch(),
    now: new Date('2026-09-16T12:00:00Z'),
  });
  assert.equal(result.logged.ok, false);
  assert.equal(typeof result.logged.error, 'string');
  assert.ok(result.verdict.choice);
});

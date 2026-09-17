// Tests for the configuration loader.
//
// These run against the committed example, so they also assert that the
// example stays valid. An example config that has drifted out of sync with the
// loader is worse than no example, because the first thing a new reader does
// is copy it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseConfig,
  loadSecrets,
  loadConfig,
  ConfigError,
  SECRETS,
  VENUE_PROVIDERS,
} from '../src/config.js';

const EXAMPLE = 'config.example.toml';
const exampleText = readFileSync(EXAMPLE, 'utf8');
const allKeys = Object.fromEntries(
  Object.keys(SECRETS).map((k) => [k, 'test-value']),
);

test('the committed example parses', () => {
  const c = parseConfig(exampleText);
  assert.equal(typeof c.route.timezone, 'string');
  assert.equal(c.venues.length, 2);
});

test('every place comes back with typed coordinates and a label', () => {
  const c = parseConfig(exampleText);
  for (const name of ['origin', 'decision_point', 'park_and_ride', 'destination']) {
    const p = c.route[name];
    assert.equal(typeof p.lat, 'number', `${name}.lat`);
    assert.equal(typeof p.lon, 'number', `${name}.lon`);
    assert.ok(p.label.length > 0, `${name}.label`);
  }
  assert.equal(typeof c.route.park_and_ride.park_to_platform_minutes, 'number');
});

test('decision thresholds are typed, not strings', () => {
  const c = parseConfig(exampleText);
  assert.equal(typeof c.decision.transit_wins_ties, 'boolean');
  assert.equal(typeof c.decision.minimum_drive_margin_minutes, 'number');
  assert.equal(typeof c.decision.assumed_evening_departure, 'string');
  assert.equal(typeof c.trigger.lead_miles, 'number');
});

test('a missing required key names the key it is missing', () => {
  const broken = exampleText.replace(/^lead_miles.*$/m, '');
  assert.throws(
    () => parseConfig(broken),
    (e) => e instanceof ConfigError && e.message.includes('trigger.lead_miles'),
  );
});

test('a transposed coordinate is rejected rather than routed to', () => {
  // -71 latitude is a valid number and a nonsense place. Without the range
  // check this loads fine and the engine reports a very long drive.
  const swapped = exampleText.replace('lat = 42.4604', 'lat = -171.0');
  assert.throws(
    () => parseConfig(swapped),
    (e) => e instanceof ConfigError && e.message.includes('out of range'),
  );
});

test('an inverted bounding box is rejected', () => {
  const inverted = exampleText.replace('max_lon = -71.0300', 'max_lon = -71.9000');
  assert.throws(
    () => parseConfig(inverted),
    (e) => e instanceof ConfigError && e.message.includes('bounding box'),
  );
});

test('a venue missing a field says which venue and which field', () => {
  const broken = exampleText.replace('weight = 1.0\n\n[[venues]]', '\n[[venues]]');
  assert.throws(
    () => parseConfig(broken),
    (e) => e instanceof ConfigError && e.message.includes('weight'),
  );
});

test('malformed TOML fails as a config error, not a raw parser error', () => {
  assert.throws(
    () => parseConfig('this is not toml = = ='),
    (e) => e instanceof ConfigError && e.message.includes('could not parse'),
  );
});

test('a missing required secret is fatal and explains the cost', () => {
  const { ROUTES_API_KEY, ...rest } = allKeys;
  assert.throws(
    () => loadSecrets(rest),
    (e) => e instanceof ConfigError && e.message.includes('ROUTES_API_KEY'),
  );
});

test('a missing optional secret degrades a named signal instead of failing', () => {
  const { TRAFFIC_API_KEY, ...rest } = allKeys;
  const { keys, degraded } = loadSecrets(rest);
  assert.deepEqual(degraded, ['live incidents']);
  assert.equal(keys.ROUTES_API_KEY, 'test-value');
});

test('with every key present nothing is degraded', () => {
  assert.deepEqual(loadSecrets(allKeys).degraded, []);
});

test('a missing config file reports the path, not a stack trace', () => {
  assert.throws(
    () => loadConfig('does-not-exist.toml', allKeys),
    (e) => e instanceof ConfigError && e.message.includes('ENOENT'),
  );
});

test('the example contains no coordinate from any maintainer commute', () => {
  // The example is a Boston commute on purpose. This test is the tripwire for
  // someone "helpfully" replacing it with their own real values.
  assert.doesNotMatch(exampleText, /39\.4\d{3}|-77\.3\d{3}/);
});

test('[transit] is optional, defaults to no lines, and rejects non-string lines', () => {
  const base = readFileSync('config.example.toml', 'utf8');
  assert.deepEqual(parseConfig(base).transit.lines, []);
  const withLines = base.replace('lines = []', 'lines = ["Red", " Green "]');
  assert.deepEqual(parseConfig(withLines).transit.lines, ['Red', 'Green']);
  const bad = base.replace('lines = []', 'lines = ["Red", 7]');
  assert.throws(() => parseConfig(bad), ConfigError);
});

test('a venue defaults to the ticketing provider; the example ballpark names mlb and its club', () => {
  const c = parseConfig(exampleText);
  const [garden, fenway] = c.venues;
  assert.equal(garden.name, 'TD Garden');
  assert.equal(garden.provider, 'ticketmaster');
  assert.equal(garden.mlb_team_id, null);
  assert.equal(fenway.name, 'Fenway Park');
  assert.equal(fenway.provider, 'mlb');
  assert.equal(fenway.mlb_team_id, 111);
  assert.deepEqual(VENUE_PROVIDERS, ['ticketmaster', 'mlb']);
});

test('provider = "mlb" without a club id is rejected, naming the venue and the key', () => {
  const broken = exampleText.replace(/^mlb_team_id = 111\n/m, '');
  assert.throws(
    () => parseConfig(broken),
    (e) => e instanceof ConfigError && e.message.includes('venues[1]') && e.message.includes('mlb_team_id'),
  );
  // A non-integer id is as useless as none.
  for (const bad of ['mlb_team_id = 111.5', 'mlb_team_id = "111"', 'mlb_team_id = 0']) {
    assert.throws(() => parseConfig(exampleText.replace(/^mlb_team_id = 111$/m, bad)), ConfigError, bad);
  }
});

test('an unknown provider is rejected, and a club id on a ticketing venue is a mistake', () => {
  // Anchored to the line: the comment above the venues mentions the same text.
  assert.throws(
    () => parseConfig(exampleText.replace(/^provider = "mlb"$/m, 'provider = "stubhub"')),
    (e) => e instanceof ConfigError && e.message.includes('stubhub') && e.message.includes('ticketmaster, mlb'),
  );
  assert.throws(
    () => parseConfig(exampleText.replace(/^provider = "mlb"\n/m, '')),
    (e) => e instanceof ConfigError && e.message.includes('only meaningful with provider = "mlb"'),
  );
});

test('[route.parking] is optional; present, it needs a place and a non-negative walk (CMB-31)', () => {
  assert.equal(parseConfig(exampleText).route.parking, null);

  // The example ships the block commented out. Uncommenting it must parse.
  const enabled = exampleText.replace(/^# (\[route\.parking\]|lat = 42\.3522|lon = -71\.0629|label = "Garage.*|walk_to_destination_minutes = 5)$/gm, '$1');
  const parking = parseConfig(enabled).route.parking;
  assert.equal(parking.lat, 42.3522);
  assert.equal(parking.label, 'Garage on the far side of the Common');
  assert.equal(parking.walk_to_destination_minutes, 5);

  assert.throws(
    () => parseConfig(enabled.replace('walk_to_destination_minutes = 5', 'walk_to_destination_minutes = -1')),
    /walk_to_destination_minutes should be zero or more/,
  );
  assert.throws(
    () => parseConfig(enabled.replace('walk_to_destination_minutes = 5\n', '')),
    /missing required key "route.parking.walk_to_destination_minutes"/,
  );
});

// Tests for the configuration loader.
//
// These run against the committed example, so they also assert that the
// example stays valid. An example config that has drifted out of sync with the
// loader is worse than no example, because the first thing a new reader does
// is copy it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseConfig, loadSecrets, loadConfig, ConfigError, SECRETS, VENUE_PROVIDERS } from '../src/config.js';

const EXAMPLE = 'config.example.toml';
const exampleText = readFileSync(EXAMPLE, 'utf8');
const allKeys = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, 'test-value']));

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
  assert.equal(typeof c.route.park_and_ride.addl_walk_mins, 'number');
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

test('a missing rail-alerts key degrades its own signal (CMB-35)', () => {
  const { TRANSIT_API_KEY, ...rest } = allKeys;
  const { keys, degraded } = loadSecrets(rest);
  assert.deepEqual(degraded, ['rail alerts']);
  assert.equal(keys.ROUTES_API_KEY, 'test-value');
});

test('an unknown time zone, a non-finite number, a bad clock time or a negative margin fail at startup, not on the first verdict', () => {
  const at = (from, to) => exampleText.replace(from, to);
  assert.throws(() => parseConfig(at('timezone = "America/New_York"', 'timezone = "America/Boston"')), /not a known IANA time zone/);
  assert.throws(() => parseConfig(at('minimum_drive_margin_minutes = 5', 'minimum_drive_margin_minutes = nan')), /finite number/);
  assert.throws(() => parseConfig(at('minimum_drive_margin_minutes = 5', 'minimum_drive_margin_minutes = inf')), /finite number/);
  assert.throws(() => parseConfig(at('minimum_drive_margin_minutes = 5', 'minimum_drive_margin_minutes = -1')), /zero or more/);
  assert.throws(() => parseConfig(at('assumed_evening_departure = "17:30"', 'assumed_evening_departure = "5pm"')), /24-hour clock time/);
  assert.throws(() => parseConfig(at('assumed_evening_departure = "17:30"', 'assumed_evening_departure = "25:00"')), /24-hour clock time/);
  assert.equal(parseConfig(at('assumed_evening_departure = "17:30"', 'assumed_evening_departure = "5:30"')).decision.assumed_evening_departure, '5:30');
  assert.throws(() => parseConfig(at('lat = 42.3662', 'lat = "42.3662"')), /venues\[0\]\.lat should be a number/);
  assert.throws(() => parseConfig(at('lat = 42.3662', 'lat = 142.0')), /venues\[0\]\.lat 142 is out of range/);
  assert.throws(() => parseConfig(at('weight = 1.0\n\n[[venues]]', 'weight = -1\n\n[[venues]]')), /venues\[0\]\.weight/);
  assert.throws(() => parseConfig(at('name = "TD Garden"', 'name = "  "')), /venues\[0\]\.name/);
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

test('[transit] is optional, defaults to no lines, canonicalises line names, and rejects unknown or non-string lines', () => {
  const base = readFileSync('config.example.toml', 'utf8');
  assert.deepEqual(parseConfig(base).transit.lines, []);
  const withLines = base.replace('lines = []', 'lines = ["Red", " Green "]');
  assert.deepEqual(parseConfig(withLines).transit.lines, ['Red', 'Green']);
  // Any spelling the page would recognise loads as the page's own; a line
  // the page does not know would otherwise report clear forever.
  const spelt = base.replace('lines = []', 'lines = ["red", "RED", "Silver Line", "yellow line"]');
  assert.deepEqual(parseConfig(spelt).transit.lines, ['Red', 'Silver', 'Yellow']);
  assert.throws(() => parseConfig(base.replace('lines = []', 'lines = ["Purple"]')), /"Purple" is not a known line; use one of Red, Orange/);
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

test('every place has one shape: lat, lon, label, addl_walk_mins defaulting to 0 (CMB-33)', () => {
  const c = parseConfig(exampleText);
  for (const name of ['origin', 'decision_point', 'park_and_ride', 'destination']) {
    const p = c.route[name];
    assert.deepEqual(Object.keys(p).sort(), ['addl_walk_mins', 'label', 'lat', 'lon'], name);
    assert.equal(typeof p.addl_walk_mins, 'number');
  }
  assert.equal(c.route.park_and_ride.addl_walk_mins, 5);
  assert.equal(c.route.origin.addl_walk_mins, 0);
  // Left out entirely is 0, not missing.
  const bare = exampleText.replace(/^addl_walk_mins = 0\n/m, '');
  assert.equal(parseConfig(bare).route.origin.addl_walk_mins, 0);
});

test('[route.parking] is optional and takes the same shape; the example block uncomments cleanly (CMB-31, CMB-33)', () => {
  assert.equal(parseConfig(exampleText).route.parking, null);

  const enabled = exampleText.replace(/^# (\[route\.parking\]|lat = 42\.3522|lon = -71\.0629|label = "Garage.*|addl_walk_mins = 5)$/gm, '$1');
  const parking = parseConfig(enabled).route.parking;
  assert.equal(parking.lat, 42.3522);
  assert.equal(parking.label, 'Garage on the far side of the Common');
  assert.equal(parking.addl_walk_mins, 5);
});

test('a walk that is negative or not a number is rejected; the old key names are rejected with the new name', () => {
  assert.throws(
    () => parseConfig(exampleText.replace('addl_walk_mins = 5', 'addl_walk_mins = -1')),
    /route\.park_and_ride\.addl_walk_mins should be a number of zero or more/,
  );
  assert.throws(
    () => parseConfig(exampleText.replace('addl_walk_mins = 5', 'addl_walk_mins = "five"')),
    /route\.park_and_ride\.addl_walk_mins should be a number/,
  );
  assert.throws(
    () => parseConfig(exampleText.replace('addl_walk_mins = 5', 'park_to_platform_minutes = 5')),
    /route\.park_and_ride has unknown key "park_to_platform_minutes" \(renamed to "addl_walk_mins"\)/,
  );
  assert.throws(
    () => parseConfig(exampleText.replace('label = "Boston Common"', 'label = "Boston Common"\nwalk_to_destination_minutes = 5')),
    /route\.destination has unknown key "walk_to_destination_minutes" \(renamed to "addl_walk_mins"\)/,
  );
  assert.throws(
    () => parseConfig(exampleText.replace('label = "Boston Common"', 'label = "Boston Common"\ncolour = "green"')),
    /route\.destination has unknown key "colour"; a place takes lat, lon, label, addl_walk_mins/,
  );
});

test('a ticketing venue may carry its vendor id, and only a ticketing venue may (CMB-42)', () => {
  const withId = exampleText.replace(/^name = "TD Garden"$/m, 'name = "TD Garden"\nticketmaster_venue_id = "  KovZpZA7AAEA  "');
  const [garden] = parseConfig(withId).venues;
  assert.equal(garden.ticketmaster_venue_id, 'KovZpZA7AAEA');
  // Absent is null, never an empty string that would be sent as an id.
  assert.equal(parseConfig(exampleText).venues[0].ticketmaster_venue_id, null);
  for (const bad of ['ticketmaster_venue_id = ""', 'ticketmaster_venue_id = 12', 'ticketmaster_venue_id = "   "']) {
    assert.throws(() => parseConfig(exampleText.replace(/^name = "TD Garden"$/m, `name = "TD Garden"\n${bad}`)), ConfigError, bad);
  }
  // The ballpark reads MLB, so a ticketing id there is a mistake, like
  // mlb_team_id on a ticketing venue.
  assert.throws(
    () => parseConfig(exampleText.replace(/^name = "Fenway Park"$/m, 'name = "Fenway Park"\nticketmaster_venue_id = "KovZpZA7AAEA"')),
    (e) => e instanceof ConfigError && e.message.includes('only meaningful with provider = "ticketmaster"'),
  );
});

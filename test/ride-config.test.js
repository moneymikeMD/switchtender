// Tests for the [ride] block and its window arithmetic (src/ride/config.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseConfig, ConfigError } from '../src/config.js';
import { LEGS, MAX_FENCE_AGE_MS, rideBlock, judgeWindow, gpsWindow } from '../src/ride/config.js';

const exampleText = readFileSync('config.example.toml', 'utf8');
const TZ = 'America/New_York';
const ride = parseConfig(exampleText).ride;

test('the example [ride] block parses with both legs, windows, GPS windows and the rides tab', () => {
  assert.deepEqual(LEGS, ['am', 'pm']);
  assert.equal(ride.sheet_tab, 'rides');
  assert.deepEqual({ start: ride.am.start, end: ride.am.end, gps: ride.am.gps_window_mins }, { start: '05:30', end: '10:00', gps: 25 });
  assert.deepEqual({ start: ride.pm.start, end: ride.pm.end, gps: ride.pm.gps_window_mins }, { start: '16:30', end: '22:30', gps: 5 });
  assert.deepEqual(ride.am.legs, [
    { line: 'Red', board: 'Alewife', alight: 'Park Street' },
    { line: 'Green', board: 'Park Street', alight: 'Boylston' },
  ]);
  assert.equal(ride.pm.legs.length, 2);
});

test('[ride] is optional: absent is null, and a bare block takes every default', () => {
  const stripped = exampleText.replace(/^\[ride\][\s\S]*?(?=^\[log\])/m, '');
  assert.equal(parseConfig(stripped).ride, null);
  assert.equal(rideBlock({}), null);
  const bare = rideBlock({ ride: {} });
  assert.deepEqual(bare, {
    sheet_tab: 'rides',
    am: { start: '05:30', end: '10:00', gps_window_mins: 25, legs: [] },
    pm: { start: '16:30', end: '22:30', gps_window_mins: 5, legs: [] },
  });
});

test('a bad window, a bad GPS window, a bad leg or a clashing tab is a config error that names the key', () => {
  assert.throws(() => rideBlock({ ride: { am: { start: '5pm' } } }), /ride\.am\.start.*24-hour clock/);
  assert.throws(() => rideBlock({ ride: { pm: { start: '23:00', end: '22:30' } } }), /ride\.pm window 23:00-22:30 ends before it starts/);
  assert.throws(() => rideBlock({ ride: { am: { gps_window_mins: -1 } } }), /ride\.am\.gps_window_mins/);
  assert.throws(
    () => rideBlock({ ride: { am: { legs: [{ line: 'Purple', board: 'a', alight: 'b' }] }, pm: {} } }),
    /ride\.am\.legs\[0\]\.line "Purple" is not a known line/,
  );
  assert.throws(() => rideBlock({ ride: { am: { legs: [{ line: 'Red', board: '', alight: 'b' }] } } }), /ride\.am\.legs\[0\]\.board/);
  assert.throws(() => rideBlock({ ride: { am: { legs: 'Red' } } }), /ride\.am\.legs should be an array/);
  assert.throws(() => rideBlock({ ride: 'yes' }), /\[ride\] should be a table/);
  assert.throws(() => rideBlock({ ride: { sheet_tab: '' } }), /ride\.sheet_tab/);
  // Line names canonicalise like [transit] lines.
  assert.equal(rideBlock({ ride: { am: { legs: [{ line: 'red line', board: 'a', alight: 'b' }] } } }).am.legs[0].line, 'Red');
  assert.throws(
    () => parseConfig(exampleText.replace('sheet_tab = "rides"', 'sheet_tab = "arrivals"')),
    (e) => e instanceof ConfigError && /ride\.sheet_tab must differ/.test(e.message),
  );
});

test('a weekday fence inside the window starts; weekends and the edges do not', () => {
  // Wednesday 2026-10-21, EDT (UTC-4).
  assert.deepEqual(judgeWindow({ at: new Date('2026-10-21T07:15:00-04:00'), leg: 'am', ride, timeZone: TZ }), {
    inside: true,
    reason: null,
    localDate: '2026-10-21',
    local: '07:15',
  });
  // Edges: start is inside, end is outside.
  assert.equal(judgeWindow({ at: new Date('2026-10-21T05:30:00-04:00'), leg: 'am', ride, timeZone: TZ }).inside, true);
  assert.equal(judgeWindow({ at: new Date('2026-10-21T05:29:59-04:00'), leg: 'am', ride, timeZone: TZ }).inside, false);
  assert.equal(judgeWindow({ at: new Date('2026-10-21T09:59:59-04:00'), leg: 'am', ride, timeZone: TZ }).inside, true);
  const atEnd = judgeWindow({ at: new Date('2026-10-21T10:00:00-04:00'), leg: 'am', ride, timeZone: TZ });
  assert.equal(atEnd.inside, false);
  assert.match(atEnd.reason, /10:00 is outside the am window 05:30-10:00/);
  // The morning window is not the evening one.
  assert.equal(judgeWindow({ at: new Date('2026-10-21T07:15:00-04:00'), leg: 'pm', ride, timeZone: TZ }).inside, false);
  assert.equal(judgeWindow({ at: new Date('2026-10-21T17:45:00-04:00'), leg: 'pm', ride, timeZone: TZ }).inside, true);
  // Saturday.
  const saturday = judgeWindow({ at: new Date('2026-10-24T07:15:00-04:00'), leg: 'am', ride, timeZone: TZ });
  assert.equal(saturday.inside, false);
  assert.match(saturday.reason, /Saturday is not a weekday/);
});

test('the window is judged on the wall clock across the DST fall-back (2026-11-01)', () => {
  // Sunday 2026-11-01 is the fall-back day: 06:00 EST is 11:00Z. A weekend
  // either way, so refused for the day, not the hour.
  const sunday = judgeWindow({ at: new Date('2026-11-01T11:00:00Z'), leg: 'am', ride, timeZone: TZ });
  assert.equal(sunday.inside, false);
  assert.match(sunday.reason, /Sunday/);
  assert.equal(sunday.local, '06:00');
  // Monday 2026-11-02, the first weekday on EST (UTC-5): 11:00Z is 06:00,
  // inside; on the old offset it would have been 07:00, also inside. The
  // edge tells them apart: 14:59:59Z is 09:59:59 EST (inside) but would have
  // been 10:59:59 EDT (outside).
  assert.equal(judgeWindow({ at: new Date('2026-11-02T11:00:00Z'), leg: 'am', ride, timeZone: TZ }).local, '06:00');
  assert.equal(judgeWindow({ at: new Date('2026-11-02T14:59:59Z'), leg: 'am', ride, timeZone: TZ }).inside, true);
  assert.equal(judgeWindow({ at: new Date('2026-11-02T15:00:00Z'), leg: 'am', ride, timeZone: TZ }).inside, false);
  // Friday before, still EDT: 14:59:59Z is 10:59:59, outside.
  assert.equal(judgeWindow({ at: new Date('2026-10-30T14:59:59Z'), leg: 'am', ride, timeZone: TZ }).inside, false);
  // The local date for the ride key follows the zone, not UTC: 03:00Z on
  // the Monday is still Sunday evening locally.
  assert.equal(judgeWindow({ at: new Date('2026-11-03T03:00:00Z'), leg: 'pm', ride, timeZone: TZ }).localDate, '2026-11-02');
});

test('the GPS window: morning opens after the walk and runs gps_window_mins, evening opens at the fence', () => {
  const at = new Date('2026-10-21T07:15:00-04:00');
  const am = gpsWindow({ at, leg: 'am', ride, walkMins: 5 });
  assert.equal(am.from.toISOString(), '2026-10-21T11:20:00.000Z');
  assert.equal(am.until.toISOString(), '2026-10-21T11:45:00.000Z');
  const pm = gpsWindow({ at, leg: 'pm', ride, walkMins: 5 });
  assert.equal(pm.from.toISOString(), '2026-10-21T11:15:00.000Z');
  assert.equal(pm.until.toISOString(), '2026-10-21T11:20:00.000Z');
  assert.equal(MAX_FENCE_AGE_MS, 120_000);
});

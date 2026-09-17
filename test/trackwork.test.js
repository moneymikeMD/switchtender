// Tests for the planned track-work scrape. No network: every case runs
// against the recorded schedule page, a hand-built table, or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TRACKWORK_URL,
  LINES,
  STALE_REASON,
  STALE_AFTER_MS,
  datesIn,
  linesIn,
  zonedMidnight,
  parseTrackwork,
  relevantWindows,
  assessTrackwork,
  sourceIsStale,
  fetchTrackwork,
} from '../src/trackwork.js';

const page = readFileSync('test/fixtures/wmata-trackwork.html', 'utf8');

// The afternoon the fixture was recorded, Eastern.
const NOW = Date.parse('2026-09-16T12:00:00-04:00');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const et = (iso) => Date.parse(iso);

// A minimal schedule table in the live two-column layout.
function table(rows, header = ['Start', 'End', 'Line', 'Impact']) {
  const th = header.map((h) => `<th scope="col">${h}</th>`).join('');
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<html><body><h1>Planned Track Work</h1><table border="1"><tbody><tr>${th}</tr></tbody><tbody>${body}</tbody></table></body></html>`;
}

// --- the recorded page ----------------------------------------------------

test('parses the recorded page: four windows, Yellow first, Green last', () => {
  const windows = parseTrackwork(page, { now: NOW });
  assert.equal(windows.length, 4);

  const first = windows[0];
  assert.deepEqual(first.lines, ['Yellow']);
  assert.equal(first.startsAt, et('2026-09-19T00:00:00-04:00'));
  assert.equal(first.endsAt, et('2026-09-21T00:00:00-04:00') - 1);
  assert.equal(first.rolledYear, false);
  assert.match(first.description, /No Yellow Line service/);

  const last = windows[3];
  assert.deepEqual(last.lines, ['Green']);
  assert.equal(last.startsAt, et('2026-12-16T00:00:00-05:00'));
  assert.equal(last.endsAt, et('2026-12-31T00:00:00-05:00') - 1);
  assert.match(last.description, /Single tracking between U St and Georgia Av-Petworth/);
});

test('a row naming two lines yields one window on both, with both impacts', () => {
  const windows = parseTrackwork(page, { now: NOW });
  const red = windows.find((w) => w.lines.includes('Red'));
  assert.deepEqual(red.lines, ['Red', 'Silver']);
  assert.equal(red.startsAt, et('2026-10-03T00:00:00-04:00'));
  assert.match(red.description, /Red Line: Single tracking Farragut North to Judiciary Sq/);
  assert.match(red.description, /Silver Line: Single tracking East Falls Church to McLean/);
});

test('the recorded page is not stale on the day it was fetched', () => {
  assert.equal(sourceIsStale(parseTrackwork(page, { now: NOW }), NOW), false);
});

// --- date forms -------------------------------------------------------------

test('reads each date form seen or anticipated on the page', () => {
  const md = (month, day, year = null) => ({ month, day, year });
  assert.deepEqual(datesIn('Sept. 19'), [md(8, 19)]);
  assert.deepEqual(datesIn('Sat., Sept. 19'), [md(8, 19)]);
  assert.deepEqual(datesIn('September 19, 2026'), [md(8, 19, 2026)]);
  assert.deepEqual(datesIn('Sept. 27-28'), [md(8, 27), md(8, 28)]);
  assert.deepEqual(datesIn('Sept. 27–28'), [md(8, 27), md(8, 28)]);
  assert.deepEqual(datesIn('Oct. 3 - 5'), [md(9, 3), md(9, 5)]);
  assert.deepEqual(datesIn('Oct. 3 to 5'), [md(9, 3), md(9, 5)]);
  assert.deepEqual(datesIn('Nov. 26 - Dec. 1'), [md(10, 26), md(11, 1)]);
  assert.deepEqual(datesIn('Dec. 28 through Jan. 3'), [md(11, 28), md(0, 3)]);
});

test('prose that is not a date yields nothing', () => {
  assert.deepEqual(datesIn('Farragut North to Judiciary Sq'), []);
  assert.deepEqual(datesIn('None'), []);
  assert.deepEqual(datesIn('TBD'), []);
  assert.deepEqual(datesIn('Sept. 40'), []);
});

test('single-column ranges produce the same window as two columns', () => {
  const two = parseTrackwork(table([['Oct. 3', 'Oct. 5', 'Red', 'x']]), { now: NOW })[0];
  const one = parseTrackwork(table([['Oct. 3 - 5', 'Red', 'x']], ['Date', 'Line', 'Impact']), { now: NOW })[0];
  assert.equal(one.startsAt, two.startsAt);
  assert.equal(one.endsAt, two.endsAt);
  assert.equal(one.startsAt, et('2026-10-03T00:00:00-04:00'));
  assert.equal(one.endsAt, et('2026-10-06T00:00:00-04:00') - 1);
});

test('a cross-month range keeps its order and a single day spans one day', () => {
  const [cross, single] = parseTrackwork(
    table([['Nov. 26 - Dec. 1', 'Blue', 'x'], ['Oct. 10', 'Orange', 'x']], ['Date', 'Line', 'Impact']),
    { now: NOW },
  );
  assert.equal(cross.startsAt, et('2026-11-26T00:00:00-05:00'));
  assert.equal(cross.endsAt, et('2026-12-02T00:00:00-05:00') - 1);
  assert.equal(single.endsAt - single.startsAt, DAY - 1);
});

test('zonedMidnight honours daylight saving in the source zone', () => {
  assert.equal(zonedMidnight(2026, 8, 19), et('2026-09-19T00:00:00-04:00'));
  assert.equal(zonedMidnight(2026, 11, 16), et('2026-12-16T00:00:00-05:00'));
  assert.equal(zonedMidnight(2026, 0, 1, 'UTC'), Date.UTC(2026, 0, 1));
});

// --- year inference ---------------------------------------------------------

test('a January window read in December rolls forward a year and says so', () => {
  const december = et('2026-12-20T12:00:00-05:00');
  const [jan, dec] = parseTrackwork(table([['Jan. 3', 'Jan. 4', 'Red', 'x'], ['Dec. 27', 'Dec. 28', 'Green', 'x']]), {
    now: december,
  });
  assert.equal(jan.startsAt, et('2027-01-03T00:00:00-05:00'));
  assert.equal(jan.rolledYear, true);
  assert.equal(dec.startsAt, et('2026-12-27T00:00:00-05:00'));
  assert.equal(dec.rolledYear, false);
});

test('a December window still listed in January belongs to last year, not eleven months ahead', () => {
  const january = et('2027-01-05T12:00:00-05:00');
  const [dec] = parseTrackwork(table([['Dec. 27', 'Dec. 28', 'Green', 'x']]), { now: january });
  assert.equal(dec.startsAt, et('2026-12-27T00:00:00-05:00'));
  assert.equal(dec.rolledYear, true);
});

test('a range crossing New Year ends in the following year', () => {
  const [w] = parseTrackwork(table([['Dec. 28 - Jan. 3', 'Silver', 'x']], ['Date', 'Line', 'Impact']), {
    now: et('2026-12-20T12:00:00-05:00'),
  });
  assert.equal(w.startsAt, et('2026-12-28T00:00:00-05:00'));
  assert.equal(w.endsAt, et('2027-01-04T00:00:00-05:00') - 1);
});

test('an explicit year in the cell wins over inference', () => {
  const [w] = parseTrackwork(table([['March 1, 2028', 'March 2, 2028', 'Red', 'x']]), { now: NOW });
  assert.equal(w.startsAt, et('2028-03-01T00:00:00-05:00'));
  assert.equal(w.rolledYear, false);
});

// --- unknown versus empty ---------------------------------------------------

test('garbage HTML is null (unknown), a table with no rows is [] (clear)', () => {
  assert.equal(parseTrackwork('<html><body><p>Service advisories</p></body></html>', { now: NOW }), null);
  assert.equal(parseTrackwork('', { now: NOW }), null);
  assert.equal(parseTrackwork(undefined, { now: NOW }), null);
  assert.deepEqual(parseTrackwork(table([]), { now: NOW }), []);
});

test('a note row like "No track work scheduled" is skipped, not a failure', () => {
  const html = table([], ['Date', 'Line']).replace('</tbody><tbody>', '</tbody><tbody><tr><td colspan="2">No track work scheduled</td></tr>');
  assert.deepEqual(parseTrackwork(html, { now: NOW }), []);
});

test('a table whose header lacks a line or date column is not the schedule', () => {
  assert.equal(parseTrackwork(table([['a', 'b', 'c']], ['Station', 'Elevator', 'Status']), { now: NOW }), null);
});

test('a data row with no readable date or no recognisable line gives up on the table', () => {
  assert.equal(parseTrackwork(table([['TBD', 'TBD', 'Red', 'x']]), { now: NOW }), null);
  assert.equal(parseTrackwork(table([['Oct. 3', 'Oct. 4', 'Purple', 'x']]), { now: NOW }), null);
  // A trailing single-cell row is a note, so the good row survives.
  assert.equal(parseTrackwork(table([['Oct. 3', 'Oct. 4', 'Red', 'x'], ['Oct. 5']]), { now: NOW }).length, 1);
});

test('lines are read from text, from hrefs, and from "all lines"', () => {
  assert.deepEqual(linesIn('<p><a href="/ridertools/line/red">Red</a></p><p><a href="/ridertools/line/silver">Silver</a></p>'), ['Red', 'Silver']);
  assert.deepEqual(linesIn('<a href="/ridertools/line/green">Metro</a>'), ['Green']);
  assert.deepEqual(linesIn('All lines'), LINES);
  assert.deepEqual(linesIn('Farragut North'), []);
});

// --- relevant windows -------------------------------------------------------

const red = { lines: ['Red', 'Silver'], startsAt: et('2026-10-03T00:00:00-04:00'), endsAt: et('2026-10-05T00:00:00-04:00') - 1, description: 'x', rolledYear: false };
const green = { lines: ['Green'], startsAt: et('2026-12-16T00:00:00-05:00'), endsAt: et('2026-12-31T00:00:00-05:00') - 1, description: 'y', rolledYear: false };

test('relevantWindows requires a line match and an overlap with the horizon', () => {
  const friday = et('2026-10-02T17:00:00-04:00');
  assert.deepEqual(relevantWindows([red, green], ['Red'], { now: friday }), [red]);
  assert.deepEqual(relevantWindows([red, green], ['Green'], { now: friday }), []);
  assert.deepEqual(relevantWindows([red, green], ['Red'], { now: friday, horizonHours: 6 }), []);
  assert.deepEqual(relevantWindows([red, green], ['Blue', 'Orange'], { now: friday }), []);
});

test('relevantWindows boundaries are inclusive at both ends', () => {
  const justBefore = red.startsAt - DAY - 1;
  const onTheDot = red.startsAt - DAY;
  assert.deepEqual(relevantWindows([red], ['Red'], { now: justBefore }), []);
  assert.deepEqual(relevantWindows([red], ['Red'], { now: onTheDot }), [red]);
  assert.deepEqual(relevantWindows([red], ['Red'], { now: red.endsAt }), [red]);
  assert.deepEqual(relevantWindows([red], ['Red'], { now: red.endsAt + 1 }), []);
});

test('relevantWindows is empty for null input or no lines', () => {
  assert.deepEqual(relevantWindows(null, ['Red'], { now: NOW }), []);
  assert.deepEqual(relevantWindows([red], undefined, { now: NOW }), []);
});

// --- assess -----------------------------------------------------------------

test('assessTrackwork: nothing near yields zeros, not nulls', () => {
  const s = assessTrackwork([red, green], ['Red', 'Green'], { now: NOW });
  assert.deepEqual(s, { active: 0, upcoming: 0, staleWindows: 0, reasons: [], score: null, unknown: false });
});

test('assessTrackwork: an active window is spoken with its end day', () => {
  const s = assessTrackwork([red, green], ['Red', 'Green'], { now: et('2026-10-03T08:00:00-04:00') });
  assert.equal(s.active, 1);
  assert.equal(s.upcoming, 0);
  assert.deepEqual(s.reasons, ['planned track work on the Red Line through tomorrow']);
  assert.equal(s.score, null);
  assert.equal(s.unknown, false);
});

test('assessTrackwork: a window within seven days is upcoming and spoken by weekday', () => {
  const s = assessTrackwork([red, green], ['Red'], { now: et('2026-09-29T08:00:00-04:00') });
  assert.equal(s.active, 0);
  assert.equal(s.upcoming, 1);
  assert.deepEqual(s.reasons, ['planned track work on the Red Line from Saturday through Sunday']);
});

test('assessTrackwork: a window eight days out is neither active nor upcoming', () => {
  const s = assessTrackwork([red], ['Red'], { now: red.startsAt - 8 * DAY });
  assert.equal(s.upcoming, 0);
  assert.deepEqual(s.reasons, []);
});

test('assessTrackwork: only the caller\'s lines are spoken from a shared row', () => {
  const s = assessTrackwork([red], ['Silver'], { now: et('2026-10-03T08:00:00-04:00') });
  assert.deepEqual(s.reasons, ['planned track work on the Silver Line through tomorrow']);
});

test('assessTrackwork: a long window far off is spoken with a date', () => {
  const s = assessTrackwork([green], ['Green'], { now: et('2026-12-17T08:00:00-05:00') });
  assert.deepEqual(s.reasons, ['planned track work on the Green Line through December 30']);
});

test('assessTrackwork: staleWindows counts every window whose start has passed, any line', () => {
  const s = assessTrackwork([red, green], ['Blue'], { now: et('2026-12-20T08:00:00-05:00') });
  assert.equal(s.staleWindows, 2);
  assert.equal(s.active, 0);
});

test('assessTrackwork: null input is the unknown shape', () => {
  const s = assessTrackwork(null, ['Red'], { now: NOW });
  assert.deepEqual(s, {
    active: null,
    upcoming: null,
    staleWindows: null,
    reasons: ['track work schedule unavailable: no data'],
    score: null,
    unknown: true,
  });
});

// --- staleness (rule 5) -----------------------------------------------------

test('sourceIsStale: only when every window ended more than sixty days ago', () => {
  const later = green.endsAt + STALE_AFTER_MS + DAY;
  assert.equal(sourceIsStale([red, green], later), true);
  assert.equal(sourceIsStale([red, green], green.endsAt + STALE_AFTER_MS - HOUR), false);
  assert.equal(sourceIsStale([red, green], NOW), false);
  assert.equal(sourceIsStale([], later), false);
  assert.equal(sourceIsStale(null, later), false);
});

// --- fetch ------------------------------------------------------------------

function stub({ status = 200, body = page, throwOnFetch = null, throwOnText = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwOnFetch) throw throwOnFetch;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        if (throwOnText) throw new Error('boom');
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

test('fetchTrackwork hits the schedule URL and assesses the page', async () => {
  const { fetchImpl, calls } = stub();
  const s = await fetchTrackwork(['Red', 'Green'], fetchImpl, { now: et('2026-10-03T08:00:00-04:00') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TRACKWORK_URL);
  assert.equal(s.unknown, false);
  assert.equal(s.active, 1);
  assert.deepEqual(s.reasons, ['planned track work on the Red Line through tomorrow']);
});

test('fetchTrackwork: HTTP 500 is unknown, never a throw', async () => {
  const s = await fetchTrackwork(['Red'], stub({ status: 500 }).fetchImpl, { now: NOW });
  assert.equal(s.unknown, true);
  assert.equal(s.active, null);
  assert.deepEqual(s.reasons, ['track work schedule unavailable: HTTP 500']);
});

test('fetchTrackwork: a network error names the class, not the URL', async () => {
  const err = new TypeError(`fetch failed ${TRACKWORK_URL}`);
  const s = await fetchTrackwork(['Red'], stub({ throwOnFetch: err }).fetchImpl, { now: NOW });
  assert.deepEqual(s.reasons, ['track work schedule unavailable: network error (TypeError)']);
});

test('fetchTrackwork: an unreadable body is unknown', async () => {
  const s = await fetchTrackwork(['Red'], stub({ throwOnText: true }).fetchImpl, { now: NOW });
  assert.deepEqual(s.reasons, ['track work schedule unavailable: unparseable response']);
});

test('fetchTrackwork: a page with no schedule table is unknown, a table with no rows is a clear', async () => {
  const none = await fetchTrackwork(['Red'], stub({ body: '<html><body>maintenance</body></html>' }).fetchImpl, { now: NOW });
  assert.equal(none.unknown, true);
  assert.deepEqual(none.reasons, ['track work schedule unavailable: no readable schedule table']);

  const empty = await fetchTrackwork(['Red'], stub({ body: table([]) }).fetchImpl, { now: NOW });
  assert.deepEqual(empty, { active: 0, upcoming: 0, staleWindows: 0, reasons: [], score: null, unknown: false });
});

test('fetchTrackwork: a page whose windows all ended long ago is stale, not clear', async () => {
  const later = et('2027-03-15T12:00:00-04:00');
  const s = await fetchTrackwork(['Green'], stub().fetchImpl, { now: later });
  assert.equal(s.unknown, true);
  assert.equal(s.active, null);
  assert.deepEqual(s.reasons, [STALE_REASON]);
});

test('fetchTrackwork logs each window whose year was inferred', async () => {
  const lines = [];
  const body = table([['Jan. 3', 'Jan. 4', 'Red', 'x'], ['Dec. 27', 'Dec. 28', 'Green', 'x']]);
  await fetchTrackwork(['Red'], stub({ body }).fetchImpl, { now: et('2026-12-20T12:00:00-05:00'), log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /year inferred for Red window starting 2027-01-03/);
});

test('fetchTrackwork never throws even when the fetch implementation is broken', async () => {
  const s = await fetchTrackwork(['Red'], () => { throw new RangeError('no'); }, { now: NOW });
  assert.equal(s.unknown, true);
});

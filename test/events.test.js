// Tests for the scheduled-events evening signal. No network: every case runs
// against a recorded Ticketmaster response, a hand-built one, or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  venuesRequest,
  eventsRequest,
  normaliseVenues,
  normaliseEvents,
  matchVenue,
  venueFor,
  assessEvents,
  fetchEvents,
  departureInstant,
  localDateOf,
  EVENING_BEFORE_MS,
  EVENING_AFTER_MS,
  SCORE_SATURATION_WEIGHT,
  VENUE_MATCH_METRES,
  EventsError,
} from '../src/events.js';

// Recorded live 2026-09-16: one venues.json lookup per keyword, key stripped.
const liveVenues = JSON.parse(readFileSync('test/fixtures/ticketmaster-venues.json', 'utf8'));
// Recorded live 2026-09-16: one events.json call for the four DC venue ids over
// the week of the 16th to the 23rd, key stripped. Ten events, none at
// Nationals Park or Arena Stage.
const liveEvents = JSON.parse(readFileSync('test/fixtures/ticketmaster-events.json', 'utf8'));

const TZ = 'America/New_York';

// Public stadiums, as the vendor pins them. Not a commute.
const dcVenues = [
  { name: 'Nationals Park', lat: 38.873, lon: -77.0074, weight: 1.0 },
  { name: 'Audi Field', lat: 38.868, lon: -77.0136, weight: 0.5 },
  { name: 'The Anthem', lat: 38.8801, lon: -77.0262, weight: 1.0 },
  { name: 'Arena Stage', lat: 38.878, lon: -77.0198, weight: 0.25 },
];

// Noon on the 16th, Eastern; the day the fixture was recorded.
const noon16 = Date.parse('2026-09-16T12:00:00-04:00');
const clock = { now: noon16, timeZone: TZ, eveningDeparture: '17:30' };

// Config shape as parseConfig produces it, minus everything this module ignores.
const config = {
  route: { timezone: TZ },
  decision: { assumed_evening_departure: '17:30' },
  venues: dcVenues,
};

test('the venue lookup is built from the configured name, not a literal', () => {
  const { url, params } = venuesRequest({ name: '  Fenway Park ', lat: 42.3467, lon: -71.0972, weight: 1 });
  assert.match(url, /^https:\/\/app\.ticketmaster\.com\/discovery\/v2\/venues\.json$/);
  assert.equal(params.keyword, 'Fenway Park');
  assert.equal(JSON.stringify({ url, params }).includes('apikey'), false);
  assert.throws(() => venuesRequest({ lat: 1, lon: 2 }), EventsError);
});

test('the events query carries every resolved id and the local day, and no key', () => {
  const { url, params } = eventsRequest(['A1', 'B2', 'C3'], { date: '2026-09-16' });
  assert.match(url, /^https:\/\/app\.ticketmaster\.com\/discovery\/v2\/events\.json$/);
  assert.equal(params.venueId, 'A1,B2,C3');
  assert.equal(params.localStartDateTime, '2026-09-16T00:00:00,2026-09-16T23:59:59');
  assert.equal(JSON.stringify({ url, params }).includes('apikey'), false);
  // No radius: an allowlist by design.
  assert.equal('latlong' in params, false);
  assert.equal('radius' in params, false);
  assert.equal('geoPoint' in params, false);
});

test('an events query with no ids or a malformed date is an error, not a global search', () => {
  assert.throws(() => eventsRequest([], { date: '2026-09-16' }), EventsError);
  assert.throws(() => eventsRequest(['A1'], { date: '16/09/2026' }), EventsError);
  assert.throws(() => eventsRequest(['A1'], {}), EventsError);
});

test('the live venue lookups resolve all six configured names to the right vendor record', () => {
  const expected = {
    'TD Garden': ['KovZpa2gne', { lat: 42.3662, lon: -71.0621 }],
    'Fenway Park': ['KovZpZAaaI7A', { lat: 42.3467, lon: -71.0972 }],
    'Nationals Park': ['KovZpZA1J67A', dcVenues[0]],
    'Audi Field': ['KovZ917A8Q0', dcVenues[1]],
    'The Anthem': ['KovZ917A3Y7', dcVenues[2]],
    'Arena Stage': ['ZFr9jZF1aA', dcVenues[3]],
  };
  for (const [name, [id, at]] of Object.entries(expected)) {
    const records = normaliseVenues(liveVenues[name]);
    assert.ok(Array.isArray(records), name);
    const match = matchVenue({ name, lat: at.lat, lon: at.lon, weight: 1 }, records);
    assert.equal(match?.id, id, name);
  }
});

test('venue matching is by name and distance: ghosts with no location and far namesakes lose', () => {
  const records = normaliseVenues(liveVenues['The Anthem']);
  // Three records carry the word; only the DC one is near the configured point.
  assert.equal(records.length, 3);
  const match = matchVenue(dcVenues[2], records);
  assert.equal(match.name, 'The Anthem');
  // The same keyword near Nashville picks the Nashville hall; nowhere near
  // anything, no match rather than the wrong venue.
  assert.equal(matchVenue({ name: 'Anthem', lat: 36.1578, lon: -86.7884, weight: 1 }, records)?.name, 'Anthem');
  assert.equal(matchVenue({ name: 'The Anthem', lat: 0, lon: 0, weight: 1 }, records), null);
  // TD Garden's four ghosts have no location and are skipped.
  const garden = normaliseVenues(liveVenues['TD Garden']);
  assert.equal(garden.filter((r) => r.lat === null).length, 4);
  assert.equal(matchVenue({ name: 'td garden', lat: 42.3662, lon: -71.0621, weight: 1 }, garden).id, 'KovZpa2gne');
  assert.ok(VENUE_MATCH_METRES >= 500);
});

test('a venue lookup that returns nothing is an empty list, and junk is null', () => {
  assert.deepEqual(normaliseVenues({ page: { totalElements: 0 } }), []);
  assert.equal(normaliseVenues({ _embedded: { venues: 'nope' } }), null);
  assert.equal(normaliseVenues('html'), null);
  assert.equal(normaliseVenues(null), null);
});

test('the live events fixture normalises to ten events with instants, local clocks and venues', () => {
  const events = normaliseEvents(liveEvents);
  assert.equal(events.length, 10);
  const first = events[0];
  assert.equal(first.name, 'The Beltway Brawl VII');
  assert.equal(first.venue, 'The Anthem');
  assert.equal(first.venueId, 'KovZ917A3Y7');
  assert.equal(first.localDate, '2026-09-16');
  assert.equal(first.localTime, '19:30:00');
  assert.equal(first.startsAt, Date.parse('2026-09-16T23:30:00Z'));
  assert.match(first.url, /^https:\/\/www\.ticketmaster\.com\//);
  assert.equal(first.kind, 'game');
  assert.equal(first.attendanceHint, null);
  for (const e of events) assert.equal(typeof e.startsAt, 'number');
  assert.equal(events.filter((e) => e.kind === 'concert').length, 6);
  assert.equal(events.filter((e) => e.kind === 'game').length, 4);
});

test('an empty events page is [], and an unrecognised shape is null, never 0', () => {
  assert.deepEqual(normaliseEvents({ page: { totalElements: 0 } }), []);
  assert.equal(normaliseEvents({ _embedded: { events: {} } }), null);
  assert.equal(normaliseEvents(undefined), null);
  assert.equal(normaliseEvents({ fault: 'bad key' }), null);
});

test('events match back to configured venues by name, case-insensitive and trimmed', () => {
  const venues = [{ name: '  the anthem ', weight: 1 }, { name: 'ARENA STAGE', weight: 1 }];
  assert.equal(venueFor({ venue: 'The Anthem', venueId: null }, venues), venues[0]);
  assert.equal(venueFor({ venue: 'Arena Stage at the Mead Center', venueId: null }, venues), venues[1]);
  // A vendor name that merely begins with the letters is not a match.
  assert.equal(venueFor({ venue: 'The Anthems Bar', venueId: null }, venues), null);
  assert.equal(venueFor({ venue: 'Anthem', venueId: null }, venues), null);
  assert.equal(venueFor({ venue: null, venueId: null }, venues), null);
  // A resolved id wins over the name.
  const resolved = [{ name: 'Somewhere Else', id: 'KovZ917A3Y7', weight: 1 }];
  assert.equal(venueFor({ venue: 'The Anthem', venueId: 'KovZ917A3Y7' }, resolved), resolved[0]);
});

test('the assumed departure lands on the local date of now, in the route zone', () => {
  assert.equal(localDateOf(noon16, TZ), '2026-09-16');
  // 03:00Z on the 17th is still the evening of the 16th in New York.
  assert.equal(localDateOf(Date.parse('2026-09-17T03:00:00Z'), TZ), '2026-09-16');
  assert.equal(departureInstant(noon16, TZ, '17:30'), Date.parse('2026-09-16T17:30:00-04:00'));
  assert.equal(departureInstant(noon16, TZ, '5:30'), Date.parse('2026-09-16T05:30:00-04:00'));
  assert.equal(departureInstant(noon16, TZ, 'half five'), null);
  assert.equal(departureInstant(noon16, TZ, undefined), null);
});

test('on the recorded day, one evening event: the Anthem fight at 7:30', () => {
  const result = assessEvents(normaliseEvents(liveEvents), dcVenues, clock);
  assert.equal(result.unknown, false);
  // Ten events all matched a configured venue; the week's worth is counted.
  assert.equal(result.count, 10);
  assert.equal(result.unmatched, 0);
  // Only the 16th's event falls in the window around 17:30 on the 16th.
  assert.equal(result.evening, 1);
  assert.equal(result.weighted, 1.0);
  assert.deepEqual(result.reasons, ['The Anthem game at 7:30 this evening']);
  assert.equal(result.score, 0.5);
});

test('the evening window is departure minus two hours to plus three, inclusive at both ends', () => {
  const departure = departureInstant(noon16, TZ, '17:30');
  const at = (offsetMs, venue = 'Nationals Park') => ({
    name: 'x',
    venue,
    venueId: null,
    startsAt: departure + offsetMs,
    localDate: '2026-09-16',
    localTime: '19:05:00',
    url: null,
    kind: 'game',
    attendanceHint: null,
  });
  const run = (events) => assessEvents(events, dcVenues, clock).evening;
  assert.equal(run([at(-EVENING_BEFORE_MS)]), 1);
  assert.equal(run([at(-EVENING_BEFORE_MS - 60_000)]), 0);
  assert.equal(run([at(EVENING_AFTER_MS)]), 1);
  assert.equal(run([at(EVENING_AFTER_MS + 60_000)]), 0);
  assert.equal(run([at(0)]), 1);
  // A morning event at a configured venue is counted, but is not evening.
  const morning = assessEvents([at(-8 * 3_600_000)], dcVenues, clock);
  assert.equal(morning.count, 1);
  assert.equal(morning.evening, 0);
  assert.equal(morning.score, 0);
  assert.deepEqual(morning.reasons, []);
});

test('weights sum across evening events and the score saturates', () => {
  const departure = departureInstant(noon16, TZ, '17:30');
  const at = (venue, localTime) => ({
    name: 'x',
    venue,
    venueId: null,
    startsAt: departure + 30 * 60_000,
    localDate: '2026-09-16',
    localTime,
    url: null,
    kind: 'game',
    attendanceHint: null,
  });
  const result = assessEvents(
    [at('Nationals Park', '19:05:00'), at('Audi Field', '18:00:00'), at('Arena Stage at the Mead Center', '20:00:00')],
    dcVenues,
    clock,
  );
  assert.equal(result.evening, 3);
  assert.equal(result.weighted, 1.75);
  assert.equal(result.score, 1.75 / SCORE_SATURATION_WEIGHT);
  assert.deepEqual(result.reasons, [
    'Nationals Park game at 7:05 this evening',
    'Audi Field game at 6:00 this evening',
    'Arena Stage game at 8:00 this evening',
  ]);
  const saturated = assessEvents(
    [at('Nationals Park', '19:05:00'), at('The Anthem', '19:00:00'), at('Audi Field', '19:00:00')],
    dcVenues,
    clock,
  );
  assert.equal(saturated.weighted, 2.5);
  assert.equal(saturated.score, 1);
});

test('events at venues not in the allowlist are dropped and counted, not scored', () => {
  const departure = departureInstant(noon16, TZ, '17:30');
  const stray = {
    name: 'x',
    venue: 'Capital One Arena',
    venueId: 'ZZZ',
    startsAt: departure,
    localDate: '2026-09-16',
    localTime: '17:30:00',
    url: null,
    kind: 'game',
    attendanceHint: null,
  };
  const result = assessEvents([stray], dcVenues, clock);
  assert.equal(result.count, 0);
  assert.equal(result.unmatched, 1);
  assert.equal(result.evening, 0);
  assert.equal(result.score, 0);
});

test('an event with no start instant is counted but never placed in the evening', () => {
  const tba = {
    name: 'x',
    venue: 'Nationals Park',
    venueId: null,
    startsAt: null,
    localDate: '2026-09-16',
    localTime: null,
    url: null,
    kind: 'game',
    attendanceHint: null,
  };
  const result = assessEvents([tba], dcVenues, clock);
  assert.equal(result.count, 1);
  assert.equal(result.evening, 0);
});

test('unknown input is the null shape, not zero events', () => {
  const result = assessEvents(null, dcVenues, clock);
  assert.equal(result.unknown, true);
  assert.equal(result.count, null);
  assert.equal(result.evening, null);
  assert.equal(result.weighted, null);
  assert.equal(result.score, null);
  assert.match(result.reasons[0], /^scheduled events unavailable: /);
  // No departure to anchor the window: also unknown.
  const noClock = assessEvents([], dcVenues, { now: noon16, timeZone: TZ, eveningDeparture: 'later' });
  assert.equal(noClock.unknown, true);
});

// A fetch stub that routes venues.json to the recorded lookups and events.json
// to the recorded week, and records what it was asked so the tests can check
// the key rode along as a parameter and nowhere else.
function stubFetch({ events = liveEvents, venues = liveVenues, status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (u.pathname.endsWith('/venues.json')) {
      const body = venues[u.searchParams.get('keyword')] ?? { page: { totalElements: 0 } };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => events };
  };
  fn.calls = calls;
  return fn;
}

test('fetchEvents resolves every venue, queries once for all of them, and never logs the key', async () => {
  const fetchImpl = stubFetch();
  const result = await fetchEvents(config, 'secret-key', fetchImpl, { now: noon16 });
  assert.equal(result.unknown, false);
  assert.equal(result.evening, 1);
  assert.deepEqual(result.resolved, ['Nationals Park', 'Audi Field', 'The Anthem', 'Arena Stage']);
  assert.deepEqual(result.unresolved, []);
  // Four lookups plus one events call.
  assert.equal(fetchImpl.calls.length, 5);
  const eventsCall = fetchImpl.calls[4];
  assert.equal(eventsCall.searchParams.get('venueId'), 'KovZpZA1J67A,KovZ917A8Q0,KovZ917A3Y7,ZFr9jZF1aA');
  assert.equal(eventsCall.searchParams.get('localStartDateTime'), '2026-09-16T00:00:00,2026-09-16T23:59:59');
  for (const u of fetchImpl.calls) assert.equal(u.searchParams.get('apikey'), 'secret-key');
  assert.equal(JSON.stringify(result).includes('secret-key'), false);
});

test('a venue the vendor does not know is reported, not fatal; none known is unknown', async () => {
  const withStranger = { ...config, venues: [...dcVenues, { name: 'Imaginary Bowl', lat: 38.9, lon: -77.0, weight: 1 }] };
  const result = await fetchEvents(withStranger, 'k', stubFetch(), { now: noon16 });
  assert.equal(result.unknown, false);
  assert.deepEqual(result.unresolved, ['Imaginary Bowl']);
  const none = { ...config, venues: [{ name: 'Imaginary Bowl', lat: 38.9, lon: -77.0, weight: 1 }] };
  const lost = await fetchEvents(none, 'k', stubFetch(), { now: noon16 });
  assert.equal(lost.unknown, true);
  assert.match(lost.reasons[0], /no configured venue matched/);
});

test('no key is unknown, and asks the network for nothing', async () => {
  const fetchImpl = stubFetch();
  for (const key of [undefined, '', null]) {
    const result = await fetchEvents(config, key, fetchImpl, { now: noon16 });
    assert.equal(result.unknown, true);
    assert.equal(result.score, null);
    assert.match(result.reasons[0], /no EVENTS_API_KEY/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('an HTTP 500 is unknown, not zero events', async () => {
  const result = await fetchEvents(config, 'k', stubFetch({ status: 500 }), { now: noon16 });
  assert.equal(result.unknown, true);
  assert.equal(result.count, null);
  assert.match(result.reasons[0], /HTTP 500/);
});

test('a thrown fetch is unknown and the reason carries no URL', async () => {
  const boom = async (url) => {
    throw new TypeError(`fetch failed: ${url}`);
  };
  const result = await fetchEvents(config, 'k', boom, { now: noon16 });
  assert.equal(result.unknown, true);
  assert.match(result.reasons[0], /network error \(TypeError\)/);
  assert.equal(result.reasons[0].includes('apikey'), false);
  assert.equal(result.reasons[0].includes('ticketmaster'), false);
});

test('fetchEvents never throws, whatever it is handed', async () => {
  const cases = [
    [undefined, 'k', stubFetch()],
    [{}, 'k', stubFetch()],
    [{ ...config, venues: [{ lat: 1, lon: 2, weight: 1 }] }, 'k', stubFetch()],
    [{ ...config, venues: [] }, 'k', stubFetch()],
    [config, 'k', async () => ({ ok: true, status: 200, json: async () => 'html' })],
    [config, 'k', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })],
  ];
  for (const [cfg, key, fetchImpl] of cases) {
    const result = await fetchEvents(cfg, key, fetchImpl, { now: noon16 });
    assert.equal(typeof result.unknown, 'boolean');
    assert.ok(Array.isArray(result.reasons));
  }
  // No venues configured is a real zero, not unknown: nothing was asked for.
  const empty = await fetchEvents({ ...config, venues: [] }, 'k', stubFetch(), { now: noon16 });
  assert.equal(empty.unknown, false);
  assert.equal(empty.count, 0);
  assert.equal(empty.score, 0);
});

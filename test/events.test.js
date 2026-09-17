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
import {
  scheduleRequest,
  normaliseGames,
  fetchMlbGames,
  nickname,
  SCHEDULE_ENDPOINT,
  MlbError,
} from '../src/mlb.js';

// Recorded live 2026-09-16: the Nationals' schedule for the 16th to the 23rd,
// trimmed to the fields the module reads. Seven games: one at home on the 16th
// and six on the road, so the venue filter has something to drop.
const liveSchedule = JSON.parse(readFileSync('test/fixtures/mlb-schedule.json', 'utf8'));

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

// ---- Ballparks (CMB-25): MLB's own schedule replaces the ticketing source ----

// The DC list with the ballpark moved to the mlb provider, as parseConfig
// would produce it. Nationals Park is the venue Ticketmaster returned nothing
// for across a full week, which is why this provider exists.
const mixedVenues = dcVenues.map((v) =>
  v.name === 'Nationals Park' ? { ...v, provider: 'mlb', mlb_team_id: 120 } : { ...v, provider: 'ticketmaster', mlb_team_id: null },
);
const mixedConfig = { ...config, venues: mixedVenues };
const ballparkOnly = { ...config, venues: mixedVenues.filter((v) => v.provider === 'mlb') };

test('the schedule request is one local day for one club, keyless, at the stats host', () => {
  const { url, params } = scheduleRequest(120, { date: '2026-09-16', timeZone: TZ });
  assert.equal(url, SCHEDULE_ENDPOINT);
  assert.match(url, /^https:\/\/statsapi\.mlb\.com\/api\/v1\/schedule$/);
  assert.deepEqual(params, { sportId: '1', teamId: '120', startDate: '2026-09-16', endDate: '2026-09-16' });
  assert.throws(() => scheduleRequest('120', { date: '2026-09-16' }), MlbError);
  assert.throws(() => scheduleRequest(0, { date: '2026-09-16' }), MlbError);
  assert.throws(() => scheduleRequest(120, { date: '16/09/2026' }), MlbError);
  assert.throws(() => scheduleRequest(120, {}), MlbError);
});

test('the live week has seven games and the venue filter keeps only the one at the ballpark', () => {
  assert.equal(liveSchedule.totalGames, 7);
  const all = liveSchedule.dates.flatMap((d) => d.games);
  assert.equal(all.length, 7);
  assert.equal(all.filter((g) => g.venue.name === 'Nationals Park').length, 1);
  // Six away games, all with the club as the away team, all at other parks.
  assert.equal(all.filter((g) => g.teams.away.team.id === 120).length, 6);

  const games = normaliseGames(liveSchedule, 'Nationals Park', { timeZone: TZ });
  assert.equal(games.length, 1);
  const [game] = games;
  assert.equal(game.name, 'Nationals vs Phillies');
  assert.equal(game.venue, 'Nationals Park');
  assert.equal(game.venueId, null);
  assert.equal(game.startsAt, Date.parse('2026-09-16T22:45:00Z'));
  assert.equal(game.localDate, '2026-09-16');
  assert.equal(game.localTime, '18:45:00');
  assert.equal(game.url, null);
  assert.equal(game.kind, 'game');
  assert.equal(game.attendanceHint, null);
  // Matching is on the venue name, case-insensitive and trimmed, not on home/away.
  assert.equal(normaliseGames(liveSchedule, '  nationals PARK ', { timeZone: TZ }).length, 1);
  assert.equal(normaliseGames(liveSchedule, 'Busch Stadium', { timeZone: TZ }).length, 3);
  assert.equal(normaliseGames(liveSchedule, 'Comerica Park', { timeZone: TZ }).length, 3);
  assert.equal(normaliseGames(liveSchedule, 'Fenway Park', { timeZone: TZ }).length, 0);
});

test('a 7:05 pm Eastern game stored in UTC comes back on the right local date and clock', () => {
  const schedule = {
    totalGames: 1,
    dates: [
      {
        date: '2026-09-25',
        games: [
          {
            gameDate: '2026-09-25T23:05:00Z',
            officialDate: '2026-09-25',
            status: { detailedState: 'Scheduled', startTimeTBD: false },
            teams: {
              away: { team: { id: 121, name: 'New York Mets' } },
              home: { team: { id: 120, name: 'Washington Nationals' } },
            },
            venue: { id: 3309, name: 'Nationals Park' },
          },
        ],
      },
    ],
  };
  const [game] = normaliseGames(schedule, 'Nationals Park', { timeZone: TZ });
  assert.equal(game.name, 'Nationals vs Mets');
  assert.equal(game.localDate, '2026-09-25');
  assert.equal(game.localTime, '19:05:00');
  assert.equal(game.startsAt, Date.parse('2026-09-25T19:05:00-04:00'));
  // Through the shared assessor, the spoken line is the same shape as a
  // Ticketmaster event's.
  const night = { now: Date.parse('2026-09-25T12:00:00-04:00'), timeZone: TZ, eveningDeparture: '17:30' };
  const result = assessEvents([game], mixedVenues, night);
  assert.equal(result.evening, 1);
  assert.deepEqual(result.reasons, ['Nationals Park game at 7:05 this evening']);
  // A late game in a Pacific park is still the venue's local date after midnight UTC.
  const west = normaliseGames(
    { dates: [{ games: [{ ...schedule.dates[0].games[0], gameDate: '2026-09-26T02:40:00Z', venue: { name: 'Dodger Stadium' } }] }] },
    'Dodger Stadium',
    { timeZone: 'America/Los_Angeles' },
  );
  assert.equal(west[0].localDate, '2026-09-25');
  assert.equal(west[0].localTime, '19:40:00');
});

test('a day with no game is [], a postponed or time-TBD game has no evening, and junk is null', () => {
  // The real shape of an empty day, recorded on an off day.
  assert.deepEqual(normaliseGames({ totalItems: 0, totalGames: 0, dates: [] }, 'Nationals Park', { timeZone: TZ }), []);
  const base = liveSchedule.dates[0].games[0];
  const withState = (patch) => ({ dates: [{ games: [{ ...base, status: { ...base.status, ...patch } }] }] });
  assert.equal(normaliseGames(withState({ detailedState: 'Postponed' }), 'Nationals Park', { timeZone: TZ }).length, 0);
  const tbd = normaliseGames(withState({ startTimeTBD: true }), 'Nationals Park', { timeZone: TZ });
  assert.equal(tbd.length, 1);
  assert.equal(tbd[0].startsAt, null);
  assert.equal(tbd[0].localTime, null);
  assert.equal(tbd[0].localDate, '2026-09-16');
  for (const junk of [null, undefined, 'html', { messageNumber: 10, message: 'Object not found' }, { dates: 'x' }, { dates: [{ games: {} }] }]) {
    assert.equal(normaliseGames(junk, 'Nationals Park', { timeZone: TZ }), null);
  }
  assert.equal(normaliseGames(liveSchedule, '', { timeZone: TZ }), null);
});

test('club nicknames drop the city and keep a two-word name whole', () => {
  assert.equal(nickname('Washington Nationals'), 'Nationals');
  assert.equal(nickname('Boston Red Sox'), 'Red Sox');
  assert.equal(nickname('Chicago White Sox'), 'White Sox');
  assert.equal(nickname('Toronto Blue Jays'), 'Blue Jays');
  assert.equal(nickname('St. Louis Cardinals'), 'Cardinals');
  assert.equal(nickname(undefined), 'unknown');
});

// A fetch stub that serves the ticketing host from the recorded lookups and
// week, and the stats host from the recorded schedule, with a status per host.
function twoSourceFetch({ tmStatus = 200, mlbStatus = 200, schedule = liveSchedule } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.hostname === 'statsapi.mlb.com') {
      if (mlbStatus !== 200) return { ok: false, status: mlbStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => schedule };
    }
    if (tmStatus !== 200) return { ok: false, status: tmStatus, json: async () => ({}) };
    if (u.pathname.endsWith('/venues.json')) {
      const body = liveVenues[u.searchParams.get('keyword')] ?? { page: { totalElements: 0 } };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => liveEvents };
  };
  fn.calls = calls;
  fn.mlbCalls = () => calls.filter((c) => c.url.hostname === 'statsapi.mlb.com');
  fn.tmCalls = () => calls.filter((c) => c.url.hostname !== 'statsapi.mlb.com');
  return fn;
}

test('fetchMlbGames asks for today at the ballpark with an ordinary User-Agent and no key', async () => {
  const fetchImpl = twoSourceFetch();
  const venue = mixedVenues.find((v) => v.provider === 'mlb');
  const { events, reason } = await fetchMlbGames(venue, fetchImpl, { now: noon16, timeZone: TZ });
  assert.equal(reason, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'Nationals vs Phillies');
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url.searchParams.get('teamId'), '120');
  assert.equal(url.searchParams.get('startDate'), '2026-09-16');
  assert.equal(url.searchParams.get('endDate'), '2026-09-16');
  assert.equal(url.searchParams.has('apikey'), false);
  assert.match(init.headers['User-Agent'], /^switchtender\//);
});

test('fetchMlbGames never throws: a 500, a thrown fetch, bad JSON and a bad venue are all named failures', async () => {
  const venue = mixedVenues.find((v) => v.provider === 'mlb');
  const cases = [
    [venue, twoSourceFetch({ mlbStatus: 500 }), /HTTP 500/],
    [venue, async (url) => { throw new TypeError(`fetch failed: ${url}`); }, /network error \(TypeError\)/],
    [venue, async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }), /unparseable/],
    [venue, async () => ({ ok: true, status: 200, json: async () => ({ message: 'nope' }) }), /no schedule/],
    [{ ...venue, mlb_team_id: null }, twoSourceFetch(), /team id/],
  ];
  for (const [v, fetchImpl, pattern] of cases) {
    const { events, reason } = await fetchMlbGames(v, fetchImpl, { now: noon16, timeZone: TZ });
    assert.equal(events, null);
    assert.match(reason, /^ballpark schedule unavailable: /);
    assert.match(reason, pattern);
    assert.equal(reason.includes('statsapi'), false);
  }
  const noZone = await fetchMlbGames(venue, twoSourceFetch(), { now: noon16 });
  assert.equal(noZone.events, null);
});

test('a mixed venue list merges both sources into one evening signal', async () => {
  const fetchImpl = twoSourceFetch();
  const result = await fetchEvents(mixedConfig, 'secret-key', fetchImpl, { now: noon16 });
  assert.equal(result.unknown, false);
  // The Anthem fight from the ticketing week plus the home game from the schedule.
  assert.equal(result.evening, 2);
  assert.equal(result.weighted, 2.0);
  assert.equal(result.score, 1);
  assert.deepEqual(result.reasons, [
    'The Anthem game at 7:30 this evening',
    'Nationals Park game at 6:45 this evening',
  ]);
  assert.deepEqual(result.resolved, ['Audi Field', 'The Anthem', 'Arena Stage', 'Nationals Park']);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.notes, []);
  // Three ticketing lookups plus one events call, plus one schedule call.
  // The ballpark is never asked of Ticketmaster: it replaces, not adds.
  assert.equal(fetchImpl.tmCalls().length, 4);
  assert.equal(fetchImpl.mlbCalls().length, 1);
  const keywords = fetchImpl.tmCalls().map((c) => c.url.searchParams.get('keyword')).filter(Boolean);
  assert.equal(keywords.includes('Nationals Park'), false);
  for (const c of fetchImpl.mlbCalls()) assert.equal(c.url.searchParams.has('apikey'), false);
  assert.equal(JSON.stringify(result).includes('secret-key'), false);
});

test('with no ticketing key the ballpark still answers and the ticketing venues are reported skipped', async () => {
  const fetchImpl = twoSourceFetch();
  const result = await fetchEvents(mixedConfig, undefined, fetchImpl, { now: noon16 });
  assert.equal(result.unknown, false);
  assert.equal(result.count, 1);
  assert.equal(result.evening, 1);
  assert.equal(result.score, 0.5);
  assert.deepEqual(result.reasons, ['Nationals Park game at 6:45 this evening']);
  assert.deepEqual(result.resolved, ['Nationals Park']);
  assert.deepEqual(result.unresolved, ['Audi Field', 'The Anthem', 'Arena Stage']);
  assert.deepEqual(result.notes, ['ticketing source skipped: no EVENTS_API_KEY']);
  assert.equal(fetchImpl.tmCalls().length, 0);
  assert.equal(fetchImpl.mlbCalls().length, 1);
  // A ballpark with no game today is a real zero, not unknown.
  const offDay = twoSourceFetch({ schedule: { totalItems: 0, totalGames: 0, dates: [] } });
  const quiet = await fetchEvents(ballparkOnly, '', offDay, { now: noon16 });
  assert.equal(quiet.unknown, false);
  assert.equal(quiet.count, 0);
  assert.equal(quiet.score, 0);
});

test('a 500 from the schedule host is unknown for that venue only, and unknown outright when it was the only source', async () => {
  const result = await fetchEvents(mixedConfig, 'k', twoSourceFetch({ mlbStatus: 500 }), { now: noon16 });
  assert.equal(result.unknown, false);
  assert.equal(result.evening, 1);
  assert.deepEqual(result.reasons, ['The Anthem game at 7:30 this evening']);
  assert.deepEqual(result.unresolved, ['Nationals Park']);
  assert.deepEqual(result.notes, ['Nationals Park: ballpark schedule unavailable: HTTP 500']);

  const alone = await fetchEvents(ballparkOnly, 'k', twoSourceFetch({ mlbStatus: 500 }), { now: noon16 });
  assert.equal(alone.unknown, true);
  assert.equal(alone.count, null);
  assert.equal(alone.score, null);
  assert.deepEqual(alone.reasons, ['ballpark schedule unavailable: HTTP 500']);
  assert.deepEqual(alone.unresolved, ['Nationals Park']);

  // The other way round: the ticketing host fails, the ballpark carries the signal.
  const tmDown = await fetchEvents(mixedConfig, 'k', twoSourceFetch({ tmStatus: 503 }), { now: noon16 });
  assert.equal(tmDown.unknown, false);
  assert.deepEqual(tmDown.reasons, ['Nationals Park game at 6:45 this evening']);
  assert.deepEqual(tmDown.unresolved, ['Audi Field', 'The Anthem', 'Arena Stage']);
  assert.match(tmDown.notes[0], /^ticketing source failed: venue lookup HTTP 503/);
});

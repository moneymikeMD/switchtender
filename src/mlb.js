// Ballpark schedules from MLB's own stats API (CMB-25).
//
// Why a second events provider. Ticketmaster returned zero events for
// Nationals Park across a full week on 2026-09-16, because MLB sells through
// its own platform. The ballpark is the biggest traffic generator near the
// destination, and the ticketing source cannot see it. The ticket says the
// replacement should replace the ticketing source for that venue, not sit
// beside it: a venue with provider = "mlb" is never asked of Ticketmaster.
//
// The endpoint is keyless and community-documented, not a published contract:
//   GET https://statsapi.mlb.com/api/v1/schedule
//       ?sportId=1&teamId=<id>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Verified live 2026-09-16. It can change without notice, which is why every
// shape check here returns null rather than guessing, and why the freshness
// probe (a month-long call returning totalGames 0 in season) is a thing to
// watch for in the logs rather than a rule this module enforces.
//
// Why filter on venue, not on home team. The schedule is per team, and it
// lists away games too: the recorded week is one home game and six on the
// road. A home game fills the roads near the destination; an away game in
// St. Louis does not. Matching venue.name against the configured venue name
// is also what lets a team that plays a home game somewhere else (a London
// series, a neutral-site opener) stay invisible, as it should.
//
// Some automated fetch tooling gets 405/406 from this host. A plain curl or a
// Node fetch with an ordinary User-Agent works, so one is sent.
//
// Rules this module answers to (CLAUDE.md): venues from config; unknown is
// null, never 0; an empty day is a real "no game"; this signal moves
// confidence and the spoken reason, never the verdict.

import { getJson } from './http.js';

export const SCHEDULE_ENDPOINT = 'https://statsapi.mlb.com/api/v1/schedule';

// A game in one of these states has no crowd to meet.
const NO_CROWD_STATES = new Set(['Postponed', 'Cancelled', 'Suspended']);

export class MlbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MlbError';
  }
}

const cleanName = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Build the schedule query for one team on one local day. The API filters on
 * the game's official (venue-local) date, so a single local day is startDate
 * and endDate equal to `date`; `timeZone` is accepted for symmetry with the
 * Ticketmaster request and is not needed for the query itself.
 */
export function scheduleRequest(teamId, { date } = {}) {
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new MlbError('mlb: team id must be a positive integer');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    throw new MlbError('mlb: date must be YYYY-MM-DD');
  }
  return {
    url: SCHEDULE_ENDPOINT,
    params: { sportId: '1', teamId: String(teamId), startDate: date, endDate: date },
  };
}

// "Washington Nationals" -> "Nationals"; "Boston Red Sox" -> "Red Sox". The
// schedule carries only the full club name. The nickname is the last word,
// or the last two for the three clubs whose nickname is two words. This name
// is for the log; the spoken reason uses the configured venue name.
const TWO_WORD_NICKNAMES = new Set(['Sox', 'Jays']);
export function nickname(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'unknown';
  if (words.length >= 2 && TWO_WORD_NICKNAMES.has(words[words.length - 1])) {
    return words.slice(-2).join(' ');
  }
  return words[words.length - 1];
}

function localClock(ms, timeZone) {
  if (!timeZone) return { localDate: null, localTime: null };
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return {
      localDate: `${p.year}-${p.month}-${p.day}`,
      localTime: `${p.hour}:${p.minute}:${p.second}`,
    };
  } catch {
    return { localDate: null, localTime: null };
  }
}

function normaliseOneGame(raw, timeZone) {
  const tbd = raw?.status?.startTimeTBD === true;
  const startsAt = !tbd && typeof raw?.gameDate === 'string' ? Date.parse(raw.gameDate) : NaN;
  const known = Number.isFinite(startsAt);
  const clock = known ? localClock(startsAt, timeZone) : { localDate: null, localTime: null };
  const home = nickname(raw?.teams?.home?.team?.name);
  const away = nickname(raw?.teams?.away?.team?.name);
  return {
    name: `${home} vs ${away}`,
    venue: typeof raw?.venue?.name === 'string' ? raw.venue.name : null,
    venueId: null,
    startsAt: known ? startsAt : null,
    // officialDate is the venue-local calendar date and is right even when the
    // route zone is not the ballpark's; the clock-derived date is the fallback.
    localDate: typeof raw?.officialDate === 'string' ? raw.officialDate : clock.localDate,
    localTime: clock.localTime,
    url: null,
    kind: 'game',
    attendanceHint: null,
  };
}

/**
 * Vendor schedule -> array of normalised games at the named venue, in the
 * shape src/events.js produces, or null on an unrecognised shape. Games at
 * other parks (the team's away games) are dropped here, so the caller sees
 * only what happens at the configured venue. Postponed, cancelled and
 * suspended games are dropped too: no crowd. An empty schedule (totalGames 0,
 * dates []) is [], a real "no game today".
 */
export function normaliseGames(vendorJson, venueName, { timeZone } = {}) {
  if (typeof vendorJson !== 'object' || vendorJson === null) return null;
  if (!Array.isArray(vendorJson.dates)) return null;
  const wanted = cleanName(venueName);
  if (wanted === '') return null;
  const out = [];
  for (const day of vendorJson.dates) {
    const games = day?.games;
    if (!Array.isArray(games)) return null;
    for (const raw of games) {
      if (cleanName(raw?.venue?.name) !== wanted) continue;
      if (NO_CROWD_STATES.has(raw?.status?.detailedState)) continue;
      out.push(normaliseOneGame(raw, timeZone));
    }
  }
  return out;
}

/** Prefix of every failure reason from this module; events.js reads it to avoid saying it twice. */
export const MLB_UNAVAILABLE = 'ballpark schedule unavailable';
const UNAVAILABLE = MLB_UNAVAILABLE;

function localDateOf(now, timeZone) {
  return localClock(now, timeZone).localDate;
}

/**
 * Fetch today's games at one configured mlb venue. Returns
 * { events, reason }: `events` is the normalised list ([] for a day with no
 * game) or null when the source could not answer, in which case `reason`
 * says why, prefixed "ballpark schedule unavailable: " and never carrying
 * the URL. Never throws. One request per venue per run; no liveness probe.
 */
export async function fetchMlbGames(venue, fetchImpl = fetch, { now = Date.now(), timeZone, signal } = {}) {
  const fail = (why) => ({ events: null, reason: `${UNAVAILABLE}: ${why}` });
  try {
    const date = localDateOf(now, timeZone);
    if (!date) return fail('no route time zone');
    let request;
    try {
      request = scheduleRequest(venue?.mlb_team_id, { date, timeZone });
    } catch (cause) {
      return fail(cause.message);
    }
    const { data, error } = await getJson(request, { fetchImpl, signal });
    if (error) return fail(error);
    const events = normaliseGames(data, venue?.name, { timeZone });
    if (events === null) return fail('response had no schedule');
    return { events, reason: null };
  } catch (cause) {
    return fail(`unexpected error (${cause?.name ?? 'Error'})`);
  }
}

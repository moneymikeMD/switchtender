// Scheduled events at the configured venues, reduced to one evening signal.
//
// A morning verdict is about the morning drive. It says nothing about the
// return leg, and it should not pretend to: an afternoon crash is invisible at
// 8am. A ballgame is different. It is known in the morning, it is known to the
// hour, and it fills the roads around the destination just when the driver
// wants to leave. That is the one kind of evening knowledge this module
// supplies, and CLAUDE.md is explicit about what it may do with it: move the
// confidence figure and the spoken reason, never the choice. The ticket
// (CMB-13) predates that rule and says "shift the verdict toward Metro"; the
// rule wins.
//
// Providers. Ticketmaster Discovery v2 by default; a venue with
// provider = "mlb" is read from MLB's own schedule instead (src/mlb.js,
// CMB-25), because MLB sells through its own platform and Ticketmaster lists
// nothing for a ballpark. The mlb provider replaces the ticketing source for
// that venue rather than sitting beside it. Venues are an allowlist from
// config.venues, never a radius (see the comment in config.example.toml). Each
// vendor is hidden behind its normalise function; the merged list is what
// assessEvents sees, so the signal shape, the evening window, the weights and
// the spoken reasons are the same whichever source a venue came from.
//
// Why two request shapes. Discovery's events endpoint filters by venueId, not
// by venue name, and a keyword filter on events matches the event title, not
// the venue, so "Fenway Park" would return a tribute band's set list. So the
// module first resolves each configured name to a vendor venue id with one
// venues.json call per venue, then makes one events.json call carrying every
// id. Checked live 2026-09-16 against the owner's four DC venues: one call
// with four comma-separated ids returned exactly the sum of four single-id
// calls (9 = 0 + 3 + 6 + 0), and a same-day localStartDateTime range filtered
// correctly (1 event on the 16th, 2 on the 18th). So the per-run cost is
// venues + 1 requests, five for four venues, against a 5000/day quota.
//
// Why distance decides the venue match. A keyword lookup for "TD Garden"
// returned five records all named "TD Garden", four of them ghosts with no
// city, no location and no upcoming events. "The Anthem" also returned a
// casino stage in Iowa, and "Arena Stage" is filed as "Arena Stage at the
// Mead Center". Name alone cannot pick the right record; the config lat/lon
// can, and VENUE_MATCH_METRES is the tolerance. Those coordinates come from
// config.toml, never from source.
//
// Rules this module answers to (CLAUDE.md): venues from config; the key is
// read at call time and never logged; unknown is null, never 0; this signal
// moves confidence and the spoken reason, never the verdict.

import { haversineMetres } from './polyline.js';
import { getJson } from './http.js';
import { fetchMlbGames, MLB_UNAVAILABLE } from './mlb.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2';
const VENUES_ENDPOINT = `${BASE}/venues.json`;
const EVENTS_ENDPOINT = `${BASE}/events.json`;

// A vendor venue record counts as the configured venue when its name contains
// the configured name and its location sits within this distance of the
// configured point. Ticketmaster's pins for the four DC venues and the two
// Boston ones all fell within 150 m of the obvious coordinates; a kilometre
// leaves room for a pin on the far side of a stadium without reaching the
// next venue over.
export const VENUE_MATCH_METRES = 1000;

// The evening window. An event that starts within this range of the assumed
// evening departure is one the return drive will meet: the arriving crowd
// before the start, the departing crowd after. Two hours before to three
// hours after is a tuning guess, not a measured value; logged history decides
// whether it moves.
export const EVENING_BEFORE_MS = 2 * 60 * 60 * 1000;
export const EVENING_AFTER_MS = 3 * 60 * 60 * 1000;

// Score saturates at this much summed venue weight. With every venue at the
// example's 1.0, two evening events max the signal out. A guess.
export const SCORE_SATURATION_WEIGHT = 2;

// Vendor segment name -> spoken noun. Anything else is "event".
const SEGMENT_NOUN = { Sports: 'game', Music: 'concert' };

export class EventsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventsError';
  }
}

const cleanName = (name) =>
  String(name ?? '')
    .trim()
    .toLowerCase();

/**
 * Build the venue lookup for one configured venue. No key here: the key is
 * added at call time so this object can be logged or asserted on safely.
 */
export function venuesRequest(venue) {
  if (typeof venue?.name !== 'string' || venue.name.trim() === '') {
    throw new EventsError('events: a venue is missing "name"');
  }
  return { url: VENUES_ENDPOINT, params: { keyword: venue.name.trim(), size: '20' } };
}

/**
 * Build the events query for a list of resolved vendor venue ids on one local
 * date. `date` is YYYY-MM-DD in the route's time zone; the vendor filters on
 * the event's own local clock, which for a venue near the destination is the
 * same zone, so no offset arithmetic is needed here.
 */
export function eventsRequest(venueIds, { date }) {
  if (!Array.isArray(venueIds) || venueIds.length === 0) {
    throw new EventsError('events: no venue ids to query');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    throw new EventsError('events: date must be YYYY-MM-DD');
  }
  return {
    url: EVENTS_ENDPOINT,
    params: { venueId: venueIds.join(','), localStartDateTime: `${date}T00:00:00,${date}T23:59:59`, size: '50', sort: 'date,asc' },
  };
}

/**
 * Vendor venues.json -> array of { id, name, lat, lon } or null on an
 * unrecognised shape. Records without a location keep null coordinates; the
 * matcher drops them.
 */
export function normaliseVenues(vendorJson) {
  if (typeof vendorJson !== 'object' || vendorJson === null) return null;
  // An empty result has no _embedded block at all; that is a real "nothing".
  if (vendorJson._embedded === undefined) return vendorJson.page ? [] : null;
  const list = vendorJson._embedded?.venues;
  if (!Array.isArray(list)) return null;
  return list.map((v) => {
    const lat = Number(v?.location?.latitude);
    const lon = Number(v?.location?.longitude);
    const located = Number.isFinite(lat) && Number.isFinite(lon);
    return {
      id: typeof v?.id === 'string' ? v.id : null,
      name: typeof v?.name === 'string' ? v.name : '',
      lat: located ? lat : null,
      lon: located ? lon : null,
    };
  });
}

/**
 * Pick the vendor record for a configured venue: name contains the configured
 * name (case-insensitive, trimmed), location within VENUE_MATCH_METRES of the
 * configured point, nearest wins. Returns the record or null.
 */
export function matchVenue(venue, records) {
  if (!Array.isArray(records)) return null;
  const wanted = cleanName(venue?.name);
  if (wanted === '' || typeof venue?.lat !== 'number' || typeof venue?.lon !== 'number') return null;
  let best = null;
  let bestDistance = Infinity;
  for (const r of records) {
    if (!r?.id || r.lat === null || r.lon === null) continue;
    if (!cleanName(r.name).includes(wanted)) continue;
    const d = haversineMetres([venue.lat, venue.lon], [r.lat, r.lon]);
    if (d <= VENUE_MATCH_METRES && d < bestDistance) {
      best = r;
      bestDistance = d;
    }
  }
  return best;
}

function normaliseOneEvent(raw) {
  const start = raw?.dates?.start ?? {};
  const startsAt = typeof start.dateTime === 'string' ? Date.parse(start.dateTime) : NaN;
  const venue = raw?._embedded?.venues?.[0];
  const segment = raw?.classifications?.[0]?.segment?.name;
  return {
    name: typeof raw?.name === 'string' ? raw.name : 'event',
    venue: typeof venue?.name === 'string' ? venue.name : null,
    venueId: typeof venue?.id === 'string' ? venue.id : null,
    startsAt: Number.isFinite(startsAt) ? startsAt : null,
    localDate: typeof start.localDate === 'string' ? start.localDate : null,
    localTime: typeof start.localTime === 'string' ? start.localTime : null,
    url: typeof raw?.url === 'string' ? raw.url : null,
    kind: SEGMENT_NOUN[segment] ?? 'event',
    // Discovery carries no attendance or capacity figure. Kept as a slot so
    // the engine's shape is stable if a source that has one is added.
    attendanceHint: null,
  };
}

/**
 * Vendor events.json -> array of normalised events, or null on an
 * unrecognised shape. An empty page has no _embedded block; that is [] and
 * means "nothing scheduled", which is a real answer.
 */
export function normaliseEvents(vendorJson) {
  if (typeof vendorJson !== 'object' || vendorJson === null) return null;
  if (vendorJson._embedded === undefined) return vendorJson.page ? [] : null;
  const list = vendorJson._embedded?.events;
  if (!Array.isArray(list)) return null;
  return list.map(normaliseOneEvent);
}

const UNKNOWN_REASON = 'scheduled events unavailable';

/** The unknown shape: every count null, the reason naming the failure class. */
export function unknownEvents(reason) {
  return { count: null, evening: null, weighted: null, unmatched: null, reasons: [`${UNKNOWN_REASON}: ${reason}`], score: null, unknown: true };
}

const unknown = unknownEvents;

/**
 * Match a normalised event back to a configured venue. By vendor id when the
 * venue was resolved (venue.id present), otherwise by name: case-insensitive,
 * trimmed, and accepting a vendor name that begins with the configured one
 * followed by a non-letter ("Arena Stage at the Mead Center").
 */
export function venueFor(event, venues) {
  if (!Array.isArray(venues)) return null;
  if (event?.venueId) {
    const byId = venues.find((v) => v?.id && v.id === event.venueId);
    if (byId) return byId;
  }
  const vendor = cleanName(event?.venue);
  if (vendor === '') return null;
  return (
    venues.find((v) => {
      const wanted = cleanName(v?.name);
      if (wanted === '') return false;
      if (vendor === wanted) return true;
      return vendor.startsWith(wanted) && !/[a-z0-9]/.test(vendor.charAt(wanted.length));
    }) ?? null
  );
}

const hourMinute = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const offset = out.timeZoneName === 'GMT' ? '+00:00' : out.timeZoneName.replace('GMT', '');
  return { ...out, offset };
};

/** The local calendar date of an instant in a time zone, as YYYY-MM-DD. */
export function localDateOf(now, timeZone) {
  const p = hourMinute(new Date(now), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The instant, in ms, of "HH:MM" local time on the local date of `now`.
 * The offset in force at `now` is used; an evening departure and a morning
 * verdict share a DST state on every day but the two changeover Sundays,
 * and on those the error is one hour on a day nobody commutes.
 */
export function departureInstant(now, timeZone, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const p = hourMinute(new Date(now), timeZone);
  const iso = `${p.year}-${p.month}-${p.day}T${m[1].padStart(2, '0')}:${m[2]}:00${p.offset}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function spokenTime(localTime) {
  const m = /^(\d{1,2}):(\d{2})/.exec(localTime ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${m[2]}`;
}

function describe(event, venue) {
  const at = spokenTime(event.localTime);
  return at ? `${venue.name} ${event.kind} at ${at} this evening` : `${venue.name} ${event.kind} this evening`;
}

/**
 * Reduce the day's events at the configured venues to one evening signal.
 *
 * count      events matched to a configured venue, or null when unknown
 * evening    of those, the ones starting within the window around departure
 * weighted   sum of venue.weight over the evening events
 * unmatched  events the vendor returned that matched no configured venue
 * reasons    spoken strings, one per evening event
 * score      min(1, weighted / SCORE_SATURATION_WEIGHT), or null when unknown
 * unknown    true only when the input could not be read
 *
 * An event with no start instant (time to be announced) is counted but
 * cannot be placed in the window, so it is not an evening event. It is
 * counted rather than dropped because "something is on today" is still
 * information the engine may want later.
 */
export function assessEvents(events, venues, { now = Date.now(), timeZone, eveningDeparture } = {}) {
  if (!Array.isArray(events)) return unknown('no data');
  const departure = timeZone ? departureInstant(now, timeZone, eveningDeparture) : null;
  if (departure === null) return unknown('no assumed evening departure');

  const windowStart = departure - EVENING_BEFORE_MS;
  const windowEnd = departure + EVENING_AFTER_MS;
  const reasons = [];
  let count = 0;
  let evening = 0;
  let weighted = 0;
  let unmatched = 0;
  for (const event of events) {
    const venue = venueFor(event, venues);
    if (!venue) {
      unmatched += 1;
      continue;
    }
    count += 1;
    if (event.startsAt === null) continue;
    if (event.startsAt >= windowStart && event.startsAt <= windowEnd) {
      evening += 1;
      weighted += typeof venue.weight === 'number' ? venue.weight : 1;
      reasons.push(describe(event, venue));
    }
  }
  return { count, evening, weighted, unmatched, reasons, score: Math.min(1, weighted / SCORE_SATURATION_WEIGHT), unknown: false };
}

const getTicketed = (request, apiKey, fetchImpl, signal) => getJson(request, { fetchImpl, query: { apikey: apiKey }, signal });

const providerOf = (venue) => venue?.provider ?? 'ticketmaster';

/**
 * The Ticketmaster half of fetchEvents: resolve venues to vendor ids and
 * fetch today's events at them. Returns { events, resolved, unresolved,
 * error }. `events` is null and `error` set when the source could not
 * answer; a venue the vendor does not know lands in `unresolved`.
 */
async function fetchTicketmaster(venues, apiKey, fetchImpl, { now, timeZone, signal }) {
  const resolved = [];
  const unresolved = [];
  for (const venue of venues) {
    let request;
    try {
      request = venuesRequest(venue);
    } catch (cause) {
      return { events: null, resolved: [], unresolved: [], error: cause.message };
    }
    const { data, error } = await getTicketed(request, apiKey, fetchImpl, signal);
    if (error) return { events: null, resolved: [], unresolved: [], error: `venue lookup ${error}` };
    const records = normaliseVenues(data);
    if (records === null) {
      return { events: null, resolved: [], unresolved: [], error: 'venue lookup had no venue list' };
    }
    const match = matchVenue(venue, records);
    if (match) resolved.push({ ...venue, id: match.id });
    else unresolved.push(venue.name);
  }
  if (resolved.length === 0) {
    return { events: null, resolved: [], unresolved, error: 'no configured venue matched a vendor record' };
  }

  let request;
  try {
    request = eventsRequest(
      resolved.map((v) => v.id),
      { date: localDateOf(now, timeZone) },
    );
  } catch (cause) {
    return { events: null, resolved: [], unresolved, error: cause.message };
  }
  const { data, error } = await getTicketed(request, apiKey, fetchImpl, signal);
  if (error) return { events: null, resolved: [], unresolved, error };
  const events = normaliseEvents(data);
  if (events === null) return { events: null, resolved: [], unresolved, error: 'response had no event list' };
  return { events, resolved, unresolved, error: null };
}

/**
 * Fetch today's events at the configured venues, each from its provider,
 * merge, and assess. Returns the assessment with `resolved` (venues whose
 * source answered and, for Ticketmaster, matched a vendor record),
 * `unresolved` (configured names that got no answer), `notes` (one line per
 * source that was skipped or failed, kept apart from `reasons` because the
 * verdict speaks `reasons`) and `partial` (true when some source did not
 * answer) added.
 *
 * Never throws: this is an optional signal, and losing it is a lower
 * confidence, not a missing verdict. No reason ever carries the key or a URL.
 *
 * When a source fails (or the Ticketmaster venues are skipped for want of
 * EVENTS_API_KEY), the venues it covered are unknown, and unknown is not
 * clear (rule 4). So the merged answer is a real count only when it is
 * positive: an event the other source did find is still an event tonight,
 * spoken and penalised as usual, with the failure in `notes`. A zero from the
 * sources that answered says nothing about the ones that did not, so it is
 * the unknown shape, with the first failure as the spoken reason. The
 * keyless mlb provider is the point of the split: with no key and an mlb
 * venue, the ballpark still answers, and a game there is still heard.
 */
export async function fetchEvents(config, apiKey, fetchImpl = fetch, { now = Date.now(), signal } = {}) {
  try {
    return await fetchEventsInner(config, apiKey, fetchImpl, { now, signal });
  } catch (cause) {
    return { ...unknown(`unexpected error (${cause?.name ?? 'Error'})`), resolved: [], unresolved: [], notes: [], partial: false };
  }
}

async function fetchEventsInner(config, apiKey, fetchImpl, { now, signal }) {
  const venues = Array.isArray(config?.venues) ? config.venues : [];
  const ticketed = venues.filter((v) => providerOf(v) === 'ticketmaster');
  const ballparks = venues.filter((v) => providerOf(v) === 'mlb');
  const bare = (shape) => ({ ...shape, resolved: [], unresolved: [], notes: [], partial: false });
  if (!apiKey && ballparks.length === 0) return bare(unknown('no EVENTS_API_KEY'));

  const timeZone = config?.route?.timezone;
  const eveningDeparture = config?.decision?.assumed_evening_departure;
  // Fail before spending requests on a question the assessment cannot answer.
  if (!timeZone || departureInstant(now, timeZone, eveningDeparture) === null) {
    return bare(unknown('no assumed evening departure'));
  }
  const clock = { now, timeZone, eveningDeparture };
  if (venues.length === 0) return bare(assessEvents([], [], clock));

  const events = [];
  const matched = [];
  const resolved = [];
  const unresolved = [];
  const notes = [];
  let answered = 0;
  const failures = [];

  if (ticketed.length > 0) {
    if (!apiKey) {
      unresolved.push(...ticketed.map((v) => v.name));
      notes.push('ticketing source skipped: no EVENTS_API_KEY');
      failures.push('no EVENTS_API_KEY');
    } else {
      const tm = await fetchTicketmaster(ticketed, apiKey, fetchImpl, { ...clock, signal });
      unresolved.push(...tm.unresolved);
      if (tm.error) {
        // A ticketing failure takes every ticketed venue with it; the
        // unmatched ones are already listed.
        for (const v of ticketed) if (!unresolved.includes(v.name)) unresolved.push(v.name);
        notes.push(`ticketing source failed: ${tm.error}`);
        failures.push(tm.error);
      } else {
        answered += 1;
        events.push(...tm.events);
        matched.push(...tm.resolved);
        resolved.push(...tm.resolved.map((v) => v.name));
      }
    }
  }

  for (const venue of ballparks) {
    const { events: games, reason } = await fetchMlbGames(venue, fetchImpl, { now, timeZone, signal });
    if (games === null) {
      unresolved.push(venue.name);
      notes.push(`${venue.name}: ${reason}`);
      failures.push(reason);
      continue;
    }
    answered += 1;
    events.push(...games);
    matched.push(venue);
    resolved.push(venue.name);
  }

  const partial = failures.length > 0;
  const assessment = answered === 0 ? null : assessEvents(events, matched, clock);
  if (assessment === null || (partial && assessment.evening === 0)) {
    const why = failures[0] ?? 'no configured venue matched a vendor record';
    const shape = unknown(why);
    // A ballpark failure already names itself; do not prefix it twice.
    if (why.startsWith(MLB_UNAVAILABLE)) shape.reasons = [why];
    // What did answer is kept for the log; the counts stay null.
    return { ...shape, resolved, unresolved, notes, partial };
  }
  return { ...assessment, resolved, unresolved, notes, partial };
}

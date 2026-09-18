// Planned Metro track work, scraped from the published schedule page.
//
// The live rail incidents feed reports a condition once it is in effect. A
// fork decision needs to know about Saturday's single-tracking on Friday, and
// the only source that says so ahead of time is the HTML table WMATA
// maintains by hand (CMB-14 spike, CMB-26). No feed is linked from it, the old
// RSS feed is a 404, and GTFS-RT alerts carry no future active_period
// (CMB-27). So this module reads prose.
//
// The page, as fetched 2026-09-16 (track-work.cfm redirects here):
//
//   https://www.wmata.com/ride/planned-track-work.html
//
// One <table>, header row: Start | End | Line | Impact | Stations closed |
// Work to perform. Start and End are single dates with month and day only
// ("Sept. 19", "Oct. 3", "Dec. 16"); the Line cell holds one <a> per line;
// Impact and Work hold one <p> per line when a row covers several. Earlier
// versions of the page kept a single Date column with ranges ("Sept. 27-28",
// "Nov. 26 - Dec. 1"), so both layouts are read. The AEM wrapper also embeds
// an HTML-escaped copy of the table in a data attribute; that copy has no
// literal '<table' and is ignored.
//
// Rules this module answers to (CLAUDE.md): unknown is null, never 0, so an
// unreadable table is null and a readable table with no rows is []; the
// signal moves confidence and the spoken reason, never the verdict (rule 3);
// freshness is two tests (rule 5): the source is stale when every window it
// lists ended long ago, a window is relevant when it overlaps the commute;
// nothing is filtered by when the page was edited. Fail soft: a scraper that
// quietly returns empty is worse than one that says it could not read.

import { getText } from './http.js';

export const TRACKWORK_URL = 'https://www.wmata.com/ride/planned-track-work.html';

/** Metrorail lines as the page names them. Matching is case-insensitive. */
export const LINES = ['Red', 'Orange', 'Blue', 'Green', 'Yellow', 'Silver'];

/**
 * The page's dates carry no zone. They are WMATA's dates, so WMATA's zone is
 * the default; the orchestrator may pass config.route.timezone instead.
 */
export const DEFAULT_TIME_ZONE = 'America/New_York';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// A row with a Start but no readable End ("Until further notice", "TBD", an
// empty cell) is open-ended. It is treated as running this long from its
// start: long enough to stay active through any horizon the engine asks
// about, short enough that a forgotten row eventually ages out under
// STALE_AFTER_MS. Spoken as "until further notice", never with a date.
export const OPEN_ENDED_MS = 90 * DAY_MS;

/** Rule 5, first test: a source whose newest window ended this long ago is dead. */
export const STALE_AFTER_MS = 60 * DAY_MS;

export const STALE_REASON = 'track work schedule stale';

const UNKNOWN_REASON = 'track work schedule unavailable';

// Month tokens as the page abbreviates them ("Sept." is the AP style WMATA
// uses; "Sep" and the full name are accepted too). Index is the JS month.
const MONTHS = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sept', 'sep'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

const MONTH_INDEX = new Map();
MONTHS.forEach((names, i) => names.forEach((n) => MONTH_INDEX.set(n, i)));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

// A numeric entity outside Unicode ("&#1114112;") is left as written rather
// than thrown on: String.fromCodePoint rejects it with a RangeError, and one
// bad character in a cell must not cost the signal.
function codePoint(n, original) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => codePoint(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Tag soup -> text. Block boundaries become '; ' so "Red Line: ..." and
// "Silver Line: ..." paragraphs in one cell stay readable when spoken.
function textOf(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '; ')
      .replace(/<\/(p|div|li)>/gi, '; ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*(;\s*)*/g, '; ')
    .replace(/^[;\s]+|[;\s]+$/g, '')
    .trim();
}

// Split on a tag without a full parser: <tr ...>...</tr> and <td|th>...</td|th>.
function pieces(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function tables(html) {
  return pieces(html, 'table');
}

function cells(rowHtml) {
  // th and td in document order.
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(m[2]);
  return out;
}

/**
 * Map header text to column roles. Returns null unless the header names a
 * line column and a date column; anything else is not the schedule table.
 */
function columnsFrom(headerCells) {
  const cols = { start: -1, end: -1, line: -1, impact: -1, work: -1 };
  headerCells.forEach((raw, i) => {
    const t = textOf(raw).toLowerCase();
    if (cols.line < 0 && /\bline/.test(t)) cols.line = i;
    else if (cols.start < 0 && /\b(start|date|when)\b/.test(t)) cols.start = i;
    else if (cols.end < 0 && /\bend/.test(t)) cols.end = i;
    else if (cols.impact < 0 && /\bimpact|service/.test(t)) cols.impact = i;
    else if (cols.work < 0 && /\bwork/.test(t)) cols.work = i;
  });
  return cols.line >= 0 && cols.start >= 0 ? cols : null;
}

/**
 * Lines named in a cell. Anchor hrefs (/ridertools/line/red) count as well as
 * text. "All lines" or "systemwide" means every line. Returns [] when nothing
 * is recognised, which the caller treats as an unreadable row.
 */
export function linesIn(cellHtml) {
  // Raw markup, not text: the href names the line even if the label changes.
  const text = decode(cellHtml).toLowerCase();
  if (/\b(all lines|systemwide|system-wide|every line)\b/.test(text)) return [...LINES];
  return LINES.filter((line) => new RegExp(`\\b${line.toLowerCase()}\\b`).test(text));
}

// A date token: optional weekday, month name, day, optional year.
//   "Sept. 19"  "Sat., Sept. 19"  "September 19, 2026"  "Oct 3"
const DATE_RE = /(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi;

/**
 * Every month/day (and explicit year) mentioned in a cell, in order. A bare
 * day after a range separator ("Sept. 27-28", "Oct. 3 - 5") takes the month
 * of the date before it. Returns [] when nothing parses.
 */
export function datesIn(text) {
  const out = [];
  const plain = text.replace(/[–—]/g, '-');
  let last = 0;
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(plain)) !== null) {
    const month = MONTH_INDEX.get(m[1].toLowerCase());
    if (month === undefined) continue;
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    out.push({ month, day, year: m[3] ? Number(m[3]) : null });
    last = DATE_RE.lastIndex;
    // Same-month range: "Sept. 27-28", "Oct. 3 - 5", "Oct. 3 to 5".
    const tail = /^\s*(?:-|to|through|thru)\s*(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(plain.slice(last));
    if (tail) {
      const d2 = Number(tail[1]);
      if (d2 >= 1 && d2 <= 31) {
        out.push({ month, day: d2, year: m[3] ? Number(m[3]) : null });
        DATE_RE.lastIndex = last + tail[0].length;
      }
    }
  }
  return out;
}

// --- zoned midnight without a library ------------------------------------

function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Epoch ms of local midnight on year/month/day in timeZone. */
export function zonedMidnight(year, month, day, timeZone = DEFAULT_TIME_ZONE) {
  const guess = Date.UTC(year, month, day);
  let ms = guess - zoneOffsetMs(guess, timeZone);
  // A second pass settles a guess that landed across a DST change.
  ms = guess - zoneOffsetMs(ms, timeZone);
  return ms;
}

function calendarOf(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: Number(get('year')), month: Number(get('month')) - 1, day: Number(get('day')), weekday: get('weekday') };
}

/**
 * Year inference. The table shows month and day only, so the year is the one
 * (last, this or next) that puts the window nearest to now: a December row
 * read in January belongs to last month, not to eleven months ahead, and a
 * January row read in December rolls forward. rolledYear is true whenever the
 * chosen year is not the current one, so the caller can log it. An explicit
 * year in the cell wins.
 */
function inferYear(date, nowCal, timeZone, nowMs) {
  if (date.year) return { year: date.year, rolled: false };
  let best = null;
  for (const year of [nowCal.year - 1, nowCal.year, nowCal.year + 1]) {
    const distance = Math.abs(zonedMidnight(year, date.month, date.day, timeZone) - nowMs);
    if (!best || distance < best.distance) best = { year, distance };
  }
  return { year: best.year, rolled: best.year !== nowCal.year };
}

function windowFrom(dates, nowMs, timeZone, { openEnded = false } = {}) {
  const first = dates[0];
  const last = dates[dates.length - 1];
  const nowCal = calendarOf(nowMs, timeZone);
  const start = inferYear(first, nowCal, timeZone, nowMs);
  const startsAt = zonedMidnight(start.year, first.month, first.day, timeZone);
  if (openEnded) return { startsAt, endsAt: startsAt + OPEN_ENDED_MS, rolledYear: start.rolled, openEnded: true };
  let endYear = last.year ?? start.year;
  if (!last.year && (last.month < first.month || (last.month === first.month && last.day < first.day))) {
    endYear = start.year + 1; // "Dec. 28 - Jan. 3"
  }
  const endsAt = zonedMidnight(endYear, last.month, last.day, timeZone) + DAY_MS - 1;
  if (endsAt < startsAt) return null;
  return { startsAt, endsAt, rolledYear: start.rolled, openEnded: false };
}

/**
 * Schedule page HTML -> array of windows, or null when no schedule table can
 * be read. Pure.
 *
 *   { lines: ['Red', ...], startsAt, endsAt, description, rolledYear }
 *
 * startsAt is local midnight opening the first day; endsAt is the last
 * millisecond of the last day, so [startsAt, endsAt] is closed. Date forms
 * read, all without a year unless one is printed:
 *
 *   two columns   Start "Sept. 19"  End "Sept. 20"          (live, 2026-09-16)
 *   single day    "Sept. 19"  "Sat., Sept. 19"  "September 19, 2026"
 *   same month    "Sept. 27-28"  "Oct. 3 - 5"  "Oct. 3 to 5"  (en/em dash too)
 *   cross month   "Nov. 26 - Dec. 1"  "Dec. 28 through Jan. 3"
 *   open-ended    Start "Sept. 19"  End "Until further notice" (or "TBD", or
 *                 empty): openEnded true, endsAt OPEN_ENDED_MS after the start
 *
 * Null (unknown) rather than a guess when: no table has a header naming a
 * line column and a date column; a data row has cells but no readable date;
 * a data row names no recognisable line. A single-cell row ("No track work
 * scheduled") is a note and is skipped, so a table of notes is [] (a real
 * clear).
 */
export function parseTrackwork(html, { now = Date.now(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (typeof html !== 'string') return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  for (const table of tables(html)) {
    const rows = pieces(table, 'tr');
    if (rows.length === 0) continue;
    const headerAt = rows.findIndex((r) => /<th\b/i.test(r));
    if (headerAt < 0) continue;
    const cols = columnsFrom(cells(rows[headerAt]));
    if (!cols) continue;

    const windows = [];
    for (const row of rows.slice(headerAt + 1)) {
      const c = cells(row);
      if (c.length <= 1) continue; // a note row, not a window
      if (c.length <= Math.max(cols.start, cols.line, cols.end)) return null;
      const dates = datesIn(textOf(c[cols.start]));
      let openEnded = false;
      if (cols.end >= 0) {
        const endDates = datesIn(textOf(c[cols.end]));
        // A start with no readable end is open, not a single day: the page
        // says the work has no end the reader can plan around.
        if (endDates.length === 0 && dates.length > 0) openEnded = true;
        dates.push(...endDates);
      }
      if (dates.length === 0) return null;
      const lines = linesIn(c[cols.line]);
      if (lines.length === 0) return null;
      const span = windowFrom(dates, nowMs, timeZone, { openEnded });
      if (!span) return null;
      const impact = cols.impact >= 0 && c[cols.impact] ? textOf(c[cols.impact]) : '';
      const work = cols.work >= 0 && c[cols.work] ? textOf(c[cols.work]) : '';
      windows.push({ lines, ...span, description: [impact, work].filter(Boolean).join(' - ') || 'planned track work' });
    }
    return windows;
  }
  return null;
}

const intersects = (window, lines) => window.lines.some((l) => lines.includes(l));

/**
 * Windows on any of `lines` whose [startsAt, endsAt] overlaps
 * [now, now + horizonHours]. Both bounds inclusive.
 */
export function relevantWindows(windows, lines, { now = Date.now(), horizonHours = 24 } = {}) {
  if (!Array.isArray(windows)) return [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const until = nowMs + horizonHours * 60 * 60 * 1000;
  const wanted = Array.isArray(lines) ? lines : [];
  return windows.filter((w) => intersects(w, wanted) && w.startsAt <= until && w.endsAt >= nowMs);
}

function spokenLines(lines) {
  if (lines.length === 1) return `the ${lines[0]} Line`;
  return `the ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]} Lines`;
}

function spokenDay(ms, nowMs, timeZone) {
  const cal = calendarOf(ms, timeZone);
  const nowCal = calendarOf(nowMs, timeZone);
  if (cal.year === nowCal.year && cal.month === nowCal.month && cal.day === nowCal.day) return 'today';
  const tomorrow = calendarOf(nowMs + DAY_MS, timeZone);
  if (cal.year === tomorrow.year && cal.month === tomorrow.month && cal.day === tomorrow.day) return 'tomorrow';
  if (Math.abs(ms - nowMs) < 6 * DAY_MS) return cal.weekday;
  return `${MONTHS[cal.month][0].replace(/^./, (ch) => ch.toUpperCase())} ${cal.day}`;
}

function describe(window, lines, nowMs, timeZone) {
  const named = window.lines.filter((l) => lines.includes(l));
  const who = spokenLines(named.length > 0 ? named : window.lines);
  if (window.openEnded) {
    return window.startsAt <= nowMs
      ? `planned track work on ${who} until further notice`
      : `planned track work on ${who} from ${spokenDay(window.startsAt, nowMs, timeZone)} until further notice`;
  }
  if (window.startsAt <= nowMs) {
    return `planned track work on ${who} through ${spokenDay(window.endsAt, nowMs, timeZone)}`;
  }
  const from = spokenDay(window.startsAt, nowMs, timeZone);
  const through = spokenDay(window.endsAt, nowMs, timeZone);
  return from === through ? `planned track work on ${who} ${from}` : `planned track work on ${who} from ${from} through ${through}`;
}

/** The unknown shape: every count null, the reason naming the failure class. */
export function unknownTrackwork(reason) {
  return { active: null, upcoming: null, staleWindows: null, reasons: [`${UNKNOWN_REASON}: ${reason}`], score: null, unknown: true };
}

const unknown = unknownTrackwork;

// Stale is distinct from unavailable, as in closures.js: the page answered,
// and what it listed disqualifies it (rule 5).
function stale() {
  return { ...unknown(''), reasons: [STALE_REASON] };
}

/**
 * Reduce parsed windows to one planned-disruption signal for `lines`.
 *
 * active        windows on those lines covering now, or null when input is null
 * upcoming      windows on those lines starting within 7 days
 * staleWindows  windows (any line) whose start has passed. The orchestrator
 *               compares this with the live incidents feed: a started window
 *               with no matching incident lowers trust in the scrape. Counted
 *               only; no penalty here.
 * reasons       spoken strings, active first, then upcoming
 * score         always null: this signal moves confidence, not the verdict
 * unknown       false here; true only from unknown()
 */
export function assessTrackwork(windows, lines, { now = Date.now(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!Array.isArray(windows)) return unknown('no data');
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const wanted = Array.isArray(lines) ? lines : [];
  const activeList = [];
  const upcomingList = [];
  let staleWindows = 0;
  for (const w of windows) {
    if (w.startsAt <= nowMs) staleWindows += 1;
    if (!intersects(w, wanted)) continue;
    if (w.startsAt <= nowMs && w.endsAt >= nowMs) activeList.push(w);
    else if (w.startsAt > nowMs && w.startsAt <= nowMs + WEEK_MS) upcomingList.push(w);
  }
  return {
    active: activeList.length,
    upcoming: upcomingList.length,
    staleWindows,
    reasons: [...activeList, ...upcomingList].map((w) => describe(w, wanted, nowMs, timeZone)),
    score: null,
    unknown: false,
  };
}

/**
 * Rule 5, first test, for a page with no publication date: the source is
 * live if any window is still in the future or ended within STALE_AFTER_MS.
 * A page listing only windows that ended months ago is unmaintained. An
 * empty list is not stale; it is a clear.
 */
export function sourceIsStale(windows, now = Date.now()) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return !windows.some((w) => w.startsAt > nowMs || w.endsAt >= nowMs - STALE_AFTER_MS);
}

/**
 * Fetch the schedule page and assess it for `lines`. Never throws. Any
 * failure is the unknown shape with a reason naming the failure class; an
 * unreadable table is unknown too, and distinct from a readable table with
 * no rows (active 0). Windows whose year was inferred as not the current
 * one are reported through the optional `log` callback, one line each.
 */
export async function fetchTrackwork(lines, fetchImpl = fetch, { now = Date.now(), timeZone = DEFAULT_TIME_ZONE, log = null, signal } = {}) {
  try {
    const { text: html, error } = await getText(TRACKWORK_URL, { fetchImpl, signal });
    if (error) return unknown(error);

    const windows = parseTrackwork(html, { now, timeZone });
    if (windows === null) return unknown('no readable schedule table');
    if (sourceIsStale(windows, now)) return stale();

    if (typeof log === 'function') {
      for (const w of windows) {
        if (w.rolledYear) {
          log(`trackwork: year inferred for ${w.lines.join('/')} window starting ${new Date(w.startsAt).toISOString()}`);
        }
      }
    }
    return assessTrackwork(windows, lines, { now, timeZone });
  } catch (cause) {
    return unknown(`unexpected error (${cause?.name ?? 'Error'})`);
  }
}

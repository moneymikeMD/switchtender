// The [ride] block (CMB-151): when a Metro ride may start, where the phone's
// GPS fixes are wanted, and which legs the ride tracker follows.
//
// Pure: parses the block out of the raw TOML, judges a fence time against a
// leg's window in the route's zone, and computes the GPS window the phone is
// told to send fixes over. No network, no clock of its own.

import { ConfigError } from '../config.js';
import { localTime } from '../log.js';
import { LINES } from '../trackwork.js';

export const LEGS = Object.freeze(['am', 'pm']);

const DEFAULTS = { am: { start: '05:30', end: '10:00', gps_window_mins: 25 }, pm: { start: '16:30', end: '22:30', gps_window_mins: 5 } };

const WEEKEND = new Set(['Saturday', 'Sunday']);

// Once a fence time is this far from the server clock it is a late delivery
// or a wrong phone clock, not a ride that is starting now.
export const MAX_FENCE_AGE_MS = 2 * 60 * 1000;

function clock(value, path) {
  if (typeof value !== 'string') {
    throw new ConfigError(`config: key "${path}" should be a 24-hour clock time like "17:30", got ${JSON.stringify(value)}`);
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new ConfigError(`config: key "${path}" should be a 24-hour clock time like "17:30", got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function nonNegative(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`config: key "${path}" should be a number of zero or more, got ${JSON.stringify(value)}`);
  }
  return value;
}

function legEntry(raw, path) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`config: ${path} should be a table`);
  }
  for (const k of ['line', 'board', 'alight']) {
    if (typeof raw[k] !== 'string' || raw[k].trim() === '') {
      throw new ConfigError(`config: ${path}.${k} should be a non-empty string`);
    }
  }
  const wanted = raw.line
    .trim()
    .replace(/\s+line$/i, '')
    .toLowerCase();
  const line = LINES.find((name) => name.toLowerCase() === wanted);
  if (!line) {
    throw new ConfigError(`config: ${path}.line ${JSON.stringify(raw.line)} is not a known line; use one of ${LINES.join(', ')}`);
  }
  return { line, board: raw.board.trim(), alight: raw.alight.trim() };
}

function legBlock(raw, leg) {
  const block = raw[leg] ?? {};
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError(`config: [ride.${leg}] should be a table`);
  }
  const d = DEFAULTS[leg];
  const start = block.start === undefined ? d.start : clock(block.start, `ride.${leg}.start`);
  const end = block.end === undefined ? d.end : clock(block.end, `ride.${leg}.end`);
  if (minutesOf(start) >= minutesOf(end)) {
    throw new ConfigError(`config: ride.${leg} window ${start}-${end} ends before it starts`);
  }
  const legs = block.legs ?? [];
  if (!Array.isArray(legs)) {
    throw new ConfigError(`config: ride.${leg}.legs should be an array of tables`);
  }
  return {
    start,
    end,
    gps_window_mins: nonNegative(block.gps_window_mins, `ride.${leg}.gps_window_mins`, d.gps_window_mins),
    legs: legs.map((l, i) => legEntry(l, `ride.${leg}.legs[${i}]`)),
  };
}

/** Parse `[ride]` from raw TOML. Null when the block is absent: no rides, and the ride endpoints answer 503. */
export function rideBlock(raw) {
  const block = raw.ride;
  if (block === undefined) return null;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new ConfigError('config: [ride] should be a table');
  }
  const sheet_tab = block.sheet_tab ?? 'rides';
  if (typeof sheet_tab !== 'string' || sheet_tab.trim() === '') {
    throw new ConfigError(`config: key "ride.sheet_tab" should be a non-empty string, got ${JSON.stringify(sheet_tab)}`);
  }
  return { sheet_tab, am: legBlock(block, 'am'), pm: legBlock(block, 'pm') };
}

/**
 * Is `at` inside the leg's weekday window in `timeZone`? Returns
 * { inside, localDate, local } where local is "HH:MM" and the reason, when
 * outside, names the weekend or the window.
 */
export function judgeWindow({ at, leg, ride, timeZone }) {
  const t = localTime(at, timeZone);
  const local = t.timestamp.slice(11, 16);
  const window = ride[leg];
  if (WEEKEND.has(t.weekday)) return { inside: false, reason: `${t.weekday} is not a weekday`, localDate: t.localDate, local };
  const m = minutesOf(local);
  if (m < minutesOf(window.start) || m >= minutesOf(window.end)) {
    return { inside: false, reason: `${local} is outside the ${leg} window ${window.start}-${window.end}`, localDate: t.localDate, local };
  }
  return { inside: true, reason: null, localDate: t.localDate, local };
}

/**
 * When the phone should send fixes. The morning window opens after the walk
 * from the lot to the platform and runs for the leg's gps_window_mins; the
 * evening window opens at the fence.
 */
export function gpsWindow({ at, leg, ride, walkMins = 0 }) {
  const delay = leg === 'am' ? walkMins : 0;
  const from = new Date(at.getTime() + delay * 60_000);
  const until = new Date(from.getTime() + ride[leg].gps_window_mins * 60_000);
  return { from, until };
}

// Configuration loading.
//
// The one rule this module exists to enforce: the engine holds no coordinates.
// Everything describing a commute comes from a TOML file, and every secret
// comes from the environment. Neither is ever baked into source.
//
// Failure behaviour is deliberately asymmetric. A missing required key is
// fatal at startup, because a tool that silently runs without its routing key
// produces a confident answer from nothing. A missing optional key degrades a
// single signal and lowers confidence, because losing the weather feed should
// not stop the thing from telling you which way to go.

import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

import { LINES } from './trackwork.js';

/** Secrets, and what losing each one costs. */
export const SECRETS = {
  ROUTES_API_KEY: { required: true, signal: 'routing' },
  TRAFFIC_API_KEY: { required: false, signal: 'live incidents' },
  EVENTS_API_KEY: { required: false, signal: 'scheduled events' },
  TRANSIT_API_KEY: { required: false, signal: 'rail alerts' }, // CMB-35, src/wmata.js
};

// Every place in [route] has one shape (CMB-33): where it is, what to call it,
// and minutes on foot added to any leg that ends there. `parking` is the only
// optional one. The keys are closed: an unknown key is an error naming it, so
// a renamed or misspelt field cannot silently become a zero.
export const PLACES = ['origin', 'decision_point', 'park_and_ride', 'parking', 'destination'];
export const OPTIONAL_PLACES = ['parking'];
export const PLACE_KEYS = Object.freeze(['lat', 'lon', 'label', 'addl_walk_mins']);
const RENAMED_PLACE_KEYS = { park_to_platform_minutes: 'addl_walk_mins', walk_to_destination_minutes: 'addl_walk_mins' };

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function must(obj, path, kind) {
  const value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (value === undefined || value === null) {
    throw new ConfigError(`config: missing required key "${path}"`);
  }
  if (kind && typeof value !== kind) {
    throw new ConfigError(`config: key "${path}" should be ${kind}, got ${typeof value}`);
  }
  // TOML admits nan and inf as numbers. Neither is a distance or a margin.
  if (kind === 'number' && !Number.isFinite(value)) {
    throw new ConfigError(`config: key "${path}" should be a finite number, got ${value}`);
  }
  return value;
}

// An IANA zone name the runtime knows. Anything else passes typeof and then
// throws RangeError from Intl on every verdict, after the routing calls have
// been paid for; the startup check is where that belongs.
function timeZone(raw) {
  const zone = must(raw, 'route.timezone', 'string');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new ConfigError(`config: route.timezone "${zone}" is not a known IANA time zone`);
  }
  return zone;
}

// "HH:MM" on a 24-hour clock. events.js parses the same shape; a value it
// cannot read costs the events signal on every run with no startup error.
function clockTime(raw, path) {
  const value = must(raw, path, 'string');
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new ConfigError(`config: key "${path}" should be a 24-hour clock time like "17:30", got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/** Build one place from `[route.<name>]`. Null for an absent optional place. */
export function place(raw, name) {
  if (raw.route?.[name] === undefined && OPTIONAL_PLACES.includes(name)) return null;
  const p = must(raw, `route.${name}`, 'object');
  for (const key of Object.keys(p)) {
    if (PLACE_KEYS.includes(key)) continue;
    const hint = RENAMED_PLACE_KEYS[key] ? ` (renamed to "${RENAMED_PLACE_KEYS[key]}")` : '';
    throw new ConfigError(`config: route.${name} has unknown key "${key}"${hint}; a place takes ${PLACE_KEYS.join(', ')}`);
  }
  const lat = must(raw, `route.${name}.lat`, 'number');
  const lon = must(raw, `route.${name}.lon`, 'number');
  // A coordinate outside these ranges is a transposed lat/lon far more often
  // than it is a real place, and the failure is otherwise silent: the engine
  // happily routes to the Southern Ocean and reports a very long drive.
  if (lat < -90 || lat > 90) {
    throw new ConfigError(`config: route.${name}.lat ${lat} is out of range`);
  }
  if (lon < -180 || lon > 180) {
    throw new ConfigError(`config: route.${name}.lon ${lon} is out of range`);
  }
  const addl_walk_mins = p.addl_walk_mins ?? 0;
  if (typeof addl_walk_mins !== 'number' || !Number.isFinite(addl_walk_mins) || addl_walk_mins < 0) {
    throw new ConfigError(`config: route.${name}.addl_walk_mins should be a number of zero or more, got ${JSON.stringify(addl_walk_mins)}`);
  }
  return { lat, lon, label: must(raw, `route.${name}.label`, 'string'), addl_walk_mins };
}

// The verdict log (CMB-11). Optional as a block: a config without [log]
// simply does not log. Enabled, it needs somewhere to write to.
function logBlock(raw) {
  const block = raw.log ?? {};
  if (typeof block !== 'object') {
    throw new ConfigError('config: [log] should be a table');
  }
  const enabled = block.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new ConfigError(`config: key "log.enabled" should be boolean, got ${typeof enabled}`);
  }
  const sheet_tab = block.sheet_tab ?? 'verdicts';
  if (typeof sheet_tab !== 'string') {
    throw new ConfigError(`config: key "log.sheet_tab" should be string, got ${typeof sheet_tab}`);
  }
  const arrivals_tab = block.arrivals_tab ?? 'arrivals';
  if (typeof arrivals_tab !== 'string') {
    throw new ConfigError(`config: key "log.arrivals_tab" should be string, got ${typeof arrivals_tab}`);
  }
  if (arrivals_tab === sheet_tab) {
    throw new ConfigError('config: log.arrivals_tab and log.sheet_tab must differ; arrivals have their own columns');
  }
  const sheet_id = enabled ? must(raw, 'log.sheet_id', 'string') : (block.sheet_id ?? null);
  if (sheet_id !== null && typeof sheet_id !== 'string') {
    throw new ConfigError(`config: key "log.sheet_id" should be string, got ${typeof sheet_id}`);
  }
  return { enabled, sheet_id, sheet_tab, arrivals_tab };
}

// Where the deployed service answers. Optional and never printed by the
// service; it exists so the real hostname lives in the gitignored config
// rather than in this public repo's docs or macro export.
function serviceBlock(raw) {
  const block = raw.service ?? {};
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError('config: [service] should be a table');
  }
  const url = block.url ?? null;
  if (url === null) return { url: null };
  if (typeof url !== 'string') {
    throw new ConfigError(`config: key "service.url" should be string, got ${typeof url}`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`config: service.url is not a URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || url.endsWith('/')) {
    throw new ConfigError('config: service.url should be an https origin with no path, query or trailing slash');
  }
  return { url };
}

// The transit leg (CMB-26). Optional: a config without [transit] names no rail
// lines, so the planned track-work feed has nothing to match and stays quiet.
// Names are matched to the schedule page's canonical spelling here, so
// "red", "Red Line" and "RED" all load as "Red", and a line the page does not
// know is an error rather than a signal that quietly reports clear forever.
function transitBlock(raw) {
  const block = raw.transit ?? {};
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError('config: [transit] should be a table');
  }
  const lines = block.lines ?? [];
  if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string' || l.trim() === '')) {
    throw new ConfigError('config: key "transit.lines" should be an array of non-empty strings');
  }
  const canonical = lines.map((l) => {
    const wanted = l
      .trim()
      .replace(/\s+line$/i, '')
      .toLowerCase();
    const found = LINES.find((name) => name.toLowerCase() === wanted);
    if (!found) {
      throw new ConfigError(`config: transit.lines entry ${JSON.stringify(l)} is not a known line; use one of ${LINES.join(', ')}`);
    }
    return found;
  });
  return { lines: [...new Set(canonical)] };
}

// Event providers a venue can name (CMB-25). Ticketmaster is the default and
// needs EVENTS_API_KEY; "mlb" reads the keyless MLB schedule for one club and
// replaces the ticketing source for that venue, because MLB sells through its
// own platform and a ballpark is invisible to Ticketmaster.
export const VENUE_PROVIDERS = ['ticketmaster', 'mlb'];

function venueEntry(v, i) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError(`config: venues[${i}] should be a table`);
  }
  for (const k of ['name', 'lat', 'lon', 'weight']) {
    if (v[k] === undefined) {
      throw new ConfigError(`config: venues[${i}] is missing "${k}"`);
    }
  }
  if (typeof v.name !== 'string' || v.name.trim() === '') {
    throw new ConfigError(`config: venues[${i}].name should be a non-empty string`);
  }
  for (const [k, limit] of [
    ['lat', 90],
    ['lon', 180],
  ]) {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) {
      throw new ConfigError(`config: venues[${i}].${k} should be a number, got ${JSON.stringify(v[k])}`);
    }
    if (v[k] < -limit || v[k] > limit) {
      throw new ConfigError(`config: venues[${i}].${k} ${v[k]} is out of range`);
    }
  }
  if (typeof v.weight !== 'number' || !Number.isFinite(v.weight) || v.weight < 0) {
    throw new ConfigError(`config: venues[${i}].weight should be a number of zero or more, got ${JSON.stringify(v.weight)}`);
  }
  const provider = v.provider ?? 'ticketmaster';
  if (!VENUE_PROVIDERS.includes(provider)) {
    throw new ConfigError(`config: venues[${i}].provider should be one of ${VENUE_PROVIDERS.join(', ')}, got ${JSON.stringify(provider)}`);
  }
  let mlb_team_id = null;
  if (provider === 'mlb') {
    if (v.mlb_team_id === undefined) {
      throw new ConfigError(`config: venues[${i}] has provider "mlb" and is missing "mlb_team_id"`);
    }
    if (!Number.isInteger(v.mlb_team_id) || v.mlb_team_id <= 0) {
      throw new ConfigError(`config: venues[${i}].mlb_team_id should be a positive integer`);
    }
    mlb_team_id = v.mlb_team_id;
  } else if (v.mlb_team_id !== undefined) {
    throw new ConfigError(`config: venues[${i}].mlb_team_id is only meaningful with provider = "mlb"`);
  }
  let ticketmaster_venue_id = null;
  if (v.ticketmaster_venue_id !== undefined) {
    if (provider !== 'ticketmaster') {
      throw new ConfigError(`config: venues[${i}].ticketmaster_venue_id is only meaningful with provider = "ticketmaster"`);
    }
    if (typeof v.ticketmaster_venue_id !== 'string' || v.ticketmaster_venue_id.trim() === '') {
      throw new ConfigError(`config: venues[${i}].ticketmaster_venue_id should be a non-empty string`);
    }
    ticketmaster_venue_id = v.ticketmaster_venue_id.trim();
  }
  return { name: v.name, lat: v.lat, lon: v.lon, weight: v.weight, provider, mlb_team_id, ticketmaster_venue_id };
}

function margin(raw) {
  const value = must(raw, 'decision.minimum_drive_margin_minutes', 'number');
  if (value < 0) {
    throw new ConfigError(`config: decision.minimum_drive_margin_minutes should be zero or more, got ${value}`);
  }
  return value;
}

/** Parse and validate TOML text. Separated from file reading so it is testable. */
export function parseConfig(text) {
  let raw;
  try {
    raw = parse(text);
  } catch (cause) {
    throw new ConfigError(`config: could not parse TOML (${cause.message})`);
  }

  const route = Object.fromEntries(PLACES.map((n) => [n, place(raw, n)]));
  route.timezone = timeZone(raw);

  const bbox = {
    min_lon: must(raw, 'incidents.min_lon', 'number'),
    min_lat: must(raw, 'incidents.min_lat', 'number'),
    max_lon: must(raw, 'incidents.max_lon', 'number'),
    max_lat: must(raw, 'incidents.max_lat', 'number'),
  };
  if (bbox.min_lon >= bbox.max_lon || bbox.min_lat >= bbox.max_lat) {
    throw new ConfigError('config: incidents bounding box has min greater than or equal to max');
  }

  const venues = (raw.venues ?? []).map((v, i) => venueEntry(v, i));

  return {
    route,
    service: serviceBlock(raw),
    log: logBlock(raw),
    transit: transitBlock(raw),
    trigger: { lead_miles: must(raw, 'trigger.lead_miles', 'number') },
    decision: {
      transit_wins_ties: must(raw, 'decision.transit_wins_ties', 'boolean'),
      minimum_drive_margin_minutes: margin(raw),
      assumed_evening_departure: clockTime(raw, 'decision.assumed_evening_departure'),
    },
    incidents: bbox,
    venues,
  };
}

/**
 * Resolve secrets from an environment object.
 *
 * Returns the keys present plus a list of signals that are unavailable because
 * their optional key is missing. Callers surface that list as reduced
 * confidence rather than as an error.
 */
export function loadSecrets(env = process.env) {
  const keys = {};
  const degraded = [];
  for (const [name, { required, signal }] of Object.entries(SECRETS)) {
    // Trimmed: a secret manager or a shell pipeline can leave a trailing
    // newline on a value, and an API key with a stray byte is a wrong key.
    const value = typeof env[name] === 'string' ? env[name].trim() : env[name];
    if (value) {
      keys[name] = value;
    } else if (required) {
      throw new ConfigError(`config: required environment variable ${name} is not set, so ${signal} is unavailable and no verdict is possible`);
    } else {
      degraded.push(signal);
    }
  }
  return { keys, degraded };
}

/** Read and validate a config file from disk. */
export function loadConfig(path, env = process.env) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`config: could not read ${path} (${cause.code})`);
  }
  return { ...parseConfig(text), secrets: loadSecrets(env) };
}

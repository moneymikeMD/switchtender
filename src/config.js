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

/** Secrets, and what losing each one costs. */
export const SECRETS = {
  ROUTES_API_KEY: { required: true, signal: 'routing' },
  TRAFFIC_API_KEY: { required: false, signal: 'live incidents' },
  EVENTS_API_KEY: { required: false, signal: 'scheduled events' },
  TRANSIT_API_KEY: { required: false, signal: 'rail alerts' },
};

const PLACES = ['origin', 'decision_point', 'park_and_ride', 'destination'];

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
    throw new ConfigError(
      `config: key "${path}" should be ${kind}, got ${typeof value}`,
    );
  }
  return value;
}

function place(raw, name) {
  const p = must(raw, `route.${name}`, 'object');
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
  return { lat, lon, label: must(raw, `route.${name}.label`, 'string') };
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
  const sheet_id = enabled ? must(raw, 'log.sheet_id', 'string') : block.sheet_id ?? null;
  if (sheet_id !== null && typeof sheet_id !== 'string') {
    throw new ConfigError(`config: key "log.sheet_id" should be string, got ${typeof sheet_id}`);
  }
  return { enabled, sheet_id, sheet_tab };
}

// The transit leg (CMB-26). Optional: a config without [transit] names no rail
// lines, so the planned track-work feed has nothing to match and stays quiet.
function transitBlock(raw) {
  const block = raw.transit ?? {};
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError('config: [transit] should be a table');
  }
  const lines = block.lines ?? [];
  if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string' || l.trim() === '')) {
    throw new ConfigError('config: key "transit.lines" should be an array of non-empty strings');
  }
  return { lines: lines.map((l) => l.trim()) };
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
  route.timezone = must(raw, 'route.timezone', 'string');
  route.park_and_ride.park_to_platform_minutes = must(
    raw,
    'route.park_and_ride.park_to_platform_minutes',
    'number',
  );

  const bbox = {
    min_lon: must(raw, 'incidents.min_lon', 'number'),
    min_lat: must(raw, 'incidents.min_lat', 'number'),
    max_lon: must(raw, 'incidents.max_lon', 'number'),
    max_lat: must(raw, 'incidents.max_lat', 'number'),
  };
  if (bbox.min_lon >= bbox.max_lon || bbox.min_lat >= bbox.max_lat) {
    throw new ConfigError(
      'config: incidents bounding box has min greater than or equal to max',
    );
  }

  const venues = (raw.venues ?? []).map((v, i) => {
    for (const k of ['name', 'lat', 'lon', 'weight']) {
      if (v[k] === undefined) {
        throw new ConfigError(`config: venues[${i}] is missing "${k}"`);
      }
    }
    return { name: v.name, lat: v.lat, lon: v.lon, weight: v.weight };
  });

  return {
    route,
    log: logBlock(raw),
    transit: transitBlock(raw),
    trigger: { lead_miles: must(raw, 'trigger.lead_miles', 'number') },
    decision: {
      transit_wins_ties: must(raw, 'decision.transit_wins_ties', 'boolean'),
      minimum_drive_margin_minutes: must(
        raw,
        'decision.minimum_drive_margin_minutes',
        'number',
      ),
      assumed_evening_departure: must(
        raw,
        'decision.assumed_evening_departure',
        'string',
      ),
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
    const value = env[name];
    if (value) {
      keys[name] = value;
    } else if (required) {
      throw new ConfigError(
        `config: required environment variable ${name} is not set, so ${signal} is unavailable and no verdict is possible`,
      );
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

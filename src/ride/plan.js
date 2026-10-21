// The plan for one ride leg (CMB-152): which WMATA line and stations a
// configured [[ride.<leg>.legs]] entry means, which station to alert at, and
// the words the alerts and status pushes use. Pure: config and the circuit
// index in, a plan out. The morning plan is the only one built today; the
// evening leg (`pm`) is held back until the underground-GPS redesign.

import { ConfigError } from '../config.js';

export const LINE_CODES = Object.freeze({ Red: 'RD', Orange: 'OR', Blue: 'BL', Green: 'GR', Yellow: 'YL', Silver: 'SV' });
export const MAX_LEGS = 2;
export const CANDIDATES_PER_LEG = 2;
export const TRANSFER_GAP_MS = 2 * 60 * 1000;

function trackFor(index, line, board, alight) {
  for (const track of index.tracks.values()) {
    if (track.line !== line) continue;
    const from = track.stations.find((s) => s.code === board);
    const to = track.stations.find((s) => s.code === alight);
    if (from && to && from.seq !== to.seq) return { track, from, to, dir: to.seq > from.seq ? 1 : -1 };
  }
  return null;
}

/**
 * Resolve one configured leg against the circuit index. Throws ConfigError
 * when a code is missing, unknown to the index, or the alert station is not
 * between board and alight.
 */
export function planLeg(leg, index, path) {
  const line = LINE_CODES[leg.line];
  if (!line || !index.lines.includes(line))
    throw new ConfigError(`config: ${path}.line ${JSON.stringify(leg.line)} is not a line the tracker follows (${index.lines.join(', ')})`);
  for (const k of ['board_code', 'alight_code']) {
    if (!leg[k]) throw new ConfigError(`config: ${path}.${k} is required for the ride tracker`);
  }
  const found = trackFor(index, line, leg.board_code, leg.alight_code);
  if (!found) throw new ConfigError(`config: ${path}: no ${leg.line} track runs from ${leg.board_code} to ${leg.alight_code}`);
  const { track, from, to, dir } = found;
  const between = track.stations.filter((s) => (dir === 1 ? s.seq >= from.seq && s.seq <= to.seq : s.seq <= from.seq && s.seq >= to.seq));
  const ordered = dir === 1 ? between : [...between].reverse();
  const alightAt = ordered.length - 1;
  let alert = leg.alert_code;
  if (alert) {
    const at = ordered.findIndex((s) => s.code === alert);
    if (at < 1 || at >= alightAt) throw new ConfigError(`config: ${path}.alert_code ${alert} is not between ${leg.board_code} and ${leg.alight_code}`);
  } else {
    if (alightAt < 2) throw new ConfigError(`config: ${path}: ${leg.board_code} and ${leg.alight_code} are adjacent; no station to alert at`);
    alert = ordered[alightAt - 1].code;
  }
  return {
    line,
    lineName: leg.line,
    board: leg.board_code,
    alight: leg.alight_code,
    alert,
    boardName: leg.board,
    alightName: leg.alight,
    dir,
    stations: ordered.map((s) => s.code),
  };
}

/**
 * The plan for a ride: `{ leg, legs }`, legs in riding order, each with
 * `alertKey(trainId)` and the alert text. Throws ConfigError for a leg the
 * tracker cannot run.
 */
export function buildPlan({ leg, legs, index, timeZone = 'UTC' }) {
  if (!Array.isArray(legs) || legs.length === 0) throw new ConfigError(`config: ride.${leg}.legs is empty; the tracker has nothing to follow`);
  if (legs.length > MAX_LEGS) throw new ConfigError(`config: ride.${leg}.legs has ${legs.length} legs; the tracker follows at most ${MAX_LEGS}`);
  const planned = legs.map((l, i) => ({ n: i, ...planLeg(l, index, `ride.${leg}.legs[${i}]`) }));
  return { leg, timeZone, legs: planned };
}

/** "8:14" in `timeZone` for an epoch-millisecond time. */
export function clockAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
}

/** The words for a leg's alert, naming the train's departure for every leg after the first. */
export function alertText(plan, n, departedAtMs = null) {
  const leg = plan.legs[n];
  const next = plan.legs[n + 1];
  let text = `Next stop ${leg.alightName}.`;
  if (next) text += ` Transfer to ${next.lineName}.`;
  if (n > 0 && Number.isFinite(departedAtMs)) text += ` You're on the ${clockAt(departedAtMs, plan.timeZone)} from ${leg.boardName}.`;
  return text;
}

/** The quiet status once the first leg's train is locked. */
export function lockText(plan, departedAtMs) {
  const leg = plan.legs[0];
  return Number.isFinite(departedAtMs)
    ? `Tracking the ${clockAt(departedAtMs, plan.timeZone)} from ${leg.boardName}`
    : `Tracking a train from ${leg.boardName}`;
}

export const NOT_TRACKING = 'Not tracking. Watch the stops.';

/** Is `train` (a tracker record) heading the way this leg goes? Unknown travel is not a yes. */
export function boundRight(train, leg) {
  return train?.line === leg.line && train.travel === leg.dir;
}

/** True once a train is at the station before its alert station or past it, so the poll rate should rise. */
export function nearAlert(index, train, leg) {
  if (!train || train.line !== leg.line || train.seq === null || train.track === null) return false;
  const track = index.tracks.get(`${leg.line}:${train.track}`);
  if (!track) return false;
  const at = track.stations.findIndex((s) => s.code === leg.alert);
  if (at < 0) return false;
  const prev = track.stations[at - leg.dir];
  const target = track.stations[at];
  if (!prev) return leg.dir === 1 ? train.seq <= target.seq : train.seq >= target.seq;
  return leg.dir === 1 ? train.seq >= prev.seq && train.seq <= target.seq : train.seq <= prev.seq && train.seq >= target.seq;
}

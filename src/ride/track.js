// Follow the owner's train through WMATA's TrainPositions feed (CMB-150).
// Pure: feed JSON and GPS fixes in, tracker state and alert events out. The
// caller (the ride Job, CMB-152) polls, persists `state` between polls, and
// decides which station arrivals to act on. Everything is SI: metres,
// metres per second, epoch milliseconds.

export const LINES = ['RD', 'GR'];
export const MAX_FIX_ACCURACY_M = 50;
export const MIN_FIX_SPEED_MS = 5;
export const LOST_AFTER_MISSED_POLLS = 2;

const TERMINAL_DEPARTURE_WINDOW = 15;
const TRAIL_LENGTH = 48;
const LOCK_MAX_MEAN_M = 500;
const LOCK_MARGIN_M = 300;
const LOCK_MIN_FIXES = 2;

/** km/h as the phone reports it to the m/s this module expects. */
export function kmhToMs(kmh) {
  return Number.isFinite(kmh) ? kmh / 3.6 : NaN;
}

const trackKey = (line, track) => `${line}:${track}`;

/**
 * Index StandardRoutes: circuit id -> { line, track, seq, station } plus the
 * ordered station list per track. Only `lines` (default RD and GR) are kept.
 */
export function buildCircuitIndex(standardRoutes, { lines = LINES } = {}) {
  const routes = Array.isArray(standardRoutes?.StandardRoutes) ? standardRoutes.StandardRoutes : standardRoutes;
  if (!Array.isArray(routes)) throw new TypeError('StandardRoutes: expected an array of routes');
  const circuits = new Map();
  const tracks = new Map();
  for (const route of routes) {
    if (!lines.includes(route?.LineCode)) continue;
    const key = trackKey(route.LineCode, route.TrackNum);
    const stations = [];
    let maxSeq = -Infinity;
    let minSeq = Infinity;
    for (const c of route.TrackCircuits ?? []) {
      const entry = { line: route.LineCode, track: route.TrackNum, seq: c.SeqNum, station: c.StationCode ?? null };
      circuits.set(c.CircuitId, entry);
      if (entry.station) stations.push({ code: entry.station, seq: c.SeqNum, circuit: c.CircuitId });
      if (c.SeqNum > maxSeq) maxSeq = c.SeqNum;
      if (c.SeqNum < minSeq) minSeq = c.SeqNum;
    }
    stations.sort((a, b) => a.seq - b.seq);
    tracks.set(key, { line: route.LineCode, track: route.TrackNum, stations, minSeq, maxSeq });
  }
  return { circuits, tracks, lines: [...lines] };
}

/** jStations -> Map of station code -> { lat, lon, name }. */
export function buildStationIndex(stations) {
  const list = Array.isArray(stations?.Stations) ? stations.Stations : stations;
  if (!Array.isArray(list)) throw new TypeError('jStations: expected an array of stations');
  const out = new Map();
  for (const s of list) {
    if (typeof s?.Code !== 'string' || !Number.isFinite(s.Lat) || !Number.isFinite(s.Lon)) continue;
    out.set(s.Code, { lat: s.Lat, lon: s.Lon, name: s.Name ?? s.Code });
  }
  return out;
}

/** Where a circuit sits, or null when StandardRoutes does not list it (a crossover, a yard). */
export function locate(index, circuitId) {
  return index.circuits.get(circuitId) ?? null;
}

function stationSeq(index, line, track, code) {
  const t = index.tracks.get(trackKey(line, track));
  return t?.stations.find((s) => s.code === code)?.seq ?? null;
}

/** Feed JSON -> plain train records for the indexed lines only. */
export function normaliseFeed(feed, { lines = LINES } = {}) {
  const list = Array.isArray(feed?.TrainPositions) ? feed.TrainPositions : feed;
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t.TrainId === 'string' && lines.includes(t.LineCode))
    .map((t) => ({
      id: t.TrainId,
      number: t.TrainNumber ?? null,
      circuit: t.CircuitId,
      directionNum: t.DirectionNum ?? null,
      destination: t.DestinationStationCode ?? null,
      line: t.LineCode,
      secondsAt: t.SecondsAtLocation ?? null,
      service: t.ServiceType ?? null,
    }));
}

export function emptyState() {
  return { polls: 0, lastPollAt: null, trains: {} };
}

function travelFrom(index, loc, destination, previous) {
  if (!loc) return previous ?? null;
  const dest = destination ? stationSeq(index, loc.line, loc.track, destination) : null;
  if (dest !== null && dest !== loc.seq) return dest > loc.seq ? 1 : -1;
  return previous ?? null;
}

function newTrain(t, at) {
  return {
    id: t.id,
    number: t.number,
    line: t.line,
    service: t.service,
    directionNum: t.directionNum,
    pendingDirectionNum: null,
    destination: t.destination,
    circuit: t.circuit,
    track: null,
    seq: null,
    travel: null,
    station: null,
    stationPolls: 0,
    firstSeenAt: at,
    lastSeenAt: at,
    missed: 0,
    departures: {},
    pendingDepartures: {},
    arrivals: {},
    trail: [],
  };
}

function stationsPassed(index, train, prevLoc, loc) {
  const trackInfo = index.tracks.get(trackKey(loc.line, loc.track));
  if (!trackInfo) return [];
  const passed = [];
  if (prevLoc && prevLoc.line === loc.line && prevLoc.track === loc.track && prevLoc.seq !== loc.seq) {
    const [lo, hi] = prevLoc.seq < loc.seq ? [prevLoc.seq, loc.seq] : [loc.seq, prevLoc.seq];
    const forward = prevLoc.seq < loc.seq;
    for (const s of trackInfo.stations) {
      if (forward ? s.seq >= lo && s.seq < hi : s.seq > lo && s.seq <= hi) passed.push({ code: s.code, seq: s.seq, forward });
    }
  } else if (!prevLoc || prevLoc.line !== loc.line || prevLoc.track !== loc.track) {
    const first = trackInfo.stations[0];
    const last = trackInfo.stations.at(-1);
    if (first && train.travel !== -1 && loc.seq > first.seq && loc.seq - first.seq <= TERMINAL_DEPARTURE_WINDOW) passed.push({ ...first, forward: true });
    if (last && train.travel !== 1 && loc.seq < last.seq && last.seq - loc.seq <= TERMINAL_DEPARTURE_WINDOW) passed.push({ ...last, forward: false });
  }
  return passed.filter((s) => s.code !== train.destination && !train.departures[s.code]);
}

// A departure is confirmed on the second consecutive poll past the station
// circuit: live data showed a train blip to seq 2 and sit at seq 1 for 2 min.
function recordDepartures(index, train, prevLoc, loc, at, events) {
  for (const [code, pending] of Object.entries(train.pendingDepartures)) {
    const past = pending.track === loc.track && pending.line === loc.line && (pending.forward ? loc.seq > pending.seq : loc.seq < pending.seq);
    delete train.pendingDepartures[code];
    if (!past || train.departures[code]) continue;
    train.departures[code] = pending.at;
    events.push({ type: 'departure', trainId: train.id, line: loc.line, track: loc.track, station: code, at: pending.at });
  }
  for (const s of stationsPassed(index, train, prevLoc, loc)) {
    train.pendingDepartures[s.code] = { at, line: loc.line, track: loc.track, seq: s.seq, forward: s.forward };
  }
}

/**
 * Fold one feed poll into `state`. Returns `{ state, events }`, where events
 * are `arrival`, `departure` and `lost` records; `state` is a new object.
 */
export function observe(state, feed, index, at = Date.now()) {
  const prev = state ?? emptyState();
  const next = { polls: prev.polls + 1, lastPollAt: at, trains: {} };
  const events = [];
  const seen = new Set();

  for (const t of normaliseFeed(feed, { lines: index.lines })) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const old = prev.trains[t.id];
    const train = old ? structuredClone(old) : newTrain(t, at);
    const wasNew = !old;
    train.lastSeenAt = at;
    train.missed = 0;
    train.number = t.number;
    train.destination = t.destination;

    if (t.service === 'NoPassengers') {
      events.push({ type: 'lost', trainId: t.id, reason: 'no-passengers', at });
      continue;
    }
    train.service = t.service;

    if (t.directionNum !== train.directionNum) {
      if (train.pendingDirectionNum === t.directionNum) {
        train.directionNum = t.directionNum;
        train.pendingDirectionNum = null;
      } else train.pendingDirectionNum = t.directionNum;
    } else train.pendingDirectionNum = null;

    const prevLoc = train.seq === null ? null : { line: train.line, track: train.track, seq: train.seq };
    const loc = locate(index, t.circuit);
    train.circuit = t.circuit;
    if (loc) {
      train.line = loc.line;
      train.track = loc.track;
      train.seq = loc.seq;
      train.travel = travelFrom(index, loc, t.destination, prevLoc && prevLoc.seq !== loc.seq ? Math.sign(loc.seq - prevLoc.seq) : train.travel);
      train.trail.push({ at, track: loc.track, seq: loc.seq });
      if (train.trail.length > TRAIL_LENGTH) train.trail.splice(0, train.trail.length - TRAIL_LENGTH);
      if (!wasNew) recordDepartures(index, train, prevLoc, loc, at, events);
      if (loc.station) {
        train.stationPolls = train.station === loc.station ? train.stationPolls + 1 : 1;
        train.station = loc.station;
        if (train.stationPolls === 2 && !train.arrivals[loc.station]) {
          train.arrivals[loc.station] = at;
          events.push({ type: 'arrival', trainId: t.id, line: loc.line, track: loc.track, station: loc.station, at });
        }
      } else {
        train.station = null;
        train.stationPolls = 0;
      }
    } else {
      train.station = null;
      train.stationPolls = 0;
    }
    next.trains[t.id] = train;
  }

  for (const [id, old] of Object.entries(prev.trains)) {
    if (seen.has(id)) continue;
    const train = structuredClone(old);
    train.missed += 1;
    if (train.missed >= LOST_AFTER_MISSED_POLLS) {
      events.push({ type: 'lost', trainId: id, reason: 'missing', at });
      continue;
    }
    next.trains[id] = train;
  }

  return { state: next, events };
}

/**
 * Normal-service trains that departed `station` at or after `after`, ordered
 * by departure time. A train with no recorded departure is never a candidate.
 */
export function candidates(state, { station, after = 0, line = null } = {}) {
  return Object.values(state?.trains ?? {})
    .filter((t) => t.service === 'Normal' && (line === null || t.line === line))
    .filter((t) => Number.isFinite(t.departures[station]) && t.departures[station] >= after)
    .sort((a, b) => a.departures[station] - b.departures[station])
    .map((t) => t.id);
}

/** True when a GPS fix is trustworthy enough to place a train: tight and moving. */
export function usableFix(fix) {
  return (
    Number.isFinite(fix?.lat) &&
    Number.isFinite(fix?.lon) &&
    Number.isFinite(fix?.time) &&
    Number.isFinite(fix?.accuracy) &&
    fix.accuracy < MAX_FIX_ACCURACY_M &&
    Number.isFinite(fix?.speed) &&
    fix.speed > MIN_FIX_SPEED_MS
  );
}

export function distanceM(a, b) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Approximate lat/lon of a circuit seq on a track by interpolating between its stations. */
export function seqToPosition(index, stations, line, track, seq) {
  const t = index.tracks.get(trackKey(line, track));
  if (!t) return null;
  const known = t.stations.map((s) => ({ ...s, pos: stations.get(s.code) })).filter((s) => s.pos);
  if (known.length === 0) return null;
  const point = (pos) => ({ lat: pos.lat, lon: pos.lon });
  if (seq <= known[0].seq) return point(known[0].pos);
  if (seq >= known.at(-1).seq) return point(known.at(-1).pos);
  for (let i = 1; i < known.length; i++) {
    const a = known[i - 1];
    const b = known[i];
    if (seq >= a.seq && seq <= b.seq) {
      const f = b.seq === a.seq ? 0 : (seq - a.seq) / (b.seq - a.seq);
      return { lat: a.pos.lat + (b.pos.lat - a.pos.lat) * f, lon: a.pos.lon + (b.pos.lon - a.pos.lon) * f };
    }
  }
  return null;
}

function seqAt(trail, time) {
  if (trail.length === 0) return null;
  if (time <= trail[0].at) return trail[0];
  if (time >= trail.at(-1).at) return trail.at(-1);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    if (time >= a.at && time <= b.at) {
      if (a.track !== b.track) return time - a.at < b.at - time ? a : b;
      const f = b.at === a.at ? 0 : (time - a.at) / (b.at - a.at);
      return { track: a.track, seq: a.seq + (b.seq - a.seq) * f };
    }
  }
  return null;
}

/**
 * Pick the one candidate whose recorded positions match the usable GPS fixes.
 * Returns `{ trainId }` on a lock, or `{ trainId: null, reason }` otherwise; never a guess.
 */
export function lockFromFixes(state, fixes, index, stations, ids) {
  const usable = (fixes ?? []).filter(usableFix);
  if (usable.length < LOCK_MIN_FIXES) return { trainId: null, reason: `no lock: ${usable.length} usable fix(es), need ${LOCK_MIN_FIXES}` };
  const list = (ids ?? Object.keys(state?.trains ?? {})).map((id) => state?.trains?.[id]).filter(Boolean);
  if (list.length === 0) return { trainId: null, reason: 'no lock: no candidates' };
  const scored = [];
  for (const train of list) {
    let sum = 0;
    let n = 0;
    for (const fix of usable) {
      const at = seqAt(train.trail, fix.time);
      const pos = at && seqToPosition(index, stations, train.line, at.track, at.seq);
      if (!pos) continue;
      sum += distanceM(fix, pos);
      n += 1;
    }
    if (n === usable.length) scored.push({ id: train.id, mean: sum / n });
  }
  scored.sort((a, b) => a.mean - b.mean);
  const best = scored[0];
  if (!best || best.mean > LOCK_MAX_MEAN_M) return { trainId: null, reason: 'no lock: no candidate near the fixes' };
  const second = scored[1];
  if (second && second.mean - best.mean < LOCK_MARGIN_M) return { trainId: null, reason: `no lock: ambiguous between ${best.id} and ${second.id}` };
  return { trainId: best.id, meanDistanceM: Math.round(best.mean) };
}

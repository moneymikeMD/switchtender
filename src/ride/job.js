// The ride tracker, a Cloud Run Job entry point (CMB-152). One execution per
// ride, started by /ride/start with RIDE_KEY naming the ride object. It polls
// WMATA TrainPositions, follows the owner's train, and pushes each alert to
// the phone before the station. The morning locks its first leg's train from
// GPS fixes; the evening (CMB-161) alerts candidate trains and narrows its
// second leg by GPS once that leg runs above ground.
//
// Run contract:
//   node src/ride/job.js
//   RIDE_KEY, RIDE_BUCKET, RIDE_NTFY_TOPIC, RIDE_SERVICE_URL, TRANSIT_API_KEY required;
//   SWITCHTENDER_CONFIG (default config.toml) for [ride] legs, route.timezone and [log];
//   SHEETS_ACCESS_TOKEN for a laptop run, else the metadata server's token.
//   Exit 0: the ride ended and its row was written (reason in the object: done,
//   cancelled, no-lock, lost, timeout). Exit 1: the ride could
//   not run (crash, feed bootstrap, bad leg config), after a loud status push
//   and a best-effort `ended`. Exit 2: the environment is incomplete; nothing
//   was touched.
//
// Everything with a clock, a sleep, a socket or a store is injected into
// runRide, so a test runs a whole ride in milliseconds against synthetic
// feeds. Nothing here prints a key, a token or the topic.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseConfig, ConfigError } from '../config.js';
import { tokenFromEnvOrMetadata } from '../log.js';
import * as rideState from './state.js';
import { logRide } from './log.js';
import { buildCircuitIndex, buildStationIndex, emptyState, observe, candidates, lockFromFixes } from './track.js';
import { buildPlan, alertText, lockText, boundRight, nearAlert, NOT_TRACKING, GPS_TEXT, CANDIDATES_PER_LEG, TRANSFER_GAP_MS } from './plan.js';
import { RIDE_DEFAULTS } from './config.js';
import { pushRide, cancelActions } from './notify.js';

const WMATA = 'https://api.wmata.com';
export const ENDPOINTS = Object.freeze({
  positions: `${WMATA}/TrainPositions/TrainPositions?contentType=json`,
  routes: `${WMATA}/TrainPositions/StandardRoutes?contentType=json`,
  stations: `${WMATA}/Rail.svc/json/jStations`,
});

export const POLL_MS = 15_000;
export const FAST_POLL_MS = 5_000;
export const MAX_RIDE_MS = 2 * 60 * 60 * 1000;
export const END_AFTER_LAST_ALERT_MS = 5 * 60 * 1000;
export const LOCK_GRACE_MS = 2 * 60 * 1000;
export const FEED_FAILURES_BEFORE_PUSH = 2;
export const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

const REQUIRED_ENV = ['RIDE_KEY', 'RIDE_BUCKET', 'RIDE_NTFY_TOPIC', 'RIDE_SERVICE_URL', 'TRANSIT_API_KEY'];

/** Resolve the Job's environment: { ok: true, key, bucket, topic, serviceUrl, apiKey, configPath } or { ok: false, error } naming the first missing variable. */
export function jobEnv(env = process.env) {
  const read = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');
  for (const name of REQUIRED_ENV) if (!read(name)) return { ok: false, error: `${name} is not set` };
  return {
    ok: true,
    key: read('RIDE_KEY'),
    bucket: read('RIDE_BUCKET'),
    topic: read('RIDE_NTFY_TOPIC'),
    serviceUrl: read('RIDE_SERVICE_URL'),
    apiKey: read('TRANSIT_API_KEY'),
    configPath: read('SWITCHTENDER_CONFIG') || 'config.toml',
  };
}

async function wmata(fetchImpl, url, apiKey) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { api_key: apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (cause) {
    throw new Error(`wmata network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}`);
  }
  if (!response.ok) throw new Error(`wmata ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('wmata: not JSON');
  }
}

const toFix = (f) => ({ lat: f.lat, lon: f.lon, accuracy: f.accuracy_m, speed: f.speed_mps, time: Date.parse(f.at) });
const iso = (ms) => new Date(ms).toISOString();

/**
 * Run one ride to its end. Returns { reason, exitCode }; throws only when the
 * store fails past its retries, which main() turns into a crash end.
 */
export async function runRide({
  key,
  bucket,
  config,
  topic,
  serviceUrl,
  apiKey,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  store = rideState,
  tokenProvider = tokenFromEnvOrMetadata,
  push = pushRide,
  log = logRide,
  logger = (line) => console.error(line),
  pollMs = POLL_MS,
  fastPollMs = FAST_POLL_MS,
  maxMs = MAX_RIDE_MS,
  endAfterMs = END_AFTER_LAST_ALERT_MS,
  lockGraceMs = LOCK_GRACE_MS,
}) {
  const t = () => now().getTime();
  const io = async () => {
    const token = await tokenProvider({ fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!token) throw new Error('no credentials for the ride store');
    return { bucket, key, token, fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  };

  const first = await store.readRide(await io());
  if (first === null) {
    logger(`ride ${key}: no such object`);
    return { reason: 'no-ride', exitCode: 1 };
  }
  let ride = first.ride;
  if (ride.ended) {
    logger(`ride ${key}: already ended (${ride.ended.reason})`);
    return { reason: ride.ended.reason, exitCode: 0 };
  }

  const update = async (mutate) => {
    const result = await store.updateRide({ ...(await io()), mutate });
    if (result?.ride) ride = result.ride;
    return result;
  };
  const status = async (statusKey, text, { quiet = false } = {}) => {
    const result = await update((r) => store.withStatus(r, { key: statusKey, now: now(), text }));
    if (!result?.updated) return false;
    const sent = await push({ topic, kind: 'status', text, quiet, sentAtMs: t(), fetchImpl });
    if (!sent.ok) logger(`ride status push failed: ${sent.error}`);
    return true;
  };
  const finish = async (reason, { loud = false, exitCode = 0 } = {}) => {
    if (loud) await status(reason, NOT_TRACKING);
    await update((r) => store.withEnded(r, { reason, now: now() }));
    const logged = await log({ now: now(), config, ride, tokenProvider, fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!logged.ok) logger(`ride row failed: ${logged.error}`);
    logger(`ride ${key}: ended, ${reason}`);
    return { reason, exitCode };
  };

  if (ride.cancel) return finish('cancelled');

  const timeZone = ride.timezone ?? config?.route?.timezone ?? 'UTC';
  let plan;
  let index;
  let stations;
  for (let attempt = 1; ; attempt += 1) {
    try {
      index = buildCircuitIndex(await wmata(fetchImpl, ENDPOINTS.routes, apiKey));
      stations = buildStationIndex(await wmata(fetchImpl, ENDPOINTS.stations, apiKey));
      break;
    } catch (error) {
      logger(`ride bootstrap failed (${attempt}/${BOOTSTRAP_ATTEMPTS}): ${error.message}`);
      if (attempt >= BOOTSTRAP_ATTEMPTS) return finish('feed', { loud: true, exitCode: 1 });
      await sleep(BOOTSTRAP_RETRY_MS);
    }
  }
  try {
    plan = buildPlan({ leg: ride.leg, legs: config?.ride?.[ride.leg]?.legs ?? [], index, timeZone });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger(error.message);
    return finish('config', { loud: true, exitCode: 1 });
  }

  const sent = new Set((ride.alerts ?? []).map((a) => a.key));
  let lastAlertAt = (ride.alerts ?? []).reduce((max, a) => Math.max(max, Date.parse(a.at) || 0), 0) || null;
  const alert = async (alertKey, { kind, text, station, trainId, circuit }) => {
    const result = await update((r) => store.withAlert(r, { key: alertKey, now: now(), station, trainId, circuit, title: kind, text }));
    if (!result?.updated) return false;
    sent.add(alertKey);
    lastAlertAt = t();
    const actions = cancelActions({ serviceUrl, leg: ride.leg, token: ride.cancel_token });
    const pushed = await push({ topic, kind, text, sentAtMs: lastAlertAt, actions, fetchImpl });
    if (!pushed.ok) logger(`ride alert push failed: ${pushed.error}`);
    logger(`ride alert ${alertKey}: ${text}`);
    return true;
  };

  let state = emptyState();
  const ctx = {
    plan,
    index,
    stations,
    sent,
    alert,
    status,
    update,
    finish,
    logger,
    now,
    lockGraceMs,
    ride: () => ride,
    state: () => state,
    store,
    gpsWindowMs: (config?.ride?.[ride.leg]?.gps_window_mins ?? RIDE_DEFAULTS[ride.leg].gps_window_mins) * 60_000,
  };
  const step = ride.leg === 'am' ? morning(ctx) : evening(ctx);

  let feedFailures = 0;
  const startedAt = t();
  if (ride.status !== 'tracking') await update((r) => ({ ...r, status: 'tracking' }));

  for (;;) {
    const nowMs = t();
    if (nowMs - startedAt >= maxMs) return finish('timeout', { loud: true });
    try {
      const read = await store.readRide(await io());
      if (read) ride = read.ride;
    } catch (error) {
      logger(`ride read failed: ${error.message}`);
    }
    if (ride.cancel) return finish('cancelled');

    let events = [];
    let polled = false;
    try {
      const feed = await wmata(fetchImpl, ENDPOINTS.positions, apiKey);
      feedFailures = 0;
      polled = true;
      ({ state, events } = observe(state, feed, index, nowMs));
    } catch (error) {
      feedFailures += 1;
      logger(`ride poll failed (${feedFailures}): ${error.message}`);
      if (feedFailures === FEED_FAILURES_BEFORE_PUSH) await status('feed', NOT_TRACKING);
    }

    if (polled) {
      const ended = await step.poll(events, nowMs);
      if (ended) return ended;
    }

    if (step.settled() && lastAlertAt !== null && nowMs >= lastAlertAt + endAfterMs) return finish('done');

    const fast = step.watching().some(([id, leg]) => nearAlert(index, state.trains[id], leg));
    await sleep(fast ? fastPollMs : pollMs);
  }
}

function morning({ plan, index, stations, sent, alert, status, update, finish, logger, now, lockGraceMs, ride, state, store }) {
  const legKeys = plan.legs.flatMap((leg) => (leg.n === 0 ? ['leg0'] : Array.from({ length: CANDIDATES_PER_LEG }, (_, i) => `leg1:${i}`)));
  const start = ride();
  let phase = start.tracking?.phase ?? 'lock';
  let lockedId = start.lock?.train_id ?? null;
  let transferAt = start.tracking?.transfer_at ? Date.parse(start.tracking.transfer_at) : null;
  let green = [...(start.tracking?.candidates ?? [])];
  const lostSlots = new Set();
  const gpsFrom = Date.parse(start.gps_from);
  const gpsUntil = Date.parse(start.gps_until);

  async function poll(events, nowMs) {
    const s = state();
    if (phase === 'lock') {
      const leg = plan.legs[0];
      const ids = candidates(s, { station: leg.board, after: gpsFrom, line: leg.line }).filter((id) => boundRight(s.trains[id], leg));
      const lock =
        ids.length > 0 ? lockFromFixes(s, (ride().fixes ?? []).map(toFix), index, stations, ids) : { trainId: null, reason: 'no lock: no candidates yet' };
      if (lock.trainId) {
        lockedId = lock.trainId;
        const departedAt = s.trains[lockedId].departures[leg.board];
        await update((r) =>
          store.withTracking(store.withLock(r, { trainId: lockedId, now: now(), departedAt: iso(departedAt), meanDistanceM: lock.meanDistanceM }), {
            phase: 'leg0',
            transfer_at: null,
            candidates: [],
          }),
        );
        phase = 'leg0';
        logger(`ride locked train ${lockedId} (${lock.meanDistanceM} m)`);
        await status('lock', lockText(plan, departedAt), { quiet: true });
      } else if (nowMs > gpsUntil + lockGraceMs) {
        logger(`ride ${lock.reason}`);
        return finish('no-lock', { loud: true });
      }
    }

    if (phase === 'leg0') {
      const leg = plan.legs[0];
      const mine = events.filter((e) => e.trainId === lockedId);
      if (mine.some((e) => e.type === 'lost')) return finish('lost', { loud: true });
      for (const e of mine.filter((e) => e.type === 'arrival')) {
        if (e.station === leg.alert) {
          await alert('leg0', { kind: 'alert', text: alertText(plan, 0), station: e.station, trainId: lockedId, circuit: s.trains[lockedId]?.circuit ?? null });
        }
        if (e.station === leg.alight) {
          transferAt = e.at;
          if (plan.legs[1]) {
            phase = 'leg1';
            await update((r) => store.withTracking(r, { phase: 'leg1', transfer_at: iso(transferAt), candidates: [] }));
          } else phase = 'done';
        }
      }
    }

    if (phase === 'leg1') {
      const leg = plan.legs[1];
      if (green.length < CANDIDATES_PER_LEG) {
        const fresh = candidates(s, { station: leg.board, after: transferAt + TRANSFER_GAP_MS, line: leg.line }).filter(
          (id) => boundRight(s.trains[id], leg) && !green.includes(id),
        );
        if (fresh.length > 0) {
          green = [...green, ...fresh].slice(0, CANDIDATES_PER_LEG);
          await update((r) => store.withTracking(r, { candidates: green }));
          logger(`ride candidates for ${leg.alightName}: ${green.join(', ')}`);
        }
      }
      for (const e of events) {
        const slot = green.indexOf(e.trainId);
        if (slot < 0) continue;
        if (e.type === 'lost') {
          lostSlots.add(`leg1:${slot}`);
          logger(`ride candidate ${e.trainId} lost (${e.reason})`);
        }
        if (e.type === 'arrival' && e.station === leg.alert) {
          const departedAt = s.trains[e.trainId]?.departures?.[leg.board] ?? null;
          await alert(`leg1:${slot}`, {
            kind: slot === 0 ? 'alert' : 'once',
            text: alertText(plan, 1, departedAt),
            station: e.station,
            trainId: e.trainId,
            circuit: s.trains[e.trainId]?.circuit ?? null,
          });
        }
      }
      const slots = green.map((_, i) => `leg1:${i}`);
      if (slots.length === CANDIDATES_PER_LEG && slots.every((k) => lostSlots.has(k) && !sent.has(k))) return finish('lost', { loud: true });
    }
    return null;
  }

  return {
    poll,
    settled: () => legKeys.every((k) => sent.has(k) || lostSlots.has(k)),
    watching: () => (phase === 'leg0' ? [[lockedId, plan.legs[0]]] : phase === 'leg1' ? green.map((id) => [id, plan.legs[1]]) : []),
  };
}

// No GPS lock on the first leg: it is underground end to end (CMB-149), so its candidates alert by name.
function evening({ plan, index, stations, sent, alert, status, update, finish, logger, now, lockGraceMs, ride, state, store, gpsWindowMs }) {
  const [first, second] = plan.legs;
  const start = ride();
  const tracking = start.tracking ?? {};
  const fenceAt = Date.parse(start.fence_at);
  let boarding = [...(tracking.boarding ?? [])];
  let transfers = [...(tracking.transfers ?? [])];
  let picks = (tracking.picks ?? []).map((p) => [...p]);
  let later = [...(tracking.candidates ?? [])];
  let lockedId = start.lock?.train_id ?? null;
  let lockLost = false;
  let gpsFrom = tracking.gps_from ? Date.parse(tracking.gps_from) : null;
  let gpsUntil = tracking.gps_until ? Date.parse(tracking.gps_until) : null;
  const lost = new Set();
  const save = () => update((r) => store.withTracking(r, { phase: 'evening', boarding, transfers, picks, candidates: later }));
  const departure = (id, leg) => state().trains[id]?.departures?.[leg.board] ?? null;
  const narrowed = () => lockedId !== null && !lockLost;

  async function poll(events, nowMs) {
    const s = state();
    let changed = false;
    if (boarding.length < CANDIDATES_PER_LEG) {
      const fresh = candidates(s, { station: first.board, after: fenceAt, line: first.line }).filter(
        (id) => boundRight(s.trains[id], first) && !boarding.includes(id),
      );
      if (fresh.length > 0) {
        boarding = [...boarding, ...fresh].slice(0, CANDIDATES_PER_LEG);
        changed = true;
        logger(`ride candidates for ${first.alightName}: ${boarding.join(', ')}`);
      }
    }
    for (const e of events) {
      const slot = boarding.indexOf(e.trainId);
      if (slot < 0) continue;
      if (e.type === 'lost') {
        lost.add(e.trainId);
        logger(`ride candidate ${e.trainId} lost (${e.reason})`);
      }
      if (e.type !== 'arrival') continue;
      if (e.station === first.alert) {
        await alert(`leg0:${slot}`, {
          kind: slot === 0 ? 'alert' : 'once',
          text: alertText(plan, 0, departure(e.trainId, first)),
          station: e.station,
          trainId: e.trainId,
          circuit: s.trains[e.trainId]?.circuit ?? null,
        });
      }
      if (second && e.station === first.alight && !transfers[slot]) {
        transfers[slot] = iso(e.at);
        changed = true;
      }
    }

    if (second) {
      boarding.forEach((_, i) => {
        if (!transfers[i] || (picks[i]?.length ?? 0) >= CANDIDATES_PER_LEG) return;
        const mine = picks[i] ?? [];
        const fresh = candidates(s, { station: second.board, after: Date.parse(transfers[i]) + TRANSFER_GAP_MS, line: second.line }).filter(
          (id) => boundRight(s.trains[id], second) && !mine.includes(id),
        );
        if (fresh.length === 0) return;
        picks[i] = [...mine, ...fresh].slice(0, CANDIDATES_PER_LEG);
        for (const id of picks[i]) if (!later.includes(id)) later.push(id);
        changed = true;
        logger(`ride candidates for ${second.alightName}: ${later.join(', ')}`);
      });
    }
    if (changed) await save();

    if (second) {
      for (const e of events) {
        const slot = later.indexOf(e.trainId);
        if (slot < 0) continue;
        if (e.type === 'lost') {
          lost.add(e.trainId);
          if (e.trainId === lockedId && !sent.has(`leg1:${slot}`)) {
            lockLost = true;
            logger(`ride locked train ${lockedId} lost before its alert; every candidate alerts again`);
          }
        }
        if (e.type === 'departure' && e.station === second.gpsAfter && gpsFrom === null) {
          gpsFrom = nowMs;
          gpsUntil = nowMs + gpsWindowMs;
          await update((r) => store.withTracking(r, { gps_from: iso(gpsFrom), gps_until: iso(gpsUntil) }));
          await status('gps', GPS_TEXT, { quiet: true });
        }
        if (e.type === 'arrival' && e.station === second.alert) {
          if (narrowed() && e.trainId !== lockedId) continue;
          await alert(`leg1:${slot}`, {
            kind: narrowed() || slot === 0 ? 'alert' : 'once',
            text: alertText(plan, 1, departure(e.trainId, second)),
            station: e.station,
            trainId: e.trainId,
            circuit: s.trains[e.trainId]?.circuit ?? null,
          });
        }
      }

      if (lockedId === null && gpsFrom !== null && nowMs <= gpsUntil + lockGraceMs) {
        const ids = later.filter((id) => s.trains[id] && !lost.has(id));
        const fixes = (ride().fixes ?? []).map(toFix).filter((f) => f.time >= gpsFrom);
        const lock = ids.length > 0 ? lockFromFixes(s, fixes, index, stations, ids) : { trainId: null };
        if (lock.trainId) {
          lockedId = lock.trainId;
          const departedAt = departure(lockedId, second);
          await update((r) => store.withLock(r, { trainId: lockedId, now: now(), departedAt: iso(departedAt), meanDistanceM: lock.meanDistanceM }));
          logger(`ride locked train ${lockedId} (${lock.meanDistanceM} m)`);
          await status('lock', lockText(plan, departedAt, 1), { quiet: true });
        }
      }
    }

    const quiet = (keyOf, ids) => ids.length > 0 && ids.every((id, i) => lost.has(id) && !sent.has(keyOf(i)));
    if (boarding.length === CANDIDATES_PER_LEG && quiet((i) => `leg0:${i}`, boarding)) return finish('lost', { loud: true });
    if (second && picksComplete() && quiet((i) => `leg1:${i}`, later)) return finish('lost', { loud: true });
    return null;
  }

  function picksComplete() {
    return boarding.every((id, i) => (transfers[i] ? (picks[i]?.length ?? 0) >= CANDIDATES_PER_LEG : lost.has(id)));
  }

  function settled() {
    if (boarding.length < CANDIDATES_PER_LEG) return false;
    if (!boarding.every((id, i) => sent.has(`leg0:${i}`) || lost.has(id))) return false;
    if (!second) return true;
    if (!picksComplete()) return false;
    if (narrowed()) return sent.has(`leg1:${later.indexOf(lockedId)}`) || lost.has(lockedId);
    return later.every((id, i) => sent.has(`leg1:${i}`) || lost.has(id));
  }

  return {
    poll,
    settled,
    watching: () => [
      ...boarding.filter((id, i) => !sent.has(`leg0:${i}`)).map((id) => [id, first]),
      ...(second ? (narrowed() ? [lockedId] : later).map((id) => [id, second]) : []),
    ],
  };
}

/** Best effort after a crash: a loud status and an `ended` record, so the phone and the row both say so. Never throws. */
export async function recordCrash({
  key,
  bucket,
  topic,
  config,
  fetchImpl = fetch,
  store = rideState,
  tokenProvider = tokenFromEnvOrMetadata,
  push = pushRide,
  log = logRide,
  now = () => new Date(),
  logger = () => {},
}) {
  try {
    const token = await tokenProvider({ fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!token) return;
    const io = { bucket, key, token, fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    const marked = await store.updateRide({
      ...io,
      mutate: (r) => (r.ended ? null : store.withStatus(store.withEnded(r, { reason: 'crash', now: now() }), { key: 'crash', now: now(), text: NOT_TRACKING })),
    });
    if (!marked?.updated) return;
    await push({ topic, kind: 'status', text: NOT_TRACKING, sentAtMs: now().getTime(), fetchImpl });
    await log({ now: now(), config, ride: marked.ride, tokenProvider, fetchImpl, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    logger(`ride crash record failed: ${error?.message ?? error}`);
  }
}

async function main() {
  const env = jobEnv(process.env);
  if (!env.ok) {
    console.error(`switchtender ride: ${env.error}; refusing to start`);
    process.exit(2);
  }
  let config;
  try {
    config = parseConfig(readFileSync(env.configPath, 'utf8'));
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : `switchtender ride: could not read ${env.configPath} (${error.code ?? error.message})`);
    process.exit(2);
  }
  if (!config.ride) {
    console.error(`switchtender ride: ${env.configPath} has no [ride] block; refusing to start`);
    process.exit(2);
  }
  const deps = { key: env.key, bucket: env.bucket, topic: env.topic, serviceUrl: env.serviceUrl, apiKey: env.apiKey, config };
  try {
    const result = await runRide(deps);
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`switchtender ride: crashed: ${error?.message ?? error}`);
    await recordCrash({ ...deps, logger: (line) => console.error(line) });
    process.exit(1);
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();

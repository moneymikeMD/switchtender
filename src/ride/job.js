// The ride tracker, a Cloud Run Job entry point (CMB-152). One execution per
// ride, started by /ride/start with RIDE_KEY naming the ride object. It polls
// WMATA TrainPositions, locks the first leg's train from the phone's GPS
// fixes, follows it, and pushes each alert to the phone before the station.
//
// Run contract:
//   node src/ride/job.js
//   RIDE_KEY, RIDE_BUCKET, RIDE_NTFY_TOPIC, RIDE_SERVICE_URL, TRANSIT_API_KEY required;
//   SWITCHTENDER_CONFIG (default config.toml) for [ride] legs, route.timezone and [log];
//   SHEETS_ACCESS_TOKEN for a laptop run, else the metadata server's token.
//   Exit 0: the ride ended and its row was written (reason in the object: done,
//   cancelled, no-lock, lost, timeout, pm-not-built). Exit 1: the ride could
//   not run (crash, feed bootstrap, bad leg config), after a loud status push
//   and a best-effort `ended`. Exit 2: the environment is incomplete; nothing
//   was touched.
//
// Only the morning leg is built. A `pm` ride ends at once with reason
// pm-not-built: the evening start needs an underground-GPS gate the phone
// spike (CMB-149) showed does not exist yet.
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
import { buildPlan, alertText, lockText, boundRight, nearAlert, NOT_TRACKING, CANDIDATES_PER_LEG, TRANSFER_GAP_MS } from './plan.js';
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

  if (ride.leg !== 'am') return finish('pm-not-built');
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

  const legKeys = plan.legs.flatMap((leg) => (leg.n === 0 ? ['leg0'] : Array.from({ length: CANDIDATES_PER_LEG }, (_, i) => `leg1:${i}`)));
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

  let phase = ride.tracking?.phase ?? 'lock';
  let lockedId = ride.lock?.train_id ?? null;
  let transferAt = ride.tracking?.transfer_at ? Date.parse(ride.tracking.transfer_at) : null;
  let green = [...(ride.tracking?.candidates ?? [])];
  const lostSlots = new Set();
  let state = emptyState();
  let feedFailures = 0;
  const startedAt = t();
  const gpsFrom = Date.parse(ride.gps_from);
  const gpsUntil = Date.parse(ride.gps_until);
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

    if (phase === 'lock' && polled) {
      const leg = plan.legs[0];
      const ids = candidates(state, { station: leg.board, after: gpsFrom, line: leg.line }).filter((id) => boundRight(state.trains[id], leg));
      const lock =
        ids.length > 0 ? lockFromFixes(state, (ride.fixes ?? []).map(toFix), index, stations, ids) : { trainId: null, reason: 'no lock: no candidates yet' };
      if (lock.trainId) {
        lockedId = lock.trainId;
        const departedAt = state.trains[lockedId].departures[leg.board];
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

    if (phase === 'leg0' && polled) {
      const leg = plan.legs[0];
      const mine = events.filter((e) => e.trainId === lockedId);
      if (mine.some((e) => e.type === 'lost')) return finish('lost', { loud: true });
      for (const e of mine.filter((e) => e.type === 'arrival')) {
        if (e.station === leg.alert) {
          await alert('leg0', {
            kind: 'alert',
            text: alertText(plan, 0),
            station: e.station,
            trainId: lockedId,
            circuit: state.trains[lockedId]?.circuit ?? null,
          });
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

    if (phase === 'leg1' && polled) {
      const leg = plan.legs[1];
      if (green.length < CANDIDATES_PER_LEG) {
        const fresh = candidates(state, { station: leg.board, after: transferAt + TRANSFER_GAP_MS, line: leg.line }).filter(
          (id) => boundRight(state.trains[id], leg) && !green.includes(id),
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
          const departedAt = state.trains[e.trainId]?.departures?.[leg.board] ?? null;
          await alert(`leg1:${slot}`, {
            kind: slot === 0 ? 'alert' : 'once',
            text: alertText(plan, 1, departedAt),
            station: e.station,
            trainId: e.trainId,
            circuit: state.trains[e.trainId]?.circuit ?? null,
          });
        }
      }
      const slots = green.map((_, i) => `leg1:${i}`);
      if (slots.length === CANDIDATES_PER_LEG && slots.every((k) => lostSlots.has(k) && !sent.has(k))) return finish('lost', { loud: true });
    }

    const settled = legKeys.every((k) => sent.has(k) || lostSlots.has(k));
    if (settled && lastAlertAt !== null && nowMs >= lastAlertAt + endAfterMs) return finish('done');

    const watching = phase === 'leg0' ? [[lockedId, plan.legs[0]]] : phase === 'leg1' ? green.map((id) => [id, plan.legs[1]]) : [];
    const fast = watching.some(([id, leg]) => nearAlert(index, state.trains[id], leg));
    await sleep(fast ? fastPollMs : pollMs);
  }
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

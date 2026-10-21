// HTTP entry point (CMB-12).
//
// One route returns the verdict and the spoken line for the configured
// journey. It runs on Cloud Run, scales to zero, and is called twice a weekday
// from a phone on mobile data at speed, so the response is small and the
// timeout short.
//
// Authentication is a shared secret in a request header. Cloud Run's own IAM
// check is off (--allow-unauthenticated) because the phone cannot mint a
// Google identity token; this header is the whole gate, so the comparison is
// constant time and the server refuses to start without a secret to compare
// against. The secret comes from the environment (CLAUDE.md rule 7), is read
// once, and is never written to a log line.
//
// Failure policy: when routing fails the response is 503 and says nothing
// else. The owner runs Waze anyway; a guess would be worse than silence.

import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { RouteError, START_POINTS, DIRECTIONS } from './routes.js';
import { runVerdict } from './engine.js';
import { logArrival, tokenFromEnvOrMetadata, ARRIVAL_PLACES, ARRIVAL_CHOICES, TRIGGERS } from './log.js';
import { pushVerdict } from './notify.js';
import { LEGS, MAX_FENCE_AGE_MS, judgeWindow, gpsWindow } from './ride/config.js';
import * as rideState from './ride/state.js';
import { rideEnv, launchRide } from './ride/launch.js';

const { RideStoreError, CANCEL_REASONS, rideKey } = rideState;
const MAX_BODY_BYTES = 4096;

export const KEY_HEADER = 'x-switchtender-key';
export const SECRET_ENV = 'SWITCHTENDER_SHARED_SECRET';
export const NTFY_TOPIC_ENV = 'NTFY_TOPIC';
export const DEFAULT_PORT = 8080;
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Constant-time comparison of a presented key against the secret.
 *
 * Both sides are hashed first so the byte lengths always match, which is what
 * timingSafeEqual requires; a key of the wrong length is therefore rejected
 * through the same code path as a wrong key of the right length, rather than
 * by an early return or an exception. A missing key never matches.
 */
export function keyMatches(presented, secret) {
  if (typeof presented !== 'string' || typeof secret !== 'string' || secret.length === 0) {
    return false;
  }
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function send(res, status, body, contentType = 'application/json') {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TimeoutError extends Error {
  constructor() {
    super('verdict timed out');
    this.name = 'TimeoutError';
  }
}

class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyError';
  }
}

// A small JSON body, or {} when there is none. Anything else is a BodyError.
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyError(`body larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new BodyError('body must be a JSON object'));
      }
    });
    req.on('error', (error) => reject(new BodyError(error.message)));
  });
}

// A finite number from a query string or a JSON body; null when absent.
function number(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : NaN;
}

const first = (source, names) => names.map((n) => source[n]).find((v) => v !== undefined && v !== null);

/**
 * Build the server without listening. Tests inject the pipeline and the
 * clock; production passes only config and secret.
 */
export function createServer({
  config,
  secret,
  run = runVerdict,
  now = () => new Date(),
  timeoutMs = REQUEST_TIMEOUT_MS,
  logger = (line) => console.error(line),
  fetchImpl = fetch,
  push = pushVerdict,
  recordArrival = logArrival,
  store = rideState,
  launch = launchRide,
  tokenProvider = tokenFromEnvOrMetadata,
  env = process.env,
}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${SECRET_ENV} is not set`);
  }

  const server = createHttpServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let pathname = '?';
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path and status only. Never the headers: one of them is the key.
      logger(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    try {
      pathname = await handle(req, res);
    } catch (error) {
      // The listener is async; a rejection here would be unhandled and
      // would take the process, and with it the only instance, down.
      logger(`request error: ${error?.message ?? error}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });

  async function handle(req, res) {
    // The request target is untrusted. llhttp accepts targets the WHATWG
    // parser rejects ("//[::1/x"), and that rejection must be a 400, not a
    // crash before the key is even looked at.
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      send(res, 400);
      return '?';
    }

    // /health, not /healthz: Cloud Run's frontend answers /healthz itself with
    // an HTML 404 and the request never reaches the container.
    const { pathname } = url;
    if (pathname === '/health') {
      send(res, 200, 'ok', 'text/plain');
      return pathname;
    }
    if (pathname === '/arrived') {
      await arrived(req, res, url);
      return pathname;
    }
    if (pathname === '/ride/start' || pathname === '/ride/fix' || pathname === '/ride/cancel') {
      await ride(req, res, url, pathname.slice('/ride/'.length));
      return pathname;
    }
    if (pathname !== '/verdict') {
      send(res, 404);
      return pathname;
    }
    if (req.method !== 'GET') {
      send(res, 405);
      return pathname;
    }
    if (!keyMatches(req.headers[KEY_HEADER], secret)) {
      send(res, 401);
      return pathname;
    }

    // ?from=origin asks for the whole trip from home (CMB-30). Checked after
    // the key so an unauthenticated caller learns nothing about the API.
    const from = url.searchParams.get('from') ?? 'fork';
    if (!START_POINTS.includes(from)) {
      send(res, 400, { error: `from must be one of ${START_POINTS.join(', ')}` });
      return pathname;
    }

    // Who asked (CMB-81): the hourly sampler sends poll, so its rows never
    // pass for a drive. Absent is unknown, logged as an empty cell.
    const trigger = url.searchParams.get('trigger');
    if (trigger !== null && !TRIGGERS.includes(trigger)) {
      send(res, 400, { error: `trigger must be one of ${TRIGGERS.join(', ')}` });
      return pathname;
    }

    // Cloud Scheduler's 7:30 office-day call only (CMB-83).
    const notify = url.searchParams.get('notify') === '1';

    // The trip home (CMB-82) is logged for analysis and never spoken, so it
    // has no push to make either.
    const direction = url.searchParams.get('direction') ?? 'inbound';
    if (!DIRECTIONS.includes(direction)) {
      send(res, 400, { error: `direction must be one of ${DIRECTIONS.join(', ')}` });
      return pathname;
    }
    if (direction === 'outbound' && notify) {
      send(res, 400, { error: 'notify is for the inbound trip only' });
      return pathname;
    }

    const computedAt = now();
    try {
      const { verdict, spoken, logged = null } = await withTimeout(run(config, { now: computedAt, from, trigger, direction }), timeoutMs);
      // A failed sheet write is the one failure nobody would otherwise see
      // from the phone: the verdict is fine, the tuning log just stops.
      if (logged && !logged.ok) logger(`log failed: ${logged.error}`);

      let notified = null;
      if (notify) {
        const topic = (process.env[NTFY_TOPIC_ENV] ?? '').trim();
        notified = await push({ choice: verdict.choice, spoken, topic, fetchImpl });
        if (!notified.ok) logger(`notify failed: ${notified.error}`);
      }

      send(res, 200, { spoken: spoken ?? null, verdict, computedAt: computedAt.toISOString(), logged, notified });
    } catch (error) {
      if (error instanceof RouteError) {
        send(res, 503, { error: 'lookup failed' });
      } else if (error instanceof TimeoutError) {
        send(res, 504, { error: 'lookup timed out' });
      } else {
        logger(`verdict error: ${error?.message ?? error}`);
        send(res, 500, { error: 'internal error' });
      }
    }
    return pathname;
  }

  /**
   * Record that the owner reached a destination (CMB-41). The phone fires this
   * from a geofence, so it answers 200 whenever the request itself was sound:
   * a failed sheet write is reported in the body and never as a status the
   * macro would treat as something to do again.
   */
  async function arrived(req, res, url) {
    if (req.method !== 'POST') {
      send(res, 405);
      return;
    }
    if (!keyMatches(req.headers[KEY_HEADER], secret)) {
      send(res, 401);
      return;
    }
    const place = url.searchParams.get('place');
    if (!ARRIVAL_PLACES.includes(place)) {
      send(res, 400, { error: `place must be one of ${ARRIVAL_PLACES.join(', ')}` });
      return;
    }
    // What was actually done, when the phone can know it. Absent is null and
    // stays null; the verdict's own choice is not a substitute for it.
    const took = url.searchParams.get('took');
    if (took !== null && !ARRIVAL_CHOICES.includes(took)) {
      send(res, 400, { error: `took must be one of ${ARRIVAL_CHOICES.join(', ')}` });
      return;
    }
    const at = url.searchParams.get('at');
    // A phone clock the caller supplies is trusted only as far as being a
    // date; anything else is the moment the request landed.
    const supplied = at === null ? null : new Date(at);
    if (supplied !== null && Number.isNaN(supplied.getTime())) {
      send(res, 400, { error: 'at must be an ISO 8601 timestamp' });
      return;
    }
    const when = supplied ?? now();
    try {
      const result = await withTimeout(recordArrival({ now: when, config, place, took, fetchImpl }), timeoutMs);
      if (!result.ok) logger(`arrival log failed: ${result.error}`);
      send(res, 200, {
        recorded: result.ok && !result.duplicate,
        duplicate: result.duplicate,
        place,
        took,
        at: when.toISOString(),
        verdictAt: result.verdictAt ?? null,
      });
    } catch (error) {
      logger(`arrival error: ${error?.message ?? error}`);
      send(res, 200, { recorded: false, duplicate: false, place, took, at: when.toISOString(), verdictAt: null });
    }
  }

  /**
   * The ride endpoints (CMB-151): start claims the day's ride object and
   * launches the tracker Job; fix and cancel write into that object. Every
   * ride answer is JSON; a missing bucket or Job is a 503 that names it.
   * A cancel may carry the ride's own `token` instead of the key (CMB-152):
   * the Job's ntfy buttons hold it, and it is checked against the object.
   */
  async function ride(req, res, url, action) {
    if (req.method !== 'POST') {
      send(res, 405);
      return;
    }
    const cancelToken = action === 'cancel' ? url.searchParams.get('token') : null;
    const viaToken = !keyMatches(req.headers[KEY_HEADER], secret);
    if (viaToken && !cancelToken) {
      send(res, 401);
      return;
    }
    const leg = url.searchParams.get('leg');
    if (!LEGS.includes(leg)) {
      send(res, 400, { error: `leg must be one of ${LEGS.join(', ')}` });
      return;
    }
    let body = {};
    if (action === 'fix') {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { error: error.message });
        return;
      }
    }
    const params = { ...body, ...Object.fromEntries(url.searchParams) };
    const atRaw = params.at;
    const supplied = atRaw === undefined || atRaw === null || atRaw === '' ? null : new Date(atRaw);
    if (supplied !== null && Number.isNaN(supplied.getTime())) {
      send(res, 400, { error: 'at must be an ISO 8601 timestamp' });
      return;
    }
    const received = now();
    const at = supplied ?? received;

    let fix = null;
    if (action === 'fix') {
      const lat = number(first(params, ['lat', 'latitude']));
      const lon = number(first(params, ['lon', 'lng', 'longitude']));
      const accuracyM = number(first(params, ['acc', 'accuracy', 'accuracy_m']));
      const speedKmh = number(first(params, ['kmh', 'speed_kmh', 'speed']));
      if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        send(res, 400, { error: 'lat and lon must be numbers in range' });
        return;
      }
      if (Number.isNaN(accuracyM) || Number.isNaN(speedKmh) || accuracyM < 0 || speedKmh < 0) {
        send(res, 400, { error: 'acc and kmh must be numbers of zero or more' });
        return;
      }
      fix = { at, now: received, lat, lon, accuracyM, speedKmh };
    }
    const reason = params.reason ?? null;
    if (action === 'cancel' && !CANCEL_REASONS.includes(reason)) {
      send(res, 400, { error: `reason must be one of ${CANCEL_REASONS.join(', ')}` });
      return;
    }

    if (!config.ride) {
      send(res, 503, { error: 'ride not configured: config.toml has no [ride] block' });
      return;
    }
    const target = rideEnv(env);
    if (!target.ok) {
      send(res, 503, { error: `ride not configured: ${target.error}` });
      return;
    }

    const timeZone = config.route.timezone;
    const walkMins = config.route.park_and_ride?.addl_walk_mins ?? 0;
    const localDate = judgeWindow({ at, leg, ride: config.ride, timeZone }).localDate;
    const key = rideKey(localDate, leg);
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const token = await tokenProvider({ fetchImpl, signal });
      if (!token) {
        send(res, 503, { error: 'no credentials' });
        return;
      }
      const io = { bucket: target.bucket, token, fetchImpl, signal };

      if (action === 'start') {
        if (Math.abs(received.getTime() - at.getTime()) > MAX_FENCE_AGE_MS) {
          send(res, 400, { error: 'at is stale: more than 2 minutes from the server clock', at: at.toISOString(), now: received.toISOString() });
          return;
        }
        const judged = judgeWindow({ at, leg, ride: config.ride, timeZone });
        if (!judged.inside) {
          send(res, 200, { started: false, reason: judged.reason, leg, local_date: judged.localDate });
          return;
        }
        const gps = gpsWindow({ at, leg, ride: config.ride, walkMins });
        const fenceAt = at.toISOString();
        const windowOut = {
          gps_from: gps.from.toISOString(),
          gps_until: gps.until.toISOString(),
          gps_from_epoch: Math.floor(gps.from.getTime() / 1000),
          gps_until_epoch: Math.floor(gps.until.getTime() / 1000),
        };

        const fresh = store.newRide({ key, leg, localDate, timeZone, fenceAt, now: received, gpsFrom: gps.from, gpsUntil: gps.until });
        let claimed = (await store.claimRide({ ...io, ride: fresh })).claimed;
        if (!claimed) {
          const existing = await store.readRide({ ...io, key });
          if (existing !== null && store.launchStale(existing.ride, received)) {
            // A failed or stalled launch left nothing running; this start takes the ride over.
            const taken = await store.updateRide({
              ...io,
              key,
              mutate: (r) => (store.launchStale(r, received) ? store.relaunched(r, { now: received, gpsFrom: gps.from, gpsUntil: gps.until, fenceAt }) : null),
            });
            claimed = Boolean(taken?.updated);
          }
          if (!claimed) {
            const current = existing ?? (await store.readRide({ ...io, key }));
            send(res, 200, { started: false, reason: 'already running', leg, ride: key, ...(current ? store.summary(current.ride) : {}), ...windowOut });
            return;
          }
        }

        const launched = await launch({ env: target, rideKey: key, token, fetchImpl, signal });
        await store.updateRide({ ...io, key, mutate: (r) => store.withLaunch(r, { ...launched, now: received }) });
        if (!launched.ok) {
          logger(`ride launch failed: ${launched.error}`);
          send(res, 502, { started: false, reason: 'launch failed', leg, ride: key, status: 'launch_failed', error: launched.error });
          return;
        }
        send(res, 200, { started: true, leg, ride: key, status: 'launched', local_date: localDate, operation: launched.operation, ...windowOut });
        return;
      }

      let tokenRejected = false;
      const cancel = (r) => {
        if (viaToken && !keyMatches(cancelToken, r.cancel_token)) {
          tokenRejected = true;
          return null;
        }
        return store.withCancel(r, { reason, now: received });
      };
      const mutate = action === 'fix' ? (r) => (store.summary(r).done ? null : store.withFix(r, fix)) : cancel;
      const result = await store.updateRide({ ...io, key, mutate });
      if (result === null) {
        send(res, 404, { error: 'no ride', leg, ride: key });
        return;
      }
      if (tokenRejected) {
        send(res, 401);
        return;
      }
      const s = store.summary(result.ride);
      if (action === 'fix') send(res, 200, { recorded: result.updated, leg, ride: key, ...s });
      else send(res, 200, { cancelled: true, reason: result.ride.cancel?.reason ?? reason, leg, ride: key, ...s });
    } catch (error) {
      if (error instanceof RideStoreError || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        logger(`ride ${action} failed: ${error.message}`);
        send(res, 503, { error: 'ride store failed' });
        return;
      }
      throw error;
    }
  }

  // Socket-level guard behind the promise race, so a stalled client cannot
  // hold an instance open either.
  server.requestTimeout = timeoutMs + 5_000;
  server.headersTimeout = 10_000;
  return server;
}

function main() {
  // Trimmed: Secret Manager hands over exactly the bytes it was given, and a
  // shell pipeline usually gives it one newline too many.
  const secret = (process.env[SECRET_ENV] ?? '').trim();
  if (!secret) {
    console.error(`switchtender: ${SECRET_ENV} is not set; refusing to start`);
    process.exit(1);
  }

  const configPath = process.env.SWITCHTENDER_CONFIG ?? 'config.toml';
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createServer({ config, secret });
  server.listen(port, () => {
    console.error(`switchtender: listening on ${port}, config ${configPath}`);
  });

  // Cloud Run sends SIGTERM before it removes an instance.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}

// Run only as the entry point. Resolved through realpath so a symlinked
// launcher still starts the server instead of exiting silently.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}

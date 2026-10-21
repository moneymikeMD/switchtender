// Ride state: one GCS object per ride (CMB-151).
//
// The service scales to zero and answers in under 30 s, so it cannot hold a
// ride. The ride lives at gs://<bucket>/rides/<local-date>-<leg>.json. The
// object is created with ifGenerationMatch=0, so of two fence firings only
// one creates it and the other learns the ride is already running. Every
// later write carries the generation it read, retried on 412, so a fix and a
// cancel landing together cannot clobber each other.
//
// Object shape (version 1). Two writers, disjoint fields:
//
//   {
//     "version": 1,
//     "key": "rides/2026-10-21-am.json",
//     "leg": "am" | "pm",
//     "local_date": "2026-10-21",
//     "timezone": "America/New_York",
//     "fence_at": "<ISO, local offset>",     the fence time the phone sent
//     "claimed_at": "<ISO UTC>",             when this object was created
//     "gps_from": "<ISO UTC>",               the phone sends fixes from here
//     "gps_until": "<ISO UTC>",              ...until here
//     "status": "launching" | "launched" | "launch_failed" | <Job values>,
//     "launch": { "ok": bool, "operation": string|null, "error": string|null, "at": "<ISO UTC>" } | null,
//     "cancel_token": "<base64url>",         lets a ntfy action button cancel without the shared key
//     "fixes": [ { "at", "received_at", "lat", "lon", "accuracy_m", "speed_kmh", "speed_mps" } ],
//     "cancel": null | { "reason": "off" | "not-riding", "at": "<ISO UTC>" },
//     "lock": null | { "method": "gps", "train_id", "at", "departed_at", "mean_distance_m" },
//     "tracking": null | { "phase", "transfer_at", "candidates": [ids] },   Job-owned: where the ride is up to
//     "alerts": [ { "key", "at", "station", "train_id", "circuit", "title", "text" } ],
//     "statuses": [ { "key", "at", "text" } ],                                Job-owned: status pushes sent, one per key
//     "ended": null | { "reason", "at" }
//   }
//
// The endpoints (this module's callers) own key, leg, local_date, timezone,
// fence_at, claimed_at, gps_from, gps_until, cancel_token, launch, fixes and
// cancel, and write status only until the Job starts: "launching" at the
// claim, then "launched" or "launch_failed". From its first write on, status,
// lock, tracking, alerts, statuses and ended belong to the Job (CMB-152);
// the endpoints read them and never write them. A start on a "launch_failed"
// ride, or on a "launching" one older than STALE_LAUNCH_MS, re-claims it in
// place. The cancel token never appears in an endpoint response: ntfy stores
// action URLs in the message, so it is scoped to one ride and nothing else.

import { randomBytes } from 'node:crypto';

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';

export const RIDE_VERSION = 1;
export const CANCEL_REASONS = Object.freeze(['off', 'not-riding']);
export const UPDATE_ATTEMPTS = 3;
export const STALE_LAUNCH_MS = 2 * 60 * 1000;
const CANCEL_TOKEN_BYTES = 24;

export class RideStoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RideStoreError';
    this.status = status;
  }
}

/** The object key for a ride: local date (route.timezone) and leg. */
export const rideKey = (localDate, leg) => `rides/${localDate}-${leg}.json`;

const objectUrl = (bucket, key) => `${STORAGE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
const uploadUrl = (bucket, key, precondition) => `${UPLOAD}/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}&${precondition}`;

async function call(fetchImpl, token, method, url, body, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw new RideStoreError(`network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}`);
  }
  return response;
}

async function errorOf(response) {
  let message = response.statusText || 'request failed';
  try {
    const json = await response.json();
    message = json?.error?.message ?? message;
  } catch {
    // the body was not JSON; the status is the message
  }
  return new RideStoreError(`gcs ${response.status}: ${message}`, response.status);
}

/** Fresh ride object for a claim. `at` is the fence time, `now` the server clock. */
export function newRide({ key, leg, localDate, timeZone, fenceAt, now, gpsFrom, gpsUntil }) {
  return {
    version: RIDE_VERSION,
    key,
    leg,
    local_date: localDate,
    timezone: timeZone,
    fence_at: fenceAt,
    claimed_at: now.toISOString(),
    gps_from: gpsFrom.toISOString(),
    gps_until: gpsUntil.toISOString(),
    cancel_token: randomBytes(CANCEL_TOKEN_BYTES).toString('base64url'),
    status: 'launching',
    launch: null,
    fixes: [],
    cancel: null,
    lock: null,
    tracking: null,
    alerts: [],
    statuses: [],
    ended: null,
  };
}

/**
 * Create the ride object, or learn it exists. Returns
 * { claimed: true, generation } or { claimed: false }. Throws RideStoreError
 * on anything but a clean create or a 412.
 */
export async function claimRide({ bucket, ride, token, fetchImpl = fetch, signal }) {
  const response = await call(fetchImpl, token, 'POST', uploadUrl(bucket, ride.key, 'ifGenerationMatch=0'), ride, signal);
  if (response.status === 412) return { claimed: false, generation: null };
  if (!response.ok) throw await errorOf(response);
  const meta = await response.json().catch(() => ({}));
  return { claimed: true, generation: String(meta?.generation ?? '') };
}

/** Read a ride and the generation it was read at, or null when there is none. */
export async function readRide({ bucket, key, token, fetchImpl = fetch, signal }) {
  const response = await call(fetchImpl, token, 'GET', `${objectUrl(bucket, key)}?alt=media`, undefined, signal);
  if (response.status === 404) return null;
  if (!response.ok) throw await errorOf(response);
  let ride;
  try {
    ride = await response.json();
  } catch {
    throw new RideStoreError(`gcs: ${key} is not JSON`);
  }
  let generation = response.headers.get('x-goog-generation');
  if (!generation) {
    const meta = await call(fetchImpl, token, 'GET', objectUrl(bucket, key), undefined, signal);
    if (!meta.ok) throw await errorOf(meta);
    generation = String((await meta.json())?.generation ?? '');
  }
  return { ride, generation };
}

/**
 * Read-modify-write with a generation precondition. `mutate(ride)` returns
 * the new ride or null to leave it alone. Retried on 412 up to
 * UPDATE_ATTEMPTS times; returns { ride, generation, updated } or null when
 * the object does not exist.
 */
export async function updateRide({ bucket, key, mutate, token, fetchImpl = fetch, signal }) {
  let last;
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
    const current = await readRide({ bucket, key, token, fetchImpl, signal });
    if (current === null) return null;
    const next = mutate(structuredClone(current.ride));
    if (next === null) return { ride: current.ride, generation: current.generation, updated: false };
    const response = await call(fetchImpl, token, 'POST', uploadUrl(bucket, key, `ifGenerationMatch=${encodeURIComponent(current.generation)}`), next, signal);
    if (response.status === 412) {
      last = response;
      continue;
    }
    if (!response.ok) throw await errorOf(response);
    const meta = await response.json().catch(() => ({}));
    return { ride: next, generation: String(meta?.generation ?? ''), updated: true };
  }
  throw await errorOf(last);
}

/** Record the launch outcome on a freshly claimed ride. */
export function withLaunch(ride, { ok, operation = null, error = null, now }) {
  return { ...ride, status: ok ? 'launched' : 'launch_failed', launch: { ok, operation, error, at: now.toISOString() } };
}

/** True when a start may take the ride over: the launch failed, or it never reported back within STALE_LAUNCH_MS. */
export function launchStale(ride, now) {
  if (ride.status === 'launch_failed') return true;
  if (ride.status !== 'launching') return false;
  const claimed = Date.parse(ride.claimed_at);
  return !Number.isFinite(claimed) || now.getTime() - claimed > STALE_LAUNCH_MS;
}

/** Re-claim a ride whose launch failed or stalled: a fresh claim time, status back to launching. */
export function relaunched(ride, { now, gpsFrom, gpsUntil, fenceAt }) {
  return {
    ...ride,
    fence_at: fenceAt,
    claimed_at: now.toISOString(),
    gps_from: gpsFrom.toISOString(),
    gps_until: gpsUntil.toISOString(),
    status: 'launching',
    launch: null,
  };
}

/** Append one fix. The phone's units are kept and m/s is added beside them. */
export function withFix(ride, { at, now, lat, lon, accuracyM = null, speedKmh = null }) {
  const fix = {
    at: at.toISOString(),
    received_at: now.toISOString(),
    lat,
    lon,
    accuracy_m: accuracyM,
    speed_kmh: speedKmh,
    speed_mps: speedKmh === null ? null : Math.round((speedKmh / 3.6) * 100) / 100,
  };
  return { ...ride, fixes: [...(ride.fixes ?? []), fix] };
}

/** Mark a ride cancelled. A second cancel keeps the first reason and time. */
export function withCancel(ride, { reason, now }) {
  if (ride.cancel) return ride;
  return { ...ride, cancel: { reason, at: now.toISOString() } };
}

const has = (list, key) => Array.isArray(list) && list.some((e) => e?.key === key);

/** Job: record the locked train. */
export function withLock(ride, { trainId, now, departedAt = null, meanDistanceM = null }) {
  return { ...ride, lock: { method: 'gps', train_id: trainId, at: now.toISOString(), departed_at: departedAt, mean_distance_m: meanDistanceM } };
}

/** Job: where the ride is up to, so a restarted Job resumes instead of starting over. */
export function withTracking(ride, tracking) {
  return { ...ride, tracking: { ...(ride.tracking ?? {}), ...tracking } };
}

/** Job: record an alert before it is sent. Null when `key` is already there, so an alert is recorded at most once. */
export function withAlert(ride, { key, now, station, trainId, circuit = null, title, text }) {
  if (has(ride.alerts, key)) return null;
  return { ...ride, alerts: [...(ride.alerts ?? []), { key, at: now.toISOString(), station, train_id: trainId, circuit, title, text }] };
}

/** Job: record a status push before it is sent. Null when `key` was pushed already. */
export function withStatus(ride, { key, now, text }) {
  if (has(ride.statuses, key)) return null;
  return { ...ride, statuses: [...(ride.statuses ?? []), { key, at: now.toISOString(), text }] };
}

/** Job: the ride is over. A second end keeps the first. */
export function withEnded(ride, { reason, now }) {
  if (ride.ended) return ride;
  return { ...ride, status: 'ended', ended: { reason, at: now.toISOString() } };
}

/** What the phone needs to know about a ride: is it locked, cancelled or over. Never the cancel token. */
export function summary(ride) {
  const locked = ride.lock !== null && ride.lock !== undefined;
  const cancelled = Boolean(ride.cancel);
  const ended = ride.ended !== null && ride.ended !== undefined;
  return { status: ride.status ?? null, locked, cancelled, ended, done: locked || cancelled || ended, fixes: ride.fixes?.length ?? 0 };
}

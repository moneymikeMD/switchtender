// Shadow scoring of track-work windows by the lab's decision model (CMB-159).
//
// For each active window the gateway is asked one yes/no question: does the
// notice slow or replace trains between the rider's origin and destination in
// their direction of travel? The answer is logged beside the flat penalty and
// never applied (rule 3). Unset URL means the model is not consulted (rule 4).

import { PENALTY_TRACK_WORK } from './verdict.js';

export const DEFAULT_MODEL = 'jev';

/** Most windows asked about per run; a window past the cap counts as a failed answer. */
export const MAX_MODEL_WINDOWS = 8;

const CRITERIA = {
  yes: 'The notice means trains are slowed, single-tracked, shuttled or replaced by buses on the rider stretch, in the rider direction of travel.',
  no: 'The notice affects only other stations or lines, the other direction, or does not change train service on the rider stretch.',
};

function stateFor(window, trip) {
  const lines = (window.lines ?? []).join(', ');
  return `Metro notice for the ${lines} Line: ${window.description}\nRider trip: ${trip.direction}, from ${trip.origin} to ${trip.destination}, riding the ${(trip.lines ?? []).join(', ')} Line.`;
}

function probabilityOf(body) {
  const p = body?.answers?.affects?.probabilities?.yes;
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

async function ask(window, trip, { url, key, model, fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state: stateFor(window, trip), questions: { affects: { type: 'choice', criteria: CRITERIA } } }),
      signal,
    });
  } catch (cause) {
    return { p: null, error: `network error (${cause?.name ?? 'Error'})` };
  }
  if (!response?.ok) return { p: null, error: `HTTP ${typeof response?.status === 'number' ? response.status : 'unknown'}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { p: null, error: 'malformed answer' };
  }
  const p = probabilityOf(body);
  return p === null ? { p: null, error: 'malformed answer' } : { p, error: null };
}

/**
 * Ask the model about each active window, in parallel, and return
 * { p, penaltyShadow, error } or null when TRACKWORK_MODEL_URL is unset.
 * penaltyShadow is the flat penalty times the largest p, the flat penalty when any window failed, or null with no active window.
 */
export async function shadowTrackwork(activeWindows, trip, { fetchImpl = fetch, signal, env = process.env } = {}) {
  const url = env.TRACKWORK_MODEL_URL;
  if (!url) return null;
  if (!Array.isArray(activeWindows) || activeWindows.length === 0) return { p: null, penaltyShadow: null, error: null };
  const settings = { url, key: env.TRACKWORK_MODEL_KEY ?? '', model: env.TRACKWORK_MODEL || DEFAULT_MODEL, fetchImpl, signal };
  const asked = activeWindows.slice(0, MAX_MODEL_WINDOWS);
  const answers = await Promise.all(
    asked.map((w) => ask(w, trip, settings).catch((cause) => ({ p: null, error: `unexpected error (${cause?.name ?? 'Error'})` }))),
  );
  if (activeWindows.length > asked.length) answers.push({ p: null, error: 'too many windows' });
  const errors = [...new Set(answers.flatMap((a) => (a.error ? [a.error] : [])))];
  if (errors.length > 0) return { p: null, penaltyShadow: PENALTY_TRACK_WORK, error: errors.join(' | ') };
  const p = Math.max(...answers.map((a) => a.p));
  return { p, penaltyShadow: PENALTY_TRACK_WORK * p, error: null };
}

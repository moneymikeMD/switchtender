// Push the verdict to the owner's phone (CMB-37, CMB-83).
//
// Only `/verdict?notify=1` reaches this module. Cloud Scheduler sets it at
// 7:30 on office days, so the owner sees the trip on sitting down in the car,
// and it sends every time (owner decision 2026-09-28). The phone's geofence
// call and the hourly samples never set it.
//
// Channel: ntfy.sh, the public instance (CMB-36 -- not the homelab's
// self-hosted lab-ntfy, so this scale-to-zero public service never needs a
// path into a private network). The free tier has no per-topic auth, so the
// topic name itself is the secret (CLAUDE.md rule 7): a long random slug,
// read from NTFY_TOPIC at call time and never logged, never the literal
// word "switchtender" or anything guessable.

const NTFY_URL = 'https://ntfy.sh';

// The notification title, readable at a glance before the body is opened.
const TITLE = { drive: 'switchtender: keep driving', transit: 'switchtender: take the train' };

/** Never throws (same policy as src/log.js). `sent` is false when no topic is configured or the push failed; `ok`/`error` tell them apart. */
export async function pushVerdict({ choice, spoken, topic, fetchImpl = fetch, signal }) {
  if (!topic) return { ok: true, sent: false, error: null };
  try {
    const response = await fetchImpl(`${NTFY_URL}/${topic}`, { method: 'POST', headers: { Title: TITLE[choice] ?? 'switchtender' }, body: spoken, signal });
    if (!response.ok) return { ok: false, sent: false, error: `ntfy ${response.status}` };
    return { ok: true, sent: true, error: null };
  } catch (cause) {
    return { ok: false, sent: false, error: `network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}` };
  }
}

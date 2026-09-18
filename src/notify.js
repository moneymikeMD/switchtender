// Push a notification when the verdict flips from the last one sent (CMB-37).
//
// Only `/verdict?notify=1` reaches this module -- the phone's geofence-
// triggered call and any manual poll never set that flag, so a push happens
// at most once a day, only when the drive-vs-transit choice actually
// changed. Cloud Scheduler is the one caller that sets it (CMB-36).
//
// Channel: ntfy.sh, the public instance (CMB-36 -- not the homelab's
// self-hosted lab-ntfy, so this scale-to-zero public service never needs a
// path into a private network). The free tier has no per-topic auth, so the
// topic name itself is the secret (CLAUDE.md rule 7): a long random slug,
// read from NTFY_TOPIC at call time and never logged, never the literal
// word "switchtender" or anything guessable.

const NTFY_URL = 'https://ntfy.sh';

/** Never throws (same policy as src/log.js). `sent` is false both for "nothing to say" and a failed push; check `ok`/`error` to tell them apart. */
export async function pushIfChanged({ choice, previousChoice, spoken, topic, fetchImpl = fetch, signal }) {
  if (!topic) return { ok: true, sent: false, error: null };
  if (previousChoice === null || previousChoice === choice) return { ok: true, sent: false, error: null };
  try {
    const response = await fetchImpl(`${NTFY_URL}/${topic}`, {
      method: 'POST',
      headers: { Title: 'switchtender verdict changed' },
      body: spoken,
      signal,
    });
    if (!response.ok) return { ok: false, sent: false, error: `ntfy ${response.status}` };
    return { ok: true, sent: true, error: null };
  } catch (cause) {
    return { ok: false, sent: false, error: `network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}` };
  }
}

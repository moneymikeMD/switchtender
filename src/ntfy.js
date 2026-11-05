// Shared ntfy publish for the verdict push and the ride pushes (CMB-160).
//
// The base URL comes from NTFY_BASE_URL (default https://ntfy.sh) and, when NTFY_RELAY_KEY is set,
// it is sent as X-Relay-Key. Both are read at call time. The topic is never logged or put in an error.

export const DEFAULT_NTFY_URL = 'https://ntfy.sh';
export const MAX_RETRY_AFTER_S = 10;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Publish base URL and relay header from the environment; ntfy.sh with no extra header when unset. */
export function ntfyConfig(env = process.env) {
  const base = (env.NTFY_BASE_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_NTFY_URL;
  const relayKey = (env.NTFY_RELAY_KEY ?? '').trim();
  return { base, relayKey };
}

async function refusal(response) {
  let code = null;
  try {
    const parsed = JSON.parse(await response.text());
    if (Number.isInteger(parsed?.code)) code = parsed.code;
  } catch {
    code = null;
  }
  const raw = response.headers?.get?.('retry-after');
  const seconds = raw !== null && raw !== undefined && /^\d+$/.test(String(raw).trim()) ? Number(raw) : null;
  return { code, seconds };
}

/**
 * POST one message to <base>/<topic>. On a 429 with Retry-After of 10 s or less, retries once after that wait.
 * Never throws; the error string is 'ntfy <status>[ <code>][ retry-after <s>]'.
 */
export async function publish({ topic, headers, body, fetchImpl = fetch, signal, env = process.env, sleep = defaultSleep }) {
  const { base, relayKey } = ntfyConfig(env);
  const sendHeaders = relayKey ? { ...headers, 'X-Relay-Key': relayKey } : headers;
  try {
    let response = await fetchImpl(`${base}/${topic}`, { method: 'POST', headers: sendHeaders, body, signal });
    let detail = null;
    if (!response.ok) {
      detail = await refusal(response);
      if (response.status === 429 && detail.seconds !== null && detail.seconds <= MAX_RETRY_AFTER_S) {
        await sleep(detail.seconds * 1000);
        response = await fetchImpl(`${base}/${topic}`, { method: 'POST', headers: sendHeaders, body, signal });
        if (!response.ok) detail = await refusal(response);
      }
    }
    if (response.ok) return { ok: true, sent: true, error: null };
    const parts = [`ntfy ${response.status}`];
    if (detail?.code !== null && detail?.code !== undefined) parts.push(String(detail.code));
    if (detail?.seconds !== null && detail?.seconds !== undefined) parts.push(`retry-after ${detail.seconds}`);
    return { ok: false, sent: false, error: parts.join(' ') };
  } catch (cause) {
    return { ok: false, sent: false, error: `network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}` };
  }
}

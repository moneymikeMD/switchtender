// One way to ask a feed for JSON or text.
//
// Every optional signal used to carry its own copy of this: six fetch
// wrappers with drifting User-Agent strings, one of which checked for a
// missing response and five of which did not, none of which took a deadline.
// This is the single copy. It never throws; a failure is { error } with a
// message that names the failure class and never the URL, because a network
// error's message can embed the URL and the URL can carry a key.
//
// `signal` is an AbortSignal (usually AbortSignal.timeout) so a stalled
// vendor costs a bounded wait, not the verdict. An abort reports as a network
// error named after the signal's reason ("network error (TimeoutError)").

export const USER_AGENT = 'switchtender/1 (Node fetch)';

function urlFor(target, query) {
  const url = new URL(typeof target === 'string' ? target : target.url);
  const params = { ...(typeof target === 'string' ? {} : target.params ?? {}), ...query };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function get(target, accept, { fetchImpl = fetch, query = {}, headers = {}, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(urlFor(target, query), {
      method: 'GET',
      headers: { Accept: accept, 'User-Agent': USER_AGENT, ...headers },
      signal,
    });
  } catch (cause) {
    return { error: `network error (${cause?.name ?? 'Error'})` };
  }
  if (!response?.ok) return { error: `HTTP ${response?.status ?? 'unknown'}` };
  return { response };
}

/**
 * GET JSON. `target` is a URL string or { url, params }; `query` adds or
 * overrides parameters (this is where a key goes, at call time).
 * Returns { data } or { error }.
 */
export async function getJson(target, options = {}) {
  const got = await get(target, 'application/json', options);
  if (got.error) return got;
  try {
    return { data: await got.response.json() };
  } catch {
    return { error: 'unparseable response' };
  }
}

/** GET text (an HTML page). Returns { text } or { error }. */
export async function getText(target, options = {}) {
  const got = await get(target, 'text/html', options);
  if (got.error) return got;
  try {
    return { text: await got.response.text() };
  } catch {
    return { error: 'unparseable response' };
  }
}

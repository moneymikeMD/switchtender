// Ride pushes to the phone over ntfy.sh (CMB-152). Their own topic,
// RIDE_NTFY_TOPIC, never NTFY_TOPIC: the phone's vibrate macro (CMB-154)
// listens here and must not fire on the 7:30 verdict push.
//
// Wire format, which the MacroDroid macro parses and which docs/configuration.md
// repeats:
//
//   POST https://ntfy.sh/<RIDE_NTFY_TOPIC>
//   Title:    "Ride alert"   an alert that vibrates until dismissed
//             "Ride"         an alert that buzzes once
//             "Ride status"  a status line, not an alert
//   Priority: 5 for every alert and for a vibrating status; 3 for the quiet lock status
//   Body:     <text>|<send epoch seconds>     e.g. "Next stop Gallery Place. Transfer to Green.|1761045600"
//             The phone's delay is {system_time} minus the number after the last "|".
//   Actions:  on alerts only, two ntfy http actions, default method POST, clear=true:
//             "I'm off"     -> <RIDE_SERVICE_URL>/ride/cancel?leg=<leg>&reason=off&token=<cancel_token>
//             "Not riding"  -> <RIDE_SERVICE_URL>/ride/cancel?leg=<leg>&reason=not-riding&token=<cancel_token>
//             The token is the ride's own cancel_token, never the shared key: ntfy keeps
//             action headers in the message, readable by anyone holding the topic.
//
// Never throws (same policy as src/notify.js); the topic is never logged.

export const NTFY_URL = 'https://ntfy.sh';

export const TITLE = Object.freeze({ alert: 'Ride alert', once: 'Ride', status: 'Ride status' });
export const PRIORITY = Object.freeze({ loud: 5, quiet: 3 });
export const BODY_SEPARATOR = '|';
export const ACTION_LABELS = Object.freeze({ off: "I'm off", 'not-riding': 'Not riding' });

/** `<text>|<epoch seconds>`: the text, then when it was sent. */
export function rideBody(text, sentAtMs) {
  return `${text}${BODY_SEPARATOR}${Math.floor(sentAtMs / 1000)}`;
}

/** The ntfy Actions header for the two cancel buttons, or null without a service URL or token. */
export function cancelActions({ serviceUrl, leg, token }) {
  if (!serviceUrl || !token) return null;
  const base = serviceUrl.replace(/\/+$/, '');
  return Object.entries(ACTION_LABELS)
    .map(
      ([reason, label]) => `http, ${label}, ${base}/ride/cancel?leg=${encodeURIComponent(leg)}&reason=${reason}&token=${encodeURIComponent(token)}, clear=true`,
    )
    .join('; ');
}

/**
 * Send one ride push. `kind` is 'alert' (vibrate until dismissed), 'once'
 * (one buzz) or 'status'; a status is loud unless `quiet`. Returns
 * { ok, sent, error }; `sent` is false without a topic.
 */
export async function pushRide({ topic, kind, text, sentAtMs = Date.now(), quiet = false, actions = null, fetchImpl = fetch, signal }) {
  if (!topic) return { ok: true, sent: false, error: null };
  const title = TITLE[kind];
  if (!title) return { ok: false, sent: false, error: `unknown push kind ${kind}` };
  const headers = { Title: title, Priority: String(kind === 'status' && quiet ? PRIORITY.quiet : PRIORITY.loud) };
  if (actions) headers.Actions = actions;
  try {
    const response = await fetchImpl(`${NTFY_URL}/${topic}`, { method: 'POST', headers, body: rideBody(text, sentAtMs), signal });
    if (!response.ok) return { ok: false, sent: false, error: `ntfy ${response.status}` };
    return { ok: true, sent: true, error: null };
  } catch (cause) {
    return { ok: false, sent: false, error: `network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}` };
  }
}

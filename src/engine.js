// The pipeline, with no console attached.
//
// One function turns a loaded config into a verdict and its spoken line. The
// CLI (src/index.js) prints what comes back; the HTTP server (src/server.js)
// serialises it. Both go through here so that the two can never disagree
// about what the verdict is.
//
// Behaviour, in order, matching what the CLI did when this was inlined:
//   1. Live incidents start only when TRAFFIC_API_KEY is set; otherwise null.
//   2. Planned District closures start before routing (they need only the
//      config bounding box).
//   3. Routing. A RouteError propagates: routing is the required signal and
//      the caller decides how to say nothing.
//   4. Maryland CHART needs the drive-through polyline, so it starts after.
//   5. decide() sees all four context fields.
//   6. Logging is optional, never throws, and its status is returned rather
//      than printed.

import { computeOptions } from './routes.js';
import { decide, speak } from './verdict.js';
import { fetchIncidents } from './incidents.js';
import { logVerdict } from './log.js';
import { fetchClosures } from './closures.js';
import { fetchChart } from './chart.js';
import { fetchEvents } from './events.js';
import { fetchTrackwork } from './trackwork.js';

/**
 * Compute the verdict for a loaded config.
 *
 * @param config   the object loadConfig() returns (route, decision, secrets, log...)
 * @param options.fetchImpl  fetch replacement for tests; every feed uses it
 * @param options.now        Date the run is stamped with (log row, closure windows)
 * @param options.log        false skips the sheet write even if config enables it
 * @returns { options, incidents, closures, maryland, events, trackwork, verdict, spoken, logged }
 *          where events and trackwork are null when not consulted (no key, no lines),
 *          where logged is { ok, error } or null when nothing was attempted.
 * @throws RouteError when the onward options cannot be computed.
 */
export async function runVerdict(config, { fetchImpl = fetch, now = new Date(), log = true } = {}) {
  const { decision, secrets } = config;

  const trafficKey = secrets.keys.TRAFFIC_API_KEY;
  const incidentsPromise = trafficKey
    ? fetchIncidents(config, trafficKey, fetchImpl)
    : Promise.resolve(null);
  // Scheduled events (CMB-13) need only config and a key; planned track work
  // (CMB-26) needs only the configured lines. Both start with routing. A
  // missing key or an empty line list means the signal is not attempted and
  // stays null, which decide() reads as "not consulted", not "clear".
  const eventsKey = secrets.keys.EVENTS_API_KEY;
  const eventsPromise = eventsKey
    ? fetchEvents(config, eventsKey, fetchImpl, { now: now.getTime() })
    : Promise.resolve(null);
  const lines = config.transit?.lines ?? [];
  const trackworkPromise = lines.length > 0
    ? fetchTrackwork(lines, fetchImpl, {
        now: now.getTime(),
        timeZone: config.route.timezone,
        log: (line) => console.error(line),
      })
    : Promise.resolve(null);

  const options = await computeOptions(config, secrets.keys.ROUTES_API_KEY, fetchImpl);

  // Closures (CMB-28) and Maryland records (CMB-16) are matched against the
  // drive geometry, so both wait for the polyline.
  const points = options.driveThrough.points;
  const [incidents, closures, maryland, events, trackwork] = await Promise.all([
    incidentsPromise,
    fetchClosures(config, fetchImpl, { now: now.getTime(), points }),
    fetchChart(points, fetchImpl),
    eventsPromise,
    trackworkPromise,
  ]);

  const verdict = decide(options, decision, {
    degraded: secrets.degraded,
    incidents,
    closures,
    maryland,
    events,
    trackwork,
  });

  // CMB-11. Signals that postdate the frozen HEADER travel as extras and
  // become trailing columns. A failed write is reported, never thrown.
  let logged = null;
  if (log && config.log.enabled) {
    const extras = {
      closures_active: closures.active,
      closures_source_live: closures.sourceLive,
      closures_addresses: closures.addresses.join(' | '),
      maryland_on_route: maryland.onRoute,
      maryland_total: maryland.total,
      maryland_descriptions: maryland.descriptions.join(' | '),
      closures_total: closures.total,
      events_count: events ? events.count : null,
      events_evening: events ? events.evening : null,
      events_reasons: events ? (events.reasons ?? []).join(' | ') : null,
      trackwork_active: trackwork ? trackwork.active : null,
      trackwork_upcoming: trackwork ? trackwork.upcoming : null,
      trackwork_stale_windows: trackwork ? trackwork.staleWindows : null,
    };
    logged = await logVerdict({ now, config, options, incidents, verdict, extras, fetchImpl });
  }

  return {
    options,
    incidents,
    closures,
    maryland,
    events,
    trackwork,
    verdict,
    spoken: speak(verdict),
    logged,
  };
}

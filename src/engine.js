// The pipeline, with no console attached.
//
// One function turns a loaded config into a verdict and its spoken line. The
// CLI (src/index.js) prints what comes back; the HTTP server (src/server.js)
// serialises it. Both go through here so that the two can never disagree
// about what the verdict is.
//
// Behaviour, in order:
//   1. Every optional signal starts at once, alongside routing, each with its
//      own deadline (SIGNAL_TIMEOUT_MS). Live incidents, District closures and
//      Maryland CHART are fetched now and matched to the route later; events
//      and track work need no geometry and run to completion. None of these
//      can reject: each module catches everything and reports the unknown
//      shape, and a guard here catches a module that forgets, so nothing is
//      left as an unhandled rejection while routing is still in flight.
//   2. Routing. A RouteError propagates: routing is the required signal and
//      the caller decides how to say nothing.
//   3. The three spatial signals are assessed against the drive polyline.
//   4. decide() sees every signal. A missing optional key reaches it as that
//      signal's own unknown result, charged once; the engine passes no
//      `degraded` list.
//   5. Logging is optional, bounded by LOG_TIMEOUT_MS, never throws, and its
//      status is returned rather than printed.

import { computeOptions } from './routes.js';
import { decide, speak } from './verdict.js';
import { loadIncidents, assessTrajectory, unknownIncidents } from './incidents.js';
import { logVerdict } from './log.js';
import { loadClosures, assessClosures, unknownClosures } from './closures.js';
import { loadChart, assessChart, unknownChart } from './chart.js';
import { fetchEvents, unknownEvents } from './events.js';
import { fetchTrackwork, unknownTrackwork } from './trackwork.js';
import { fetchWmata, unknownWmata } from './wmata.js';

// A vendor that has not answered by now costs its signal, not the verdict.
// DDOT used to take 6 s on its own before the envelope filter was dropped;
// the phone's server answers 504 at 20 s whatever happens in here.
export const SIGNAL_TIMEOUT_MS = 8_000;

// The sheet write happens after the verdict is known, so a stalled Sheets or
// metadata call is the one thing that could hold a computed answer hostage.
export const LOG_TIMEOUT_MS = 4_000;

// A module's fetch is documented never to throw. If one does anyway, the
// result is its unknown shape, not a crashed process.
const guard = (promise, unknown) => promise.catch((cause) => ({ failure: unknown(`unexpected error (${cause?.name ?? 'Error'})`) }));
const guardWhole = (promise, unknown) => promise.catch((cause) => unknown(`unexpected error (${cause?.name ?? 'Error'})`));

/**
 * Compute the verdict for a loaded config.
 *
 * @param config   the object loadConfig() returns (route, decision, secrets, log...)
 * @param options.fetchImpl  fetch replacement for tests; every feed uses it
 * @param options.now        Date the run is stamped with (log row, closure windows)
 * @param options.log        false skips the sheet write even if config enables it
 * @param options.from       'fork' (default) for the verdict at the fork, 'origin'
 *                           for a whole-trip estimate from home (CMB-30)
 * @param options.signalTimeoutMs  deadline per optional feed
 * @param options.logTimeoutMs     deadline for the sheet write
 * @returns { options, incidents, closures, maryland, events, trackwork, wmata, verdict, spoken, logged }
 *          where events and trackwork are null when not consulted (no venues, no lines),
 *          where logged is { ok, error } or null when nothing was attempted.
 * @throws RouteError when the onward options cannot be computed.
 */
export async function runVerdict(
  config,
  { fetchImpl = fetch, now = new Date(), log = true, from = 'fork', signalTimeoutMs = SIGNAL_TIMEOUT_MS, logTimeoutMs = LOG_TIMEOUT_MS } = {},
) {
  const { decision, secrets } = config;
  const nowMs = now.getTime();
  const deadline = () => AbortSignal.timeout(signalTimeoutMs);

  const incidentsLoad = guard(loadIncidents(config, secrets.keys.TRAFFIC_API_KEY ?? null, fetchImpl, { signal: deadline() }), unknownIncidents);
  const closuresLoad = guard(loadClosures(config, fetchImpl, { now: nowMs, signal: deadline() }), unknownClosures);
  const chartLoad = guard(loadChart(fetchImpl, { now: nowMs, signal: deadline() }), unknownChart);
  // Scheduled events (CMB-13, CMB-25) run whenever venues are configured:
  // fetchEvents routes each venue to its provider and copes with a missing
  // Ticketmaster key itself, because mlb venues need no key at all. Planned
  // track work (CMB-26) needs only the configured lines. No venues or no
  // lines means the signal is not attempted and stays null, which decide()
  // reads as "not consulted", not "clear".
  const eventsPromise =
    (config.venues ?? []).length > 0
      ? guardWhole(fetchEvents(config, secrets.keys.EVENTS_API_KEY ?? null, fetchImpl, { now: nowMs, signal: deadline() }), unknownEvents)
      : Promise.resolve(null);
  const lines = config.transit?.lines ?? [];
  const trackworkPromise =
    lines.length > 0
      ? guardWhole(
          fetchTrackwork(lines, fetchImpl, { now: nowMs, timeZone: config.route.timezone, log: (line) => console.error(line), signal: deadline() }),
          unknownTrackwork,
        )
      : Promise.resolve(null);
  // WMATA rail alerts (CMB-35): same gate as track work (no lines configured
  // means transit isn't scored at all), missing key handled inside fetchWmata.
  const wmataPromise =
    lines.length > 0
      ? guardWhole(fetchWmata(lines, secrets.keys.TRANSIT_API_KEY ?? null, fetchImpl, { signal: deadline() }), unknownWmata)
      : Promise.resolve(null);

  const options = await computeOptions(config, secrets.keys.ROUTES_API_KEY, fetchImpl, { from, now });

  // Incidents (CMB-22, route-matched since 2026-09-17), closures (CMB-28) and
  // Maryland records (CMB-16) are matched against the drive geometry.
  const points = options.driveThrough.points;
  const [incidentsLoaded, closuresLoaded, chartLoaded, events, trackwork, wmata] = await Promise.all([
    incidentsLoad,
    closuresLoad,
    chartLoad,
    eventsPromise,
    trackworkPromise,
    wmataPromise,
  ]);
  const incidents = incidentsLoaded.failure ?? assessTrajectory(incidentsLoaded.incidents, { now: nowMs, points });
  const closures = closuresLoaded.failure ?? assessClosures(closuresLoaded.records, { now: nowMs, sourceLive: true, points });
  const maryland = chartLoaded.failure ?? assessChart(chartLoaded.records, points, { now: nowMs, sourceLive: true });

  const verdict = decide(options, decision, { incidents, closures, maryland, events, trackwork, wmata, now, timeZone: config.route.timezone });

  // CMB-11. Signals that postdate the frozen HEADER travel as extras and
  // become the EXTRA_COLUMNS, in that order. A failed write is reported,
  // never thrown; a stalled one is cut off by the deadline.
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
      // CMB-29 to CMB-32. A row from home is not comparable with a row from
      // the fork, so the start point travels with it.
      measured_from: options.measuredFrom ?? 'fork',
      drive_walk_seconds: options.driveThrough.walkSeconds ?? 0,
      drive_arrival: verdict.driveArrival,
      transit_arrival: verdict.transitArrival,
      transit_walk_seconds: options.parkAndRide.walkSeconds ?? 0,
      incidents_route_matched: incidents.score === null ? null : incidents.routeMatched,
      wmata_active: wmata && !wmata.unknown ? wmata.active : null,
      wmata_lines: wmata && !wmata.unknown ? (wmata.lines ?? []).join(' | ') : null,
      wmata_categories: wmata && !wmata.unknown ? (wmata.categories ?? []).join(' | ') : null,
      wmata_reasons: wmata && !wmata.unknown ? (wmata.reasons ?? []).join(' | ') : null,
    };
    logged = await logVerdict({ now, config, options, incidents, verdict, extras, fetchImpl, signal: AbortSignal.timeout(logTimeoutMs) });
  }

  return { options, incidents, closures, maryland, events, trackwork, wmata, verdict, spoken: speak(verdict), logged };
}

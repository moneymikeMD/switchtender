// Entry point.
//
// Loads configuration, computes the two onward options from the fork, decides
// between them and prints both the spoken line and the structured verdict.
// Every field of the verdict is printed because it will be logged (CMB-11) and
// the rule's starting values are tuned from that log.

import { loadConfig, ConfigError } from './config.js';
import { computeOptions, RouteError } from './routes.js';
import { decide, speak } from './verdict.js';
import { fetchIncidents } from './incidents.js';
import { logVerdict } from './log.js';

const CONFIG_PATH = process.env.SWITCHTENDER_CONFIG ?? 'config.toml';

const minutes = (seconds) => `${Math.round(seconds / 60)} min`;

function describeCongestion(congestion) {
  if (congestion.unknown) return 'congestion unknown';
  const jammedKm = congestion.metres.TRAFFIC_JAM / 1000;
  const slowKm = congestion.metres.SLOW / 1000;
  const parts = [`score ${congestion.score.toFixed(2)}`];
  if (jammedKm > 0.05) parts.push(`${jammedKm.toFixed(1)} km jammed`);
  if (slowKm > 0.05) parts.push(`${slowKm.toFixed(1)} km slow`);
  return parts.join(', ');
}

async function main() {
  let config;
  try {
    config = loadConfig(CONFIG_PATH);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Deliberately not a stack trace. This is the one error an operator is
      // most likely to hit and least likely to want to read a trace for.
      console.error(error.message);
      if (error.message.includes('could not read')) {
        console.error('Copy config.example.toml to config.toml to get started.');
      }
      process.exit(1);
    }
    throw error;
  }

  const { route, decision, venues, secrets } = config;
  console.log(`switchtender: config loaded from ${CONFIG_PATH}`);
  console.log(`  fork at       ${route.decision_point.label}`);
  console.log(`  driving to    ${route.destination.label}`);
  console.log(`  or parking at ${route.park_and_ride.label}`);
  console.log(
    `  transit wins ties: ${decision.transit_wins_ties}, drive must win by ${decision.minimum_drive_margin_minutes} min`,
  );
  console.log(`  venues watched: ${venues.length}`);

  if (secrets.degraded.length > 0) {
    console.log(
      `  degraded, no key set: ${secrets.degraded.join(', ')} (confidence will be lower)`,
    );
  }

  // The incident lookup is optional and never throws; it runs alongside the
  // three routing requests. Without a key it is skipped entirely and the
  // degraded list already says so.
  const trafficKey = secrets.keys.TRAFFIC_API_KEY;
  const incidentsPromise = trafficKey ? fetchIncidents(config, trafficKey) : Promise.resolve(null);

  let options;
  try {
    options = await computeOptions(config, secrets.keys.ROUTES_API_KEY);
  } catch (error) {
    if (error instanceof RouteError) {
      // Routing is the required signal, so this is fatal rather than degrading.
      // Saying nothing is the correct output when the numbers cannot be had.
      console.error(`\n${error.message}`);
      console.error('No verdict: the onward options could not be computed.');
      process.exit(1);
    }
    throw error;
  }

  const { driveThrough, parkAndRide } = options;
  console.log(`\nFrom ${route.decision_point.label}:`);
  console.log(
    `  keep driving   ${minutes(driveThrough.totalSeconds).padEnd(8)} ${describeCongestion(driveThrough.congestion)}`,
  );
  console.log(
    `  park and ride  ${minutes(parkAndRide.totalSeconds).padEnd(8)} ${minutes(parkAndRide.driveSeconds)} drive + ${minutes(parkAndRide.bufferSeconds)} buffer + ${minutes(parkAndRide.transitSeconds)} transit`,
  );

  const incidents = await incidentsPromise;
  if (incidents) {
    const state = incidents.score === null ? 'unknown' : incidents.unstable ? 'UNSTABLE' : 'steady';
    const count = incidents.count === null ? '' : `, ${incidents.count} incidents in box`;
    console.log(`  live incidents ${state}${count}`);
  }

  const verdict = decide(options, decision, { degraded: secrets.degraded, incidents });
  console.log('\nVerdict:');
  for (const [key, value] of Object.entries(verdict)) {
    console.log(`  ${key.padEnd(22)} ${Array.isArray(value) ? value.join('; ') : value}`);
  }
  console.log(`\n${speak(verdict)}`);

  // CMB-11. Logging never blocks the verdict, so it runs after the spoken
  // line and reports in one line. The sheet id is an address, not a secret,
  // but it is still not echoed in full.
  if (config.log.enabled) {
    const logged = await logVerdict({ now: new Date(), config, options, incidents, verdict });
    const tail = config.log.sheet_id.slice(-4);
    console.log(
      logged.ok
        ? `logged to sheet ...${tail} tab ${config.log.sheet_tab}`
        : `log failed: ${logged.error}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Command-line entry point.
//
// Loads configuration, runs the shared pipeline (src/engine.js) and prints
// both the structured verdict and the spoken line. Every field of the verdict
// is printed because it is logged (CMB-11) and the rule's starting values are
// tuned from that log. The same pipeline serves HTTP from src/server.js.

import { loadConfig, ConfigError } from './config.js';
import { RouteError } from './routes.js';
import { runVerdict } from './engine.js';

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

  let result;
  try {
    result = await runVerdict(config);
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

  const { options, incidents, closures, maryland, verdict, spoken, logged } = result;
  const { driveThrough, parkAndRide } = options;
  console.log(`\nFrom ${route.decision_point.label}:`);
  console.log(
    `  keep driving   ${minutes(driveThrough.totalSeconds).padEnd(8)} ${describeCongestion(driveThrough.congestion)}`,
  );
  console.log(
    `  park and ride  ${minutes(parkAndRide.totalSeconds).padEnd(8)} ${minutes(parkAndRide.driveSeconds)} drive + ${minutes(parkAndRide.bufferSeconds)} buffer + ${minutes(parkAndRide.transitSeconds)} transit`,
  );

  if (incidents) {
    const state = incidents.score === null ? 'unknown' : incidents.unstable ? 'UNSTABLE' : 'steady';
    const count = incidents.count === null ? '' : `, ${incidents.count} incidents in box`;
    console.log(`  live incidents ${state}${count}`);
  }
  console.log(
    closures.active === null
      ? `  planned closures unknown (${closures.reasons[0]})`
      : `  planned closures ${closures.active} active in box`,
  );
  console.log(
    maryland.onRoute === null
      ? `  maryland records unknown (${maryland.reasons[0]})`
      : `  maryland records ${maryland.onRoute} on route of ${maryland.total}`,
  );

  console.log('\nVerdict:');
  for (const [key, value] of Object.entries(verdict)) {
    console.log(`  ${key.padEnd(22)} ${Array.isArray(value) ? value.join('; ') : value}`);
  }

  // Log status goes to stderr so that stdout ends with the spoken line and
  // nothing else: `npm start 2>/dev/null | tail -1 | say` must hear the
  // verdict, not the log receipt. The sheet id is an address, not a secret,
  // but it is still not echoed in full.
  if (logged) {
    const tail = config.log.sheet_id.slice(-4);
    console.error(
      logged.ok
        ? `logged to sheet ...${tail} tab ${config.log.sheet_tab}`
        : `log failed: ${logged.error}`,
    );
  }

  // Last line of stdout, always: the sentence the driver hears.
  console.log(`\n${spoken}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

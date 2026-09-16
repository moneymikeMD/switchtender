// Entry point.
//
// Right now this loads configuration, reports what it found, and exits. Route
// computation, the verdict and the spoken output are later tickets. The point
// of shipping it in this state is that a misconfigured install fails here,
// loudly, rather than three components deeper with a confusing message.

import { loadConfig, ConfigError } from './config.js';

const CONFIG_PATH = process.env.SWITCHTENDER_CONFIG ?? 'config.toml';

function main() {
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

  console.log('No verdict yet: route computation is not implemented.');
}

main();

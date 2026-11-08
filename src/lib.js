// Side-effect-free public entry for importing the engine as a package.
// Unlike src/index.js it starts no server and reads no environment on import.

export { runVerdict } from './engine.js';
export { parseConfig, buildConfig, ConfigError } from './config.js';
export { decide, speak } from './verdict.js';
export { findFork, approachPoint, leadMetres, FORK_TOLERANCE_METRES, METRES_PER_MILE, LEAD_MIN_MILES, LEAD_MAX_MILES, LEAD_DEFAULT_MILES } from './fork.js';

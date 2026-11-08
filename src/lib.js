// Side-effect-free public entry for importing the engine as a package.
// Unlike src/index.js it starts no server and reads no environment on import.

export { runVerdict } from './engine.js';
export { parseConfig, buildConfig, ConfigError } from './config.js';
export { decide, speak } from './verdict.js';

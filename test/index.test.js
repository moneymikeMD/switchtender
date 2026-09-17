// Tests for the CLI's argument parsing (src/index.js). Importing the module
// must not start a run: main() is guarded on being the entry point.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/index.js';
import { ConfigError } from '../src/config.js';

test('--from origin selects the whole-trip estimate; the default is the fork (CMB-30)', () => {
  assert.deepEqual(parseArgs([]), { from: 'fork' });
  assert.deepEqual(parseArgs(['--from', 'fork']), { from: 'fork' });
  assert.deepEqual(parseArgs(['--from', 'origin']), { from: 'origin' });
  assert.deepEqual(parseArgs(['--from=origin']), { from: 'origin' });
  assert.throws(() => parseArgs(['--from', 'garage']), ConfigError);
  assert.throws(() => parseArgs(['--from']), ConfigError);
  // An argument the CLI does not know is an error, never a silent fork.
  assert.throws(() => parseArgs(['--form', 'origin']), /unknown argument "--form"/);
  assert.throws(() => parseArgs(['origin']), ConfigError);
});

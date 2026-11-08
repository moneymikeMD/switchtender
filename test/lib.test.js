// The package entry resolves through the exports map and exposes the public API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('import("switchtender") resolves the public API through exports', async () => {
  const lib = await import('switchtender');
  for (const name of ['runVerdict', 'parseConfig', 'buildConfig', 'decide', 'speak', 'findFork', 'approachPoint', 'leadMetres']) {
    assert.equal(typeof lib[name], 'function', name);
  }
  for (const name of ['FORK_TOLERANCE_METRES', 'METRES_PER_MILE', 'LEAD_MIN_MILES', 'LEAD_MAX_MILES', 'LEAD_DEFAULT_MILES']) {
    assert.equal(typeof lib[name], 'number', name);
  }
});

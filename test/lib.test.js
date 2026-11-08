// The package entry resolves through the exports map and exposes the public API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('import("switchtender") resolves the public API through exports', async () => {
  const lib = await import('switchtender');
  for (const name of ['runVerdict', 'parseConfig', 'buildConfig', 'decide', 'speak']) {
    assert.equal(typeof lib[name], 'function', name);
  }
});

// Tests for the attribution builder (src/attributions.js). Pure: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAttributions } from '../src/attributions.js';
import { buildAttributions as fromLib } from '../src/lib.js';

const data = { unknown: false, score: 0, total: 0 };
const names = (input) => buildAttributions(input).map((a) => a.source);

test('Google is always listed and the builder is exported from the package entry (CMB-133)', () => {
  assert.equal(fromLib, buildAttributions);
  assert.deepEqual(names({}), ['Google']);
  assert.match(buildAttributions({})[0].text, /Google/);
});

test('null and unknown signals add nothing; signals with data add one entry each (CMB-133)', () => {
  assert.deepEqual(names({ incidents: { score: null }, closures: { total: null }, maryland: { total: null }, wmata: { unknown: true } }), ['Google']);
  assert.deepEqual(names({ incidents: data, closures: data, maryland: data, wmata: data }), ['Google', 'TomTom', 'CHART', 'DDOT', 'WMATA']);
});

test('events credit the providers of the configured venues, and track work its own page (CMB-133)', () => {
  const venues = [{ provider: 'mlb' }, { name: 'Arena' }];
  assert.deepEqual(names({ events: data, venues }), ['Google', 'Ticketmaster', 'MLB']);
  assert.deepEqual(names({ events: data, venues: [{ provider: 'mlb' }] }), ['Google', 'MLB']);
  assert.deepEqual(names({ events: { unknown: true }, venues }), ['Google']);
  assert.deepEqual(names({ trackwork: data }), ['Google', 'WMATA track work']);
});

test('no entry text claims WMATA endorsement (CMB-133)', () => {
  const all = buildAttributions({ wmata: data, trackwork: data });
  for (const { text } of all) assert.doesNotMatch(text, /endorse|approved|sponsor|official/i);
});

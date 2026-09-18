// Tests for the WMATA rail-alerts signal (CMB-35). No network: every case
// runs against a hand-built response or a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENDPOINT, linesAffected, assessWmata, unknownWmata, fetchWmata } from '../src/wmata.js';

const alert = (overrides) => ({ IncidentID: 'id', Description: 'Single tracking between A and B', LinesAffected: 'OR;', IncidentType: 'Alert', ...overrides });

test('linesAffected turns WMATA two-letter codes into the full names config.transit.lines uses', () => {
  assert.deepEqual(linesAffected('OR;RD;'), ['Orange', 'Red']);
  assert.deepEqual(linesAffected('SV;'), ['Silver']);
  assert.deepEqual(linesAffected(''), []);
  assert.deepEqual(linesAffected(null), []);
});

test('linesAffected drops an unrecognised code rather than throwing', () => {
  assert.deepEqual(linesAffected('OR;ZZ;RD;'), ['Orange', 'Red']);
});

test('assessWmata only counts incidents matching a configured line', () => {
  const incidents = [alert({ LinesAffected: 'OR;' }), alert({ LinesAffected: 'BL;' })];
  const result = assessWmata(incidents, ['Red', 'Blue']);
  assert.equal(result.active, 1);
  assert.deepEqual(result.lines, ['Blue']);
  assert.equal(result.unknown, false);
});

test('assessWmata normalises IncidentType to a category, "other" for anything unrecognised', () => {
  const incidents = [alert({ IncidentType: 'Alert' }), alert({ IncidentType: 'Something New' })];
  const result = assessWmata(incidents, ['Orange']);
  assert.deepEqual(result.categories.sort(), ['alert', 'other']);
});

test('assessWmata collects the descriptions of matched incidents as reasons', () => {
  const incidents = [alert({ Description: 'Delays on the Orange Line' })];
  const result = assessWmata(incidents, ['Orange']);
  assert.deepEqual(result.reasons, ['Delays on the Orange Line']);
});

test('no incidents matching any configured line is a clean zero, not unknown', () => {
  const result = assessWmata([alert({ LinesAffected: 'BL;' })], ['Red']);
  assert.equal(result.active, 0);
  assert.equal(result.unknown, false);
});

test('assessWmata on a non-array is unknown, never a thrown error', () => {
  assert.equal(assessWmata(null, ['Red']).unknown, true);
});

test('unknownWmata carries active: null, never 0 (CLAUDE.md rule 4)', () => {
  const result = unknownWmata('no TRANSIT_API_KEY');
  assert.equal(result.active, null);
  assert.equal(result.unknown, true);
  assert.match(result.reasons[0], /no TRANSIT_API_KEY/);
});

test('fetchWmata with no key is unknown without a network call', async () => {
  const fetchImpl = async () => {
    throw new Error('should not be called');
  };
  const result = await fetchWmata(['Red'], null, fetchImpl);
  assert.equal(result.unknown, true);
  assert.match(result.reasons[0], /no TRANSIT_API_KEY/);
});

test('fetchWmata sends the key as the api_key header and hits the confirmed endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ Incidents: [alert({ LinesAffected: 'RD;' })] }) };
  };
  const result = await fetchWmata(['Red'], 'test-key', fetchImpl);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.headers.api_key, 'test-key');
  assert.equal(result.active, 1);
});

test('fetchWmata on an HTTP failure is unknown, never a thrown error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const result = await fetchWmata(['Red'], 'test-key', fetchImpl);
  assert.equal(result.unknown, true);
  assert.equal(result.active, null);
});

test('fetchWmata on a network error is unknown, never a thrown error', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await fetchWmata(['Red'], 'test-key', fetchImpl);
  assert.equal(result.unknown, true);
});

test('the deadline rides along to the request', async () => {
  const signal = AbortSignal.timeout(10_000);
  const fetchImpl = async (_url, init) => {
    assert.equal(init.signal, signal);
    return { ok: true, status: 200, json: async () => ({ Incidents: [] }) };
  };
  await fetchWmata(['Red'], 'test-key', fetchImpl, { signal });
});

// Tests for the shadow track-work model (CMB-159). No network: the gateway is an injected fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shadowTrackwork, DEFAULT_MODEL, MAX_MODEL_WINDOWS } from '../src/trackwork-model.js';
import { fetchTrackwork } from '../src/trackwork.js';
import { PENALTY_TRACK_WORK } from '../src/verdict.js';

const CAPTURED = {
  model: 'jev-1.14.0',
  answers: { affects: { type: 'choice', choice: 'no', confidence: 0.16, probabilities: { yes: 0.42, no: 0.58 } } },
  usage: { input_tokens: 382, output_tokens: 32 },
};
const ENV = { TRACKWORK_MODEL_URL: 'https://gateway.example.test', TRACKWORK_MODEL_KEY: 'secret-key-123' };
const TRIP = { direction: 'inbound', origin: 'Park Lot', destination: 'Downtown', lines: ['Red'] };
const WINDOW = { lines: ['Red'], startsAt: 0, endsAt: 1, description: 'Single tracking between A and B' };

function gateway(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(calls.length);
  };
  return { calls, fetchImpl };
}
const ok = (body) => () => ({ ok: true, status: 200, json: async () => body });

test('the request carries the key in the header, the model and the yes/no question, and nothing else secret', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  await shadowTrackwork([WINDOW], TRIP, { fetchImpl, env: ENV });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://gateway.example.test/v1/systemone');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-key-123');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.match(body.state, /Single tracking between A and B/);
  assert.match(body.state, /inbound, from Park Lot to Downtown/);
  assert.deepEqual(Object.keys(body.questions.affects.criteria), ['yes', 'no']);
  assert.equal(body.questions.affects.type, 'choice');
  assert.ok(!init.body.includes('secret-key-123'));
  assert.ok(!url.includes('secret-key-123'));
});

test('TRACKWORK_MODEL overrides the default model name', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  await shadowTrackwork([WINDOW], TRIP, { fetchImpl, env: { ...ENV, TRACKWORK_MODEL: 'other' } });
  assert.equal(JSON.parse(calls[0].init.body).model, 'other');
});

test('the captured response gives p = 0.42 and a shadow penalty of 0.2 x 0.42', async () => {
  const { fetchImpl } = gateway(ok(CAPTURED));
  const r = await shadowTrackwork([WINDOW], TRIP, { fetchImpl, env: ENV });
  assert.deepEqual(r, { p: 0.42, penaltyShadow: PENALTY_TRACK_WORK * 0.42, error: null });
});

test('several windows are asked in parallel and the largest p scales the penalty', async () => {
  const ps = [0.1, 0.7, 0.3];
  const { calls, fetchImpl } = gateway((n) => ok({ answers: { affects: { probabilities: { yes: ps[n - 1] } } } })());
  const r = await shadowTrackwork([WINDOW, WINDOW, WINDOW], TRIP, { fetchImpl, env: ENV });
  assert.equal(calls.length, 3);
  assert.equal(r.p, 0.7);
  assert.equal(r.penaltyShadow, PENALTY_TRACK_WORK * 0.7);
});

for (const [name, answer, reason] of [
  ['a gateway 500', () => ({ ok: false, status: 500, json: async () => ({}) }), 'HTTP 500'],
  [
    'a timeout',
    () => Promise.reject(Object.assign(new Error('boom https://gateway.example.test secret-key-123'), { name: 'TimeoutError' })),
    'network error (TimeoutError)',
  ],
  ['a body with no answer', ok({ answers: {} }), 'malformed answer'],
  ['a probability outside 0..1', ok({ answers: { affects: { probabilities: { yes: 1.5 } } } }), 'malformed answer'],
  ['a non-number probability', ok({ answers: { affects: { probabilities: { yes: '0.4' } } } }), 'malformed answer'],
  ['an unparseable body', () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('x')) }), 'malformed answer'],
]) {
  test(`${name} falls back to the flat penalty with a reason that names no URL or key`, async () => {
    const { fetchImpl } = gateway(answer);
    const r = await shadowTrackwork([WINDOW], TRIP, { fetchImpl, env: ENV });
    assert.equal(r.p, null);
    assert.equal(r.penaltyShadow, PENALTY_TRACK_WORK);
    assert.equal(r.error, reason);
    assert.ok(!r.error.includes('secret-key-123') && !r.error.includes('gateway.example'));
  });
}

test('one failed window among several makes the shadow the flat penalty', async () => {
  const { fetchImpl } = gateway((n) => (n === 2 ? { ok: false, status: 502, json: async () => ({}) } : ok(CAPTURED)()));
  const r = await shadowTrackwork([WINDOW, WINDOW], TRIP, { fetchImpl, env: ENV });
  assert.equal(r.penaltyShadow, PENALTY_TRACK_WORK);
  assert.equal(r.error, 'HTTP 502');
});

test('windows past the cap are not asked about and count as a failure', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  const r = await shadowTrackwork(Array(MAX_MODEL_WINDOWS + 1).fill(WINDOW), TRIP, { fetchImpl, env: ENV });
  assert.equal(calls.length, MAX_MODEL_WINDOWS);
  assert.equal(r.penaltyShadow, PENALTY_TRACK_WORK);
  assert.equal(r.error, 'too many windows');
});

test('no active window gives a null shadow and makes no request', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  assert.deepEqual(await shadowTrackwork([], TRIP, { fetchImpl, env: ENV }), { p: null, penaltyShadow: null, error: null });
  assert.equal(calls.length, 0);
});

test('TRACKWORK_MODEL_URL unset means not consulted: null, and no request', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  assert.equal(await shadowTrackwork([WINDOW], TRIP, { fetchImpl, env: {} }), null);
  assert.equal(calls.length, 0);
});

const PAGE =
  '<table><tr><th>Start</th><th>End</th><th>Line</th><th>Impact</th></tr><tr><td>Sept. 16</td><td>Sept. 18</td><td>Red</td><td>Single tracking</td></tr></table>';
const NOW = Date.parse('2026-09-17T12:00:00Z');

function wholeFetch(gw) {
  return async (url, init) => (String(url).includes('wmata.com') ? { ok: true, status: 200, text: async () => PAGE } : gw(url, init));
}

test('fetchTrackwork adds model beside the unchanged signal when the model is configured', async () => {
  const { fetchImpl } = gateway(ok(CAPTURED));
  const base = await fetchTrackwork(['Red'], wholeFetch(fetchImpl), { now: NOW });
  const withModel = await fetchTrackwork(['Red'], wholeFetch(fetchImpl), { now: NOW, trip: TRIP, env: ENV });
  const { model, ...rest } = withModel;
  assert.deepEqual(rest, base);
  assert.equal(base.model, undefined);
  assert.equal(model.p, 0.42);
});

test('fetchTrackwork with the URL unset makes no gateway request and has no model', async () => {
  const { calls, fetchImpl } = gateway(ok(CAPTURED));
  const r = await fetchTrackwork(['Red'], wholeFetch(fetchImpl), { now: NOW, trip: TRIP, env: {} });
  assert.equal(calls.length, 0);
  assert.equal(r.model, undefined);
});

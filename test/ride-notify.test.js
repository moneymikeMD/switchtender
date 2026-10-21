// Tests for the ride pushes (src/ride/notify.js): the wire format the phone
// macro (CMB-154) parses. No network: ntfy is a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushRide, rideBody, cancelActions, TITLE, PRIORITY, ACTION_LABELS } from '../src/ride/notify.js';

const SENT = Date.parse('2026-10-21T12:00:00.500Z');

test('the body is the text, a bar, then the send time in epoch seconds', () => {
  assert.equal(rideBody('Next stop Gallery Place. Transfer to Green.', SENT), 'Next stop Gallery Place. Transfer to Green.|1792584000');
  const parts = rideBody("You're on the 8:47 from Gallery Place.", SENT).split('|');
  assert.equal(Number(parts.at(-1)), 1792584000);
});

test('titles and priorities: alerts and loud statuses at 5, the quiet lock status at 3', async () => {
  assert.deepEqual({ ...TITLE }, { alert: 'Ride alert', once: 'Ride', status: 'Ride status' });
  assert.deepEqual({ ...PRIORITY }, { loud: 5, quiet: 3 });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const base = { topic: 'r1d3t0p1c', sentAtMs: SENT, fetchImpl };
  assert.deepEqual(await pushRide({ ...base, kind: 'alert', text: 'A' }), { ok: true, sent: true, error: null });
  await pushRide({ ...base, kind: 'once', text: 'B' });
  await pushRide({ ...base, kind: 'status', text: 'Tracking the 8:14 from Shady Grove', quiet: true });
  await pushRide({ ...base, kind: 'status', text: 'Not tracking. Watch the stops.' });
  assert.ok(calls.every((c) => c.url === 'https://ntfy.sh/r1d3t0p1c' && c.init.method === 'POST'));
  assert.deepEqual(
    calls.map((c) => [c.init.headers.Title, c.init.headers.Priority, c.init.body]),
    [
      ['Ride alert', '5', 'A|1792584000'],
      ['Ride', '5', 'B|1792584000'],
      ['Ride status', '3', 'Tracking the 8:14 from Shady Grove|1792584000'],
      ['Ride status', '5', 'Not tracking. Watch the stops.|1792584000'],
    ],
  );
  assert.ok(calls.every((c) => !('Actions' in c.init.headers)));
});

test('the cancel buttons are ntfy http actions on the service, carrying the ride token and never a key', async () => {
  const actions = cancelActions({ serviceUrl: 'https://svc.example.run.app/', leg: 'am', token: 'tok_abc-123' });
  assert.equal(
    actions,
    "http, I'm off, https://svc.example.run.app/ride/cancel?leg=am&reason=off&token=tok_abc-123, clear=true; " +
      'http, Not riding, https://svc.example.run.app/ride/cancel?leg=am&reason=not-riding&token=tok_abc-123, clear=true',
  );
  assert.deepEqual(Object.keys(ACTION_LABELS), ['off', 'not-riding']);
  assert.equal(cancelActions({ serviceUrl: '', leg: 'am', token: 't' }), null);
  assert.equal(cancelActions({ serviceUrl: 'https://x', leg: 'am', token: null }), null);

  const calls = [];
  await pushRide({
    topic: 't',
    kind: 'alert',
    text: 'A',
    sentAtMs: SENT,
    actions,
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true };
    },
  });
  assert.equal(calls[0].headers.Actions, actions);
});

test('no topic sends nothing; a refused or unreachable ntfy is reported, never thrown', async () => {
  assert.deepEqual(
    await pushRide({
      topic: '',
      kind: 'alert',
      text: 'x',
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    }),
    { ok: true, sent: false, error: null },
  );
  assert.deepEqual(await pushRide({ topic: 't', kind: 'alert', text: 'x', fetchImpl: async () => ({ ok: false, status: 429 }) }), {
    ok: false,
    sent: false,
    error: 'ntfy 429',
  });
  const down = await pushRide({
    topic: 't',
    kind: 'alert',
    text: 'x',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(down.error, 'network (TypeError): fetch failed');
  assert.equal((await pushRide({ topic: 't', kind: 'nope', text: 'x' })).ok, false);
});

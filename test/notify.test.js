// Tests for the ntfy push (CMB-37, CMB-83). No network: every call goes
// through a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushVerdict } from '../src/notify.js';

test('no topic configured: never sends, never fails', async () => {
  const fetchImpl = async () => {
    throw new Error('should not be called');
  };
  const result = await pushVerdict({ choice: 'drive', spoken: 'x', topic: '', fetchImpl });
  assert.deepEqual(result, { ok: true, sent: false, error: null });
});

test('every call posts the spoken line, with the choice in the title (CMB-83)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  for (const choice of ['drive', 'drive', 'transit']) {
    const result = await pushVerdict({ choice, spoken: `Line for ${choice}.`, topic: 'abc123', fetchImpl });
    assert.deepEqual(result, { ok: true, sent: true, error: null });
  }
  assert.equal(calls.length, 3, 'the same choice twice is still sent twice');
  assert.equal(calls[0].url, 'https://ntfy.sh/abc123');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'Line for drive.');
  assert.equal(calls[0].init.headers.Title, 'switchtender: keep driving');
  assert.equal(calls[2].init.headers.Title, 'switchtender: take the train');
});

test('ntfy HTTP failure is reported as ok:false, not thrown', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const result = await pushVerdict({ choice: 'transit', spoken: 'x', topic: 'abc123', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /500/);
});

test('a network failure is reported by name, not thrown', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await pushVerdict({ choice: 'transit', spoken: 'x', topic: 'abc123', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
});

test('NTFY_BASE_URL and NTFY_RELAY_KEY: posts to the base with X-Relay-Key; unset sends no key (CMB-160)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const env = { NTFY_BASE_URL: 'https://push.example.test/', NTFY_RELAY_KEY: 'k3y' };
  await pushVerdict({ choice: 'drive', spoken: 'x', topic: 'abc123', fetchImpl, env });
  assert.equal(calls[0].url, 'https://push.example.test/abc123');
  assert.equal(calls[0].init.headers['X-Relay-Key'], 'k3y');
  await pushVerdict({ choice: 'drive', spoken: 'x', topic: 'abc123', fetchImpl, env: {} });
  assert.equal(calls[1].url, 'https://ntfy.sh/abc123');
  assert.equal('X-Relay-Key' in calls[1].init.headers, false);
});

test('a 429 with Retry-After 2 is retried once; the error carries the ntfy code (CMB-160)', async () => {
  const responses = [
    { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }), text: async () => '{"code":42901}' },
    { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }), text: async () => '{"code":42901}' },
  ];
  const waits = [];
  let n = 0;
  const result = await pushVerdict({ choice: 'drive', spoken: 'x', topic: 'secrettopic', fetchImpl: async () => responses[n++], sleep: async (ms) => waits.push(ms), env: {} });
  assert.equal(n, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(result, { ok: false, sent: false, error: 'ntfy 429 42901 retry-after 2' });
  assert.ok(!result.error.includes('secrettopic'));
});

test('a retry that succeeds sends; a Retry-After over 10 s is not retried (CMB-160)', async () => {
  let n = 0;
  const ok = await pushVerdict({
    choice: 'drive',
    spoken: 'x',
    topic: 't',
    sleep: async () => {},
    env: {},
    fetchImpl: async () => (n++ === 0 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => '' } : { ok: true, status: 200 }),
  });
  assert.deepEqual(ok, { ok: true, sent: true, error: null });
  let m = 0;
  const long = await pushVerdict({
    choice: 'drive',
    spoken: 'x',
    topic: 't',
    env: {},
    fetchImpl: async () => (m++, { ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }), text: async () => '{"code":42908}' }),
  });
  assert.equal(m, 1);
  assert.equal(long.error, 'ntfy 429 42908 retry-after 3600');
});

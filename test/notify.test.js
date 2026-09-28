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

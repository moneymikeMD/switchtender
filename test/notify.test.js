// Tests for the ntfy push (CMB-37). No network: every call goes through a
// stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushIfChanged } from '../src/notify.js';

test('no topic configured: never sends, never fails', async () => {
  const fetchImpl = async () => {
    throw new Error('should not be called');
  };
  const result = await pushIfChanged({ choice: 'drive', previousChoice: 'transit', spoken: 'x', topic: '', fetchImpl });
  assert.deepEqual(result, { ok: true, sent: false, error: null });
});

test('no prior choice on record: never sends (unknown is not "changed")', async () => {
  const fetchImpl = async () => {
    throw new Error('should not be called');
  };
  const result = await pushIfChanged({
    choice: 'drive',
    previousChoice: null,
    spoken: 'x',
    topic: 'abc123',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: false, error: null });
});

test('choice unchanged: never sends', async () => {
  const fetchImpl = async () => {
    throw new Error('should not be called');
  };
  const result = await pushIfChanged({
    choice: 'drive',
    previousChoice: 'drive',
    spoken: 'x',
    topic: 'abc123',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: false, error: null });
});

test('choice flipped: posts the spoken line to the topic', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const result = await pushIfChanged({
    choice: 'transit',
    previousChoice: 'drive',
    spoken: 'Park and ride. Confidence is high.',
    topic: 'abc123',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: true, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/abc123');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'Park and ride. Confidence is high.');
});

test('ntfy HTTP failure is reported as ok:false, not thrown', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const result = await pushIfChanged({
    choice: 'transit',
    previousChoice: 'drive',
    spoken: 'x',
    topic: 'abc123',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.match(result.error, /500/);
});

test('a network failure is reported by name, not thrown', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await pushIfChanged({
    choice: 'transit',
    previousChoice: 'drive',
    spoken: 'x',
    topic: 'abc123',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
});

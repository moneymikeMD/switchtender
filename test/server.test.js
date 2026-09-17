// Tests for the HTTP entry point (src/server.js). No network beyond loopback:
// the pipeline is injected, so nothing here talks to a feed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer, keyMatches, KEY_HEADER } from '../src/server.js';
import { RouteError } from '../src/routes.js';

const SECRET = 'correct-horse-battery-staple';
const config = { route: {}, decision: {}, secrets: { keys: {}, degraded: [] }, log: { enabled: false } };
const verdict = { choice: 'transit', confidence: 0.7, reasons: ['test'] };

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function start({ run, logger = () => {}, timeoutMs } = {}) {
  const lines = [];
  const server = createServer({
    config,
    secret: SECRET,
    run: run ?? (async () => ({ verdict, spoken: 'Take the train.' })),
    now: () => new Date('2026-09-16T12:00:00Z'),
    timeoutMs,
    logger: (line) => {
      lines.push(line);
      logger(line);
    },
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, lines };
}

test('the server refuses to build without a secret', () => {
  assert.throws(() => createServer({ config, secret: '' }), /SWITCHTENDER_SHARED_SECRET/);
  assert.throws(() => createServer({ config, secret: undefined }), /SWITCHTENDER_SHARED_SECRET/);
});

test('/health answers 200 without a key', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('/verdict without a key is 401 with an empty body', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/verdict`);
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('/verdict with a wrong key of the same length is 401', async () => {
  const { base } = await start();
  const wrong = 'x'.repeat(SECRET.length);
  assert.equal(wrong.length, SECRET.length);
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: wrong } });
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('/verdict with the right key returns the spoken line, the verdict and a timestamp', async () => {
  const { base, lines } = await start();
  const res = await fetch(`${base}/verdict`, { headers: { 'X-Switchtender-Key': SECRET } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.deepEqual(body, {
    spoken: 'Take the train.',
    verdict,
    computedAt: '2026-09-16T12:00:00.000Z',
  });
  // One line per request, status and duration, never the key.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^GET \/verdict 200 \d+ms$/);
  assert.ok(!lines[0].includes(SECRET));
});

test('a RouteError from the pipeline is 503 and says only that the lookup failed', async () => {
  const { base } = await start({
    run: async () => {
      throw new RouteError('Routes API HTTP 500');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'lookup failed' });
});

test('a pipeline that outlives the timeout is 504', async () => {
  const { base } = await start({
    run: () => new Promise(() => {}),
    timeoutMs: 50,
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'lookup timed out' });
});

test('unknown paths are 404 and non-GET on /verdict is 405, both before the key check', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/verdict`, { method: 'POST', headers: { [KEY_HEADER]: SECRET } })).status, 405);
});

test('keyMatches is constant-length and never throws on mismatched lengths', () => {
  assert.equal(keyMatches(SECRET, SECRET), true);
  assert.doesNotThrow(() => keyMatches('short', SECRET));
  assert.equal(keyMatches('short', SECRET), false);
  assert.equal(keyMatches(`${SECRET}x`, SECRET), false);
  assert.equal(keyMatches('', SECRET), false);
  assert.equal(keyMatches(undefined, SECRET), false);
  assert.equal(keyMatches(SECRET, ''), false);
  assert.equal(keyMatches(['a', 'b'], SECRET), false, 'a repeated header arrives as an array');
});

// Tests for the HTTP entry point (src/server.js). No network beyond loopback:
// the pipeline is injected, so nothing here talks to a feed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { createServer, keyMatches, KEY_HEADER } from '../src/server.js';
import { RouteError } from '../src/routes.js';

const SECRET = 'correct-horse-battery-staple';
const config = { route: {}, decision: {}, secrets: { keys: {}, degraded: [] }, log: { enabled: false } };
const verdict = { choice: 'transit', confidence: 0.7, reasons: ['test'] };

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function start({ run, logger = () => {}, timeoutMs, previousChoice, push } = {}) {
  const lines = [];
  const server = createServer({
    config,
    secret: SECRET,
    run: run ?? (async () => ({ verdict, spoken: 'Take the train.' })),
    now: () => new Date('2026-09-16T12:00:00Z'),
    timeoutMs,
    previousChoice,
    push,
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
    logged: null,
    notified: null,
  });
  // One line per request, status and duration, never the key.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^GET \/verdict 200 \d+ms$/);
  assert.ok(!lines[0].includes(SECRET));
});

test('?notify=1 is ignored without a key: no push, plain 401', async () => {
  const { base } = await start({
    previousChoice: async () => {
      throw new Error('should not be reached before the key check');
    },
  });
  const res = await fetch(`${base}/verdict?notify=1`);
  assert.equal(res.status, 401);
});

test('without ?notify=1, the prior choice is never fetched and notified is null', async () => {
  const { base } = await start({
    previousChoice: async () => {
      throw new Error('should not be called');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  const body = await res.json();
  assert.equal(body.notified, null);
});

test('?notify=1 fetches the prior choice and calls push with it, alongside the run', async () => {
  const calls = [];
  const { base } = await start({
    previousChoice: async (cfg, fetchImpl) => {
      calls.push('previousChoice');
      assert.equal(cfg, config);
      return { ok: true, choice: 'drive', error: null };
    },
    push: async (args) => {
      calls.push(['push', args]);
      return { ok: true, sent: true, error: null };
    },
  });
  const res = await fetch(`${base}/verdict?notify=1`, { headers: { [KEY_HEADER]: SECRET } });
  const body = await res.json();
  assert.deepEqual(body.notified, { ok: true, sent: true, error: null });
  assert.equal(calls[0], 'previousChoice');
  assert.deepEqual(calls[1][1].previousChoice, 'drive');
  assert.equal(calls[1][1].choice, verdict.choice);
  assert.equal(calls[1][1].spoken, 'Take the train.');
});

test('a failed prior-choice read is logged but does not fail the request; push sees previousChoice null', async () => {
  const logged = [];
  const { base } = await start({
    previousChoice: async () => ({ ok: false, choice: null, error: 'sheets 403: no permission' }),
    push: async (args) => {
      assert.equal(args.previousChoice, null);
      return { ok: true, sent: false, error: null };
    },
    logger: (line) => logged.push(line),
  });
  const res = await fetch(`${base}/verdict?notify=1`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.ok(logged.some((line) => line.includes('previous choice unavailable')));
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
  // No key sent: a 401 here would mean the key check ran first.
  assert.equal((await fetch(`${base}/verdict`, { method: 'POST' })).status, 405);
});

// Send a raw request line the HTTP parser accepts but the URL parser rejects.
function rawRequest(base, target) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('a request target the URL parser rejects is a 400, not a crashed instance', async () => {
  const { base, lines } = await start();
  for (const target of ['//[::1/verdict', 'http://[', 'http://[::1']) {
    const response = await rawRequest(base, target);
    assert.match(response, /^HTTP\/1\.1 400 /, target);
  }
  // The server is still up and still answering.
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.ok(lines.every((l) => !l.includes('error')), lines.join('\n'));
});

test('a failed sheet write is logged by name and returned in the body; a good one is silent', async () => {
  const failed = await start({
    run: async () => ({ verdict, spoken: 'Take the train.', logged: { ok: false, error: 'sheets 403: The caller does not have permission' } }),
  });
  const res = await fetch(`${failed.base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).logged, { ok: false, error: 'sheets 403: The caller does not have permission' });
  assert.ok(failed.lines.some((l) => l === 'log failed: sheets 403: The caller does not have permission'), failed.lines.join('\n'));

  const fine = await start({ run: async () => ({ verdict, spoken: 'Take the train.', logged: { ok: true, error: null } }) });
  await fetch(`${fine.base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.ok(!fine.lines.some((l) => l.startsWith('log failed')));
});

test('a pipeline that throws something other than a RouteError is a 500 with the message logged, not a crash', async () => {
  const { base, lines } = await start({
    run: async () => {
      throw new RangeError('Invalid time zone specified: America/Boston');
    },
  });
  const res = await fetch(`${base}/verdict`, { headers: { [KEY_HEADER]: SECRET } });
  assert.equal(res.status, 500);
  assert.ok(lines.some((l) => l.includes('Invalid time zone')));
  assert.equal((await fetch(`${base}/health`)).status, 200);
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

test('?from=origin reaches the pipeline; anything else but fork is a 400 after the key check (CMB-30)', async () => {
  const calls = [];
  const { base } = await start({
    run: async (_config, opts) => {
      calls.push(opts.from);
      return { verdict, spoken: 'Take the train.' };
    },
  });
  const headers = { [KEY_HEADER]: SECRET };

  assert.equal((await fetch(`${base}/verdict`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?from=fork`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/verdict?from=origin`, { headers })).status, 200);
  assert.deepEqual(calls, ['fork', 'fork', 'origin']);

  const bad = await fetch(`${base}/verdict?from=garage`, { headers });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /fork, origin/);
  assert.equal(calls.length, 3);

  // Unauthenticated: 401, not 400. The parameter is not validated for strangers.
  assert.equal((await fetch(`${base}/verdict?from=garage`)).status, 401);
});

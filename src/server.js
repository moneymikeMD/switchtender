// HTTP entry point (CMB-12).
//
// One route returns the verdict and the spoken line for the configured
// journey. It runs on Cloud Run, scales to zero, and is called twice a weekday
// from a phone on mobile data at speed, so the response is small and the
// timeout short.
//
// Authentication is a shared secret in a request header. Cloud Run's own IAM
// check is off (--allow-unauthenticated) because the phone cannot mint a
// Google identity token; this header is the whole gate, so the comparison is
// constant time and the server refuses to start without a secret to compare
// against. The secret comes from the environment (CLAUDE.md rule 7), is read
// once, and is never written to a log line.
//
// Failure policy: when routing fails the response is 503 and says nothing
// else. The owner runs Waze anyway; a guess would be worse than silence.

import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { RouteError } from './routes.js';
import { runVerdict } from './engine.js';

export const KEY_HEADER = 'x-switchtender-key';
export const SECRET_ENV = 'SWITCHTENDER_SHARED_SECRET';
export const DEFAULT_PORT = 8080;
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Constant-time comparison of a presented key against the secret.
 *
 * Both sides are hashed first so the byte lengths always match, which is what
 * timingSafeEqual requires; a key of the wrong length is therefore rejected
 * through the same code path as a wrong key of the right length, rather than
 * by an early return or an exception. A missing key never matches.
 */
export function keyMatches(presented, secret) {
  if (typeof presented !== 'string' || typeof secret !== 'string' || secret.length === 0) {
    return false;
  }
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function send(res, status, body, contentType = 'application/json') {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TimeoutError extends Error {
  constructor() {
    super('verdict timed out');
    this.name = 'TimeoutError';
  }
}

/**
 * Build the server without listening. Tests inject the pipeline and the
 * clock; production passes only config and secret.
 */
export function createServer({
  config,
  secret,
  run = runVerdict,
  now = () => new Date(),
  timeoutMs = REQUEST_TIMEOUT_MS,
  logger = (line) => console.error(line),
}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${SECRET_ENV} is not set`);
  }

  const server = createHttpServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path and status only. Never the headers: one of them is the key.
      logger(`${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });

    if (url.pathname === '/healthz') {
      send(res, 200, 'ok', 'text/plain');
      return;
    }
    if (url.pathname !== '/verdict') {
      send(res, 404);
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405);
      return;
    }
    if (!keyMatches(req.headers[KEY_HEADER], secret)) {
      send(res, 401);
      return;
    }

    const computedAt = now();
    try {
      const { verdict, spoken } = await withTimeout(run(config, { now: computedAt }), timeoutMs);
      send(res, 200, { spoken, verdict, computedAt: computedAt.toISOString() });
    } catch (error) {
      if (error instanceof RouteError) {
        send(res, 503, { error: 'lookup failed' });
      } else if (error instanceof TimeoutError) {
        send(res, 504, { error: 'lookup timed out' });
      } else {
        logger(`verdict error: ${error?.message ?? error}`);
        send(res, 500, { error: 'internal error' });
      }
    }
  });

  // Socket-level guard behind the promise race, so a stalled client cannot
  // hold an instance open either.
  server.requestTimeout = timeoutMs + 5_000;
  server.headersTimeout = 10_000;
  return server;
}

function main() {
  const secret = process.env[SECRET_ENV];
  if (!secret) {
    console.error(`switchtender: ${SECRET_ENV} is not set; refusing to start`);
    process.exit(1);
  }

  const configPath = process.env.SWITCHTENDER_CONFIG ?? 'config.toml';
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createServer({ config, secret });
  server.listen(port, () => {
    console.error(`switchtender: listening on ${port}, config ${configPath}`);
  });

  // Cloud Run sends SIGTERM before it removes an instance.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { RouteError, START_POINTS } from './routes.js';
import { runVerdict } from './engine.js';
import { getLastChoice, tokenFromEnvOrMetadata } from './log.js';
import { pushIfChanged } from './notify.js';

export const KEY_HEADER = 'x-switchtender-key';
export const SECRET_ENV = 'SWITCHTENDER_SHARED_SECRET';
export const NTFY_TOPIC_ENV = 'NTFY_TOPIC';
export const DEFAULT_PORT = 8080;
export const REQUEST_TIMEOUT_MS = 20_000;

/** The choice most recently logged (CMB-37). Never throws; missing credentials or a failed read just mean no prior choice to compare against. */
async function defaultPreviousChoice(config, fetchImpl) {
  const token = await tokenFromEnvOrMetadata({ fetchImpl });
  if (!token) return { ok: false, choice: null, error: 'no credentials' };
  const sheetId = config?.log?.sheet_id;
  if (!sheetId) return { ok: false, choice: null, error: 'no sheet id configured' };
  return getLastChoice({ sheetId, tab: config?.log?.sheet_tab ?? 'verdicts', token, fetchImpl });
}

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
  fetchImpl = fetch,
  previousChoice = defaultPreviousChoice,
  push = pushIfChanged,
}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${SECRET_ENV} is not set`);
  }

  const server = createHttpServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let pathname = '?';
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path and status only. Never the headers: one of them is the key.
      logger(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    try {
      pathname = await handle(req, res);
    } catch (error) {
      // The listener is async; a rejection here would be unhandled and
      // would take the process, and with it the only instance, down.
      logger(`request error: ${error?.message ?? error}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });

  async function handle(req, res) {
    // The request target is untrusted. llhttp accepts targets the WHATWG
    // parser rejects ("//[::1/x"), and that rejection must be a 400, not a
    // crash before the key is even looked at.
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      send(res, 400);
      return '?';
    }

    // /health, not /healthz: Cloud Run's frontend answers /healthz itself with
    // an HTML 404 and the request never reaches the container.
    const { pathname } = url;
    if (pathname === '/health') {
      send(res, 200, 'ok', 'text/plain');
      return pathname;
    }
    if (pathname !== '/verdict') {
      send(res, 404);
      return pathname;
    }
    if (req.method !== 'GET') {
      send(res, 405);
      return pathname;
    }
    if (!keyMatches(req.headers[KEY_HEADER], secret)) {
      send(res, 401);
      return pathname;
    }

    // ?from=origin asks for the whole trip from home (CMB-30). Checked after
    // the key so an unauthenticated caller learns nothing about the API.
    const from = url.searchParams.get('from') ?? 'fork';
    if (!START_POINTS.includes(from)) {
      send(res, 400, { error: `from must be one of ${START_POINTS.join(', ')}` });
      return pathname;
    }

    // Cloud Scheduler's morning call only (CMB-37); read before `run`
    // appends its own row, or the comparison would be against itself.
    const notify = url.searchParams.get('notify') === '1';

    const computedAt = now();
    try {
      const [{ verdict, spoken, logged = null }, prior] = await withTimeout(
        Promise.all([
          run(config, { now: computedAt, from }),
          notify ? previousChoice(config, fetchImpl) : Promise.resolve(null),
        ]),
        timeoutMs,
      );
      // A failed sheet write is the one failure nobody would otherwise see
      // from the phone: the verdict is fine, the tuning log just stops.
      if (logged && !logged.ok) logger(`log failed: ${logged.error}`);

      let notified = null;
      if (notify) {
        if (prior && !prior.ok) logger(`notify: previous choice unavailable (${prior.error})`);
        const topic = (process.env[NTFY_TOPIC_ENV] ?? '').trim();
        notified = await push({
          choice: verdict.choice,
          previousChoice: prior?.choice ?? null,
          spoken,
          topic,
          fetchImpl,
        });
        if (!notified.ok) logger(`notify failed: ${notified.error}`);
      }

      send(res, 200, { spoken, verdict, computedAt: computedAt.toISOString(), logged, notified });
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
    return pathname;
  }

  // Socket-level guard behind the promise race, so a stalled client cannot
  // hold an instance open either.
  server.requestTimeout = timeoutMs + 5_000;
  server.headersTimeout = 10_000;
  return server;
}

function main() {
  // Trimmed: Secret Manager hands over exactly the bytes it was given, and a
  // shell pipeline usually gives it one newline too many.
  const secret = (process.env[SECRET_ENV] ?? '').trim();
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

// Run only as the entry point. Resolved through realpath so a symlinked
// launcher still starts the server instead of exiting silently.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}

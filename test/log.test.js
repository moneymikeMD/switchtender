// Tests for the verdict log (CMB-11). No network: every Sheets call goes
// through a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HEADER,
  headerFor,
  buildRow,
  localTime,
  appendRow,
  ensureHeader,
  logVerdict,
  tokenFromEnvOrMetadata,
} from '../src/log.js';
import { parseConfig, ConfigError } from '../src/config.js';

const exampleText = readFileSync('config.example.toml', 'utf8');

const config = {
  route: { timezone: 'America/New_York' },
  decision: { transit_wins_ties: true, minimum_drive_margin_minutes: 5 },
  secrets: { degraded: ['scheduled events', 'rail alerts'] },
  log: { enabled: true, sheet_id: 'sheet-123', sheet_tab: 'verdicts' },
};

const options = {
  driveThrough: {
    totalSeconds: 2100,
    distanceMeters: 24000,
    congestion: {
      score: 0.25,
      metres: { NORMAL: 18000, SLOW: 4000, TRAFFIC_JAM: 2000 },
      share: {},
      totalMetres: 24000,
      unknown: false,
    },
  },
  parkAndRide: { totalSeconds: 2700, driveSeconds: 600, bufferSeconds: 300, transitSeconds: 1800 },
};

const incidents = {
  unstable: true,
  score: 0.4,
  count: 7,
  byCategory: { accident: 1, jam: 6 },
  reasons: ['a crash on the parkway'],
};

const verdict = {
  choice: 'transit',
  driveMinutes: 35,
  transitMinutes: 45,
  marginMinutes: 10,
  requiredMarginMinutes: 8.8,
  congestionScore: 0.25,
  incidentsScore: 0.4,
  roadUnstable: true,
  confidence: 0.4,
  reasons: ['the road is congested', 'a crash ahead'],
};

const now = new Date('2026-09-16T12:34:56Z'); // 08:34:56 EDT, a Wednesday

const col = (row, name, header = HEADER) => row[header.indexOf(name)];

const jsonResponse = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
});

test('HEADER has no duplicate columns', () => {
  assert.equal(new Set(HEADER).size, HEADER.length);
  for (const name of HEADER) assert.match(name, /^[a-z][a-z0-9_]*$/, name);
});

test('buildRow is aligned to HEADER', () => {
  const row = buildRow({ now, config, options, incidents, verdict });
  assert.equal(row.length, HEADER.length);
  assert.ok(row.every((c) => typeof c === 'string'));
  assert.equal(col(row, 'timestamp'), '2026-09-16T08:34:56-04:00');
  assert.equal(col(row, 'local_date'), '2026-09-16');
  assert.equal(col(row, 'weekday'), 'Wednesday');
  assert.equal(col(row, 'season'), 'autumn');
  assert.equal(col(row, 'direction'), 'inbound');
  assert.equal(col(row, 'drive_minutes'), '35');
  assert.equal(col(row, 'drive_seconds'), '2100');
  assert.equal(col(row, 'transit_minutes'), '45');
  assert.equal(col(row, 'congestion_score'), '0.25');
  assert.equal(col(row, 'congestion_jam_metres'), '2000');
  assert.equal(col(row, 'congestion_total_metres'), '24000');
  assert.equal(col(row, 'incidents_count'), '7');
  assert.equal(col(row, 'incidents_unstable'), 'true');
  assert.deepEqual(JSON.parse(col(row, 'incidents_by_category')), { accident: 1, jam: 6 });
  assert.equal(col(row, 'degraded_signals'), 'scheduled events, rail alerts');
  assert.equal(col(row, 'choice'), 'transit');
  assert.equal(col(row, 'required_margin_minutes'), '8.8');
  assert.equal(col(row, 'reasons'), 'the road is congested | a crash ahead');
  assert.equal(col(row, 'confidence'), '0.4');
  assert.equal(col(row, 'transit_wins_ties'), 'true');
});

test('weather columns are present and empty', () => {
  const row = buildRow({ now, config, options, incidents, verdict });
  for (const name of ['weather_summary', 'weather_temp_c', 'weather_precip_mm']) {
    assert.ok(HEADER.includes(name), name);
    assert.equal(col(row, name), '');
  }
});

test('extras land at the end in stable insertion order', () => {
  const extras = { chart_incidents: 3, ddot_closures: 0, chart_unstable: false };
  const header = headerFor(extras);
  const row = buildRow({ now, config, options, incidents, verdict, extras });
  assert.equal(row.length, HEADER.length + 3);
  assert.deepEqual(header.slice(HEADER.length), ['chart_incidents', 'ddot_closures', 'chart_unstable']);
  assert.deepEqual(row.slice(HEADER.length), ['3', '0', 'false']);
  // An extra that names an existing column does not add a second one.
  assert.equal(headerFor({ choice: 'x', new_one: 1 }).length, HEADER.length + 1);
});

test('unknown congestion produces empty cells, not zeros', () => {
  const unknown = {
    ...options,
    driveThrough: {
      ...options.driveThrough,
      congestion: { score: null, metres: {}, share: {}, totalMetres: 0, unknown: true },
    },
  };
  const row = buildRow({ now, config, options: unknown, incidents: null, verdict: { ...verdict, congestionScore: null } });
  for (const name of [
    'congestion_score',
    'congestion_normal_metres',
    'congestion_slow_metres',
    'congestion_jam_metres',
    'congestion_total_metres',
    'verdict_congestion_score',
    'incidents_count',
    'incidents_score',
    'incidents_unstable',
    'incidents_by_category',
  ]) {
    assert.equal(col(row, name), '', name);
  }
  assert.equal(col(row, 'congestion_unknown'), 'true');
});

test('a missing congestion object entirely is also empty, not 0', () => {
  const row = buildRow({ now, config, options: { driveThrough: { totalSeconds: 100 }, parkAndRide: {} }, verdict });
  assert.equal(col(row, 'congestion_score'), '');
  assert.equal(col(row, 'congestion_unknown'), '');
  assert.equal(col(row, 'transit_minutes'), '');
});

test('localTime handles UTC and a winter month', () => {
  const t = localTime(new Date('2026-01-05T03:00:00Z'), 'UTC');
  assert.equal(t.timestamp, '2026-01-05T03:00:00+00:00');
  assert.equal(t.season, 'winter');
  assert.equal(t.weekday, 'Monday');
});

test('appendRow reports a 403 as ok:false with the status', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(403, { error: { message: 'The caller does not have permission' } });
  };
  const result = await appendRow(['a', 'b'], { sheetId: 'S', tab: 'verdicts', token: 'tok', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /403/);
  assert.match(result.error, /permission/);
  assert.equal(calls.length, 1);
  assert.match(decodeURIComponent(calls[0].url), /values\/'verdicts'!A1:append\?valueInputOption=RAW/);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { values: [['a', 'b']] });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('appendRow reports a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await appendRow(['a'], { sheetId: 'S', tab: 't', token: 'tok', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.error, /ECONNRESET/);
});

test('ensureHeader writes HEADER when A1 is empty and leaves an existing header alone', async () => {
  const writes = [];
  const emptyFetch = async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, { range: 'x', majorDimension: 'ROWS' });
    writes.push(JSON.parse(init.body));
    return jsonResponse(200, {});
  };
  const created = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: emptyFetch });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.deepEqual(writes[0].values[0], Array.from(HEADER));

  const filledFetch = async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, { values: [['timestamp']] });
    throw new Error('should not write');
  };
  const kept = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: filledFetch });
  assert.equal(kept.ok, true);
  assert.equal(kept.created, false);
});

test('ensureHeader creates the tab when the range cannot be parsed', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${decodeURIComponent(url).replace(/^.*spreadsheets\/S/, '')}`);
    if (init.method === 'GET') return jsonResponse(400, { error: { message: 'Unable to parse range: verdicts!A1' } });
    return jsonResponse(200, {});
  };
  const result = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.ok(seen.some((s) => s.startsWith('POST :batchUpdate')), seen.join('\n'));
  assert.ok(seen.some((s) => s.startsWith("PUT /values/'verdicts'!A1")), seen.join('\n'));
});

test('logVerdict with no credentials is ok:false and does not throw', async () => {
  const fetchImpl = async () => {
    throw new Error('network must not be touched');
  };
  const result = await logVerdict({
    now,
    config,
    options,
    incidents,
    verdict,
    tokenProvider: async () => null,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, error: 'no credentials' });
});

test('logVerdict without a sheet id is ok:false and touches nothing', async () => {
  const result = await logVerdict({
    config: { ...config, log: { enabled: true, sheet_id: null, sheet_tab: 'verdicts' } },
    options,
    verdict,
    tokenProvider: async () => 'tok',
    fetchImpl: async () => {
      throw new Error('no');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /sheet id/);
});

test('logVerdict swallows a throwing token provider', async () => {
  const result = await logVerdict({
    config,
    options,
    verdict,
    tokenProvider: async () => {
      throw new Error('metadata exploded');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /metadata exploded/);
});

test('logVerdict happy path: header check then append, in that order', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    if (init.method === 'GET') return jsonResponse(200, { values: [['timestamp']] });
    return jsonResponse(200, { updates: { updatedRows: 1 } });
  };
  const result = await logVerdict({ now, config, options, incidents, verdict, tokenProvider: async () => 'tok', fetchImpl });
  assert.deepEqual(result, { ok: true, error: null });
  assert.deepEqual(calls, ['GET', 'POST']);
});

test('tokenFromEnvOrMetadata prefers the environment and returns null when metadata is unreachable', async () => {
  assert.equal(await tokenFromEnvOrMetadata({ env: { SHEETS_ACCESS_TOKEN: 'abc' } }), 'abc');
  const unreachable = async () => {
    throw new Error('ENOTFOUND metadata.google.internal');
  };
  assert.equal(await tokenFromEnvOrMetadata({ env: {}, fetchImpl: unreachable }), null);
  const metadata = async () => jsonResponse(200, { access_token: 'from-metadata', expires_in: 3600 });
  assert.equal(await tokenFromEnvOrMetadata({ env: {}, fetchImpl: metadata }), 'from-metadata');
});

test('the [log] block in the example parses and is disabled', () => {
  const c = parseConfig(exampleText);
  assert.deepEqual(c.log, { enabled: false, sheet_id: '1AbC...example', sheet_tab: 'verdicts' });
});

test('a config without [log] does not log', () => {
  const stripped = exampleText.replace(/\[log\][\s\S]*?(?=\n\[incidents\])/, '');
  assert.ok(!stripped.includes('[log]'));
  const c = parseConfig(stripped);
  assert.deepEqual(c.log, { enabled: false, sheet_id: null, sheet_tab: 'verdicts' });
});

test('enabling the log without a sheet id is a config error', () => {
  const broken = exampleText.replace('enabled = false', 'enabled = true').replace(/^sheet_id.*$/m, '');
  assert.throws(
    () => parseConfig(broken),
    (e) => e instanceof ConfigError && e.message.includes('log.sheet_id'),
  );
  const wrongType = exampleText.replace('enabled = false', 'enabled = "yes"');
  assert.throws(
    () => parseConfig(wrongType),
    (e) => e instanceof ConfigError && e.message.includes('log.enabled'),
  );
});

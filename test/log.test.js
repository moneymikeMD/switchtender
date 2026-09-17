// Tests for the verdict log (CMB-11). No network: every Sheets call goes
// through a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HEADER,
  EXTRA_COLUMNS,
  FULL_HEADER,
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
  secrets: { degraded: ['scheduled events', 'live incidents'] },
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

const col = (row, name, header = FULL_HEADER) => row[header.indexOf(name)];

const jsonResponse = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
});

test('HEADER and EXTRA_COLUMNS have no duplicate columns, and FULL_HEADER is the two in order', () => {
  assert.equal(new Set(FULL_HEADER).size, FULL_HEADER.length);
  for (const name of FULL_HEADER) assert.match(name, /^[a-z][a-z0-9_]*$/, name);
  assert.deepEqual(FULL_HEADER, [...HEADER, ...EXTRA_COLUMNS]);
  // The live tab's first row was written with these six extras, in this order.
  assert.deepEqual(EXTRA_COLUMNS.slice(0, 6), [
    'closures_active', 'closures_source_live', 'closures_addresses', 'maryland_on_route', 'maryland_total', 'maryland_descriptions',
  ]);
});

test('buildRow is aligned to FULL_HEADER', () => {
  const row = buildRow({ now, config, options, incidents, verdict });
  assert.equal(row.length, FULL_HEADER.length);
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
  assert.equal(col(row, 'degraded_signals'), 'scheduled events, live incidents');
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

test('extras land under their EXTRA_COLUMNS label whatever order they are given in; an unlisted one is refused', () => {
  const extras = { maryland_total: 47, closures_active: 3, closures_source_live: false };
  assert.deepEqual(headerFor(extras), Array.from(FULL_HEADER));
  const row = buildRow({ now, config, options, incidents, verdict, extras });
  assert.equal(row.length, FULL_HEADER.length);
  assert.equal(col(row, 'closures_active'), '3');
  assert.equal(col(row, 'closures_source_live'), 'false');
  assert.equal(col(row, 'maryland_total'), '47');
  assert.equal(col(row, 'events_count'), '', 'an extra not given is empty');
  // A key that is not a column would land under the wrong label in BigQuery.
  assert.throws(() => headerFor({ weather_x: 1 }), /weather_x/);
  assert.throws(() => buildRow({ now, config, options, incidents, verdict, extras: { chart_incidents: 3 } }), /chart_incidents/);
});

test('an unknown incident lookup leaves incidents_unstable and road_unstable empty, never false', () => {
  const unknownIncidents = { unstable: null, score: null, count: null, byCategory: {}, reasons: ['live incidents unavailable: HTTP 500'] };
  const row = buildRow({ now, config, options, incidents: unknownIncidents, verdict: { ...verdict, roadUnstable: null } });
  assert.equal(col(row, 'incidents_unstable'), '');
  assert.equal(col(row, 'road_unstable'), '');
  assert.equal(col(row, 'incidents_reasons'), 'live incidents unavailable: HTTP 500');
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

test('ensureHeader writes FULL_HEADER when row 1 is empty and leaves a matching header alone', async () => {
  const writes = [];
  const emptyFetch = async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, { range: 'x', majorDimension: 'ROWS' });
    writes.push(JSON.parse(init.body));
    return jsonResponse(200, {});
  };
  const created = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: emptyFetch });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.extended, false);
  assert.deepEqual(writes[0].values[0], Array.from(FULL_HEADER));

  const filledFetch = async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, { values: [Array.from(FULL_HEADER)] });
    throw new Error('should not write');
  };
  const kept = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: filledFetch });
  assert.equal(kept.ok, true);
  assert.equal(kept.created, false);
  assert.equal(kept.extended, false);
});

test('ensureHeader extends a header that is a prefix of the columns (the live tab) and refuses any other', async () => {
  const seen = [];
  const writes = [];
  const prefixFetch = async (url, init) => {
    seen.push(`${init.method} ${decodeURIComponent(url).replace(/^.*spreadsheets\/S/, '')}`);
    if (init.method === 'GET') return jsonResponse(200, { values: [[...FULL_HEADER.slice(0, HEADER.length + 6), '', '']] });
    writes.push(JSON.parse(init.body));
    return jsonResponse(200, {});
  };
  const extended = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: prefixFetch });
  assert.equal(extended.ok, true);
  assert.equal(extended.created, false);
  assert.equal(extended.extended, true);
  assert.ok(seen[0].startsWith("GET /values/'verdicts'!1:1"), seen[0]);
  assert.deepEqual(writes[0].values[0], Array.from(FULL_HEADER));
  assert.equal(writes[0].range, "'verdicts'!A1");

  const otherFetch = async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, { values: [['date', 'choice']] });
    throw new Error('should not write');
  };
  const refused = await ensureHeader({ sheetId: 'S', tab: 'verdicts', token: 't', fetchImpl: otherFetch });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not match/);

  // A tab name with an apostrophe is doubled in the body range as in the URL.
  const quoted = [];
  await ensureHeader({ sheetId: 'S', tab: "Mike's", token: 't', fetchImpl: async (url, init) => {
    if (init.method === 'GET') return jsonResponse(200, {});
    quoted.push(JSON.parse(init.body).range);
    return jsonResponse(200, {});
  } });
  assert.deepEqual(quoted, ["'Mike''s'!A1"]);
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

test('logVerdict happy path: header check then append, in that order, with the deadline on every call', async () => {
  const calls = [];
  const signal = AbortSignal.timeout(10_000);
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    assert.equal(init.signal, signal);
    if (init.method === 'GET') return jsonResponse(200, { values: [Array.from(FULL_HEADER)] });
    return jsonResponse(200, { updates: { updatedRows: 1 } });
  };
  const result = await logVerdict({ now, config, options, incidents, verdict, tokenProvider: async () => 'tok', fetchImpl, signal });
  assert.deepEqual(result, { ok: true, error: null });
  assert.deepEqual(calls, ['GET', 'POST']);
});

test('logVerdict hands the injected fetch to the token provider, so the default never leaves the stub', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('metadata.google.internal')) return jsonResponse(200, { access_token: 'from-stub' });
    if (init.method === 'GET') return jsonResponse(200, { values: [Array.from(FULL_HEADER)] });
    assert.equal(init.headers.Authorization, 'Bearer from-stub');
    return jsonResponse(200, {});
  };
  const result = await logVerdict({ now, config: { ...config }, options, incidents, verdict, fetchImpl });
  assert.deepEqual(result, { ok: true, error: null });
  assert.ok(urls[0].includes('metadata.google.internal'));
  let seen;
  const provider = async (args) => { seen = args; return 'tok'; };
  const signal = AbortSignal.timeout(10_000);
  await logVerdict({ now, config, options, incidents, verdict, tokenProvider: provider, fetchImpl, signal });
  assert.equal(seen.fetchImpl, fetchImpl);
  assert.equal(seen.signal, signal);
});

test('an aborted sheet call is reported by name', async () => {
  const signal = AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const fetchImpl = async (url, init) => { throw init.signal.reason; };
  const result = await appendRow(['a'], { sheetId: 'S', tab: 't', token: 'tok', fetchImpl, signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /TimeoutError/);
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

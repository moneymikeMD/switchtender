// Tests for the rides tab (src/ride/log.js). No network: Sheets is a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RIDES_HEADER, buildRideRow, logRide } from '../src/ride/log.js';
import { ARRIVALS_HEADER, FULL_HEADER } from '../src/log.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const config = {
  route: { timezone: 'America/New_York' },
  log: { sheet_id: 'sheet-123', sheet_tab: 'verdicts', arrivals_tab: 'arrivals' },
  ride: { sheet_tab: 'rides' },
};
const endedAt = new Date('2026-10-21T13:05:00Z');
const ride = {
  version: 1,
  key: 'rides/2026-10-21-am.json',
  leg: 'am',
  local_date: '2026-10-21',
  fence_at: '2026-10-21T11:14:30.000Z',
  status: 'done',
  fixes: [{ lat: 1 }, { lat: 2 }, { lat: 3 }],
  cancel: null,
  lock: { method: 'gps', train_id: '123', at: '2026-10-21T11:30:00Z' },
  alerts: [
    { at: '2026-10-21T12:01:00Z', circuit: 1234, station: 'Park Street', train_id: '123' },
    { at: '2026-10-21T12:20:00Z', circuit: 2345, station: 'Boylston', train_id: '456' },
  ],
  ended: { reason: 'exit', at: '2026-10-21T12:21:00Z' },
};

test('the rides row is its own header, in order, and shares no join column with verdicts or arrivals', () => {
  assert.deepEqual(
    [...RIDES_HEADER],
    [
      'timestamp',
      'local_date',
      'weekday',
      'leg',
      'fence_at',
      'lock_method',
      'train_id',
      'alerts',
      'alert_count',
      'end_reason',
      'fix_count',
      'cancel_reason',
      'ride_key',
    ],
  );
  assert.ok(!RIDES_HEADER.includes('verdict_timestamp'));
  assert.ok(!RIDES_HEADER.includes('place'));
  assert.notDeepEqual([...RIDES_HEADER], [...ARRIVALS_HEADER]);
  assert.notDeepEqual([...RIDES_HEADER], [...FULL_HEADER]);

  const row = buildRideRow({ now: endedAt, timeZone: 'America/New_York', ride });
  assert.equal(row.length, RIDES_HEADER.length);
  assert.deepEqual(row.slice(0, 7), ['2026-10-21T09:05:00-04:00', '2026-10-21', 'Wednesday', 'am', '2026-10-21T11:14:30.000Z', 'gps', '123']);
  assert.deepEqual(JSON.parse(row[7]), [
    { at: '2026-10-21T12:01:00Z', circuit: 1234, station: 'Park Street', train_id: '123' },
    { at: '2026-10-21T12:20:00Z', circuit: 2345, station: 'Boylston', train_id: '456' },
  ]);
  assert.deepEqual(row.slice(8), ['2', 'exit', '3', '', 'rides/2026-10-21-am.json']);
});

test('a cancelled, never-locked ride leaves the lock, alert and end cells empty, never 0 (rule 4)', () => {
  const row = buildRideRow({
    now: endedAt,
    timeZone: 'America/New_York',
    ride: { ...ride, lock: null, alerts: [], ended: null, cancel: { reason: 'not-riding' }, fixes: [] },
  });
  assert.deepEqual(row.slice(5), ['', '', '', '0', '', '0', 'not-riding', 'rides/2026-10-21-am.json']);
});

test('logRide creates the tab on first use and appends one row to it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = decodeURIComponent(url);
    calls.push(`${init.method} ${target.replace(/^.*spreadsheets\/sheet-123/, '')}`);
    if (init.method === 'GET' && target.includes("'rides'!1:1")) return json(400, { error: { message: 'Unable to parse range' } });
    if (init.method === 'POST' && target.includes(':append')) calls.push(`ROW ${JSON.parse(init.body).values[0].join(',')}`);
    return json(200, {});
  };
  const result = await logRide({ now: endedAt, config, ride, tokenProvider: async () => 'tok', fetchImpl });
  assert.deepEqual(result, { ok: true, error: null });
  assert.ok(
    calls.some((c) => c.startsWith('POST :batchUpdate')),
    calls.join('\n'),
  );
  assert.ok(
    calls.some((c) => c.startsWith("PUT /values/'rides'!A1")),
    calls.join('\n'),
  );
  assert.ok(
    calls.some((c) => c.startsWith('ROW 2026-10-21T09:05:00-04:00,2026-10-21,Wednesday,am,')),
    calls.join('\n'),
  );
  assert.ok(!calls.some((c) => c.includes("'verdicts'") || c.includes("'arrivals'")));
});

test('logRide never throws: no sheet, no ride, no token and a broken write are all reported', async () => {
  assert.match((await logRide({ config: { ...config, log: { sheet_id: null } }, ride, tokenProvider: async () => 'tok' })).error, /sheet id/);
  assert.match((await logRide({ config, ride: null, tokenProvider: async () => 'tok' })).error, /no ride/);
  assert.match((await logRide({ config, ride, tokenProvider: async () => null })).error, /credentials/);
  const broken = await logRide({
    config,
    ride,
    tokenProvider: async () => 'tok',
    fetchImpl: async (url, init) => (init.method === 'GET' ? json(200, { values: [[...RIDES_HEADER]] }) : json(503, { error: { message: 'backend' } })),
  });
  assert.deepEqual(broken, { ok: false, error: 'sheets 503: backend' });
  const exploded = await logRide({
    config,
    ride,
    tokenProvider: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(exploded, { ok: false, error: 'unexpected: boom' });
});

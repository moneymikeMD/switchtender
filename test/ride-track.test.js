// Tests for the ride tracker (CMB-150). No network: synthetic polls are built
// over the recorded StandardRoutes fixture so circuit ids and seqs are real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildCircuitIndex,
  buildStationIndex,
  locate,
  normaliseFeed,
  emptyState,
  observe,
  candidates,
  usableFix,
  lockFromFixes,
  seqToPosition,
  distanceM,
  kmhToMs,
  LOST_AFTER_MISSED_POLLS,
} from '../src/ride/track.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/ride/${name}`, import.meta.url), 'utf8'));
const index = buildCircuitIndex(fixture('standard-routes.json'));
const stations = buildStationIndex(fixture('stations.json'));

const circuitAt = (line, track, seq) => {
  for (const [id, c] of index.circuits) if (c.line === line && c.track === track && c.seq === seq) return id;
  throw new Error(`no circuit ${line} ${track} ${seq}`);
};
const stationSeq = (line, track, code) => index.tracks.get(`${line}:${track}`).stations.find((s) => s.code === code).seq;

const CROSSOVER = 413;
const T0 = Date.parse('2026-10-21T11:00:00Z');
const STEP = 15000;

const train = (id, circuit, overrides = {}) => ({
  TrainId: id,
  TrainNumber: '118',
  CarCount: 8,
  DirectionNum: 1,
  CircuitId: circuit,
  DestinationStationCode: 'B11',
  LineCode: 'RD',
  SecondsAtLocation: 10,
  ServiceType: 'Normal',
  ...overrides,
});

function run(polls, state = emptyState()) {
  const events = [];
  polls.forEach((trains, i) => {
    const r = observe(state, { TrainPositions: trains }, index, T0 + i * STEP);
    state = r.state;
    events.push(...r.events);
  });
  return { state, events };
}

test('the circuit index covers both tracks of RD and GR, nothing else, with stations in seq order', () => {
  assert.deepEqual([...index.tracks.keys()].sort(), ['GR:1', 'GR:2', 'RD:1', 'RD:2']);
  const rd1 = index.tracks.get('RD:1').stations;
  assert.equal(rd1[0].code, 'A15');
  assert.equal(rd1.at(-1).code, 'B11');
  assert.ok(rd1.every((s, i) => i === 0 || s.seq > rd1[i - 1].seq));
  assert.equal(locate(index, circuitAt('RD', 1, 1)).station, 'A15');
  assert.equal(locate(index, CROSSOVER), null);
});

test('normaliseFeed keeps only indexed lines and skips malformed entries', () => {
  const out = normaliseFeed({ TrainPositions: [train('1', 7), train('2', 7, { LineCode: 'BL' }), { LineCode: 'RD' }] });
  assert.deepEqual(
    out.map((t) => t.id),
    ['1'],
  );
  assert.deepEqual(normaliseFeed(null), []);
});

test('departure from the Shady Grove track-1 platform is timed at the first poll at seq >= 2, confirmed by the next', () => {
  const { state, events } = run([
    [train('100', circuitAt('RD', 1, 1))],
    [train('100', circuitAt('RD', 1, 1))],
    [train('100', circuitAt('RD', 1, 3))],
    [train('100', circuitAt('RD', 1, 5))],
  ]);
  const dep = events.filter((e) => e.type === 'departure');
  assert.deepEqual(dep, [{ type: 'departure', trainId: '100', line: 'RD', track: 1, station: 'A15', at: T0 + 2 * STEP }]);
  assert.equal(state.trains['100'].departures.A15, T0 + 2 * STEP);
});

test('departure from the track-2 platform through a crossover circuit missing from StandardRoutes', () => {
  const { events } = run([
    [train('101', circuitAt('RD', 2, 1), { DirectionNum: 2 })],
    [train('101', CROSSOVER, { DirectionNum: 1 })],
    [train('101', CROSSOVER, { DirectionNum: 1 })],
    [train('101', circuitAt('RD', 1, 4), { DirectionNum: 1 })],
    [train('101', circuitAt('RD', 1, 6), { DirectionNum: 1 })],
  ]);
  const dep = events.filter((e) => e.type === 'departure');
  assert.equal(dep.length, 1);
  assert.equal(dep[0].station, 'A15');
  assert.equal(dep[0].track, 1);
  assert.equal(dep[0].at, T0 + 3 * STEP);
});

test('a one-poll blip past the platform is not a departure (seen live: seq 2 once, then 2 min at seq 1)', () => {
  const seqs = [1, 1, 2, 1, 1, 1, 4, 7];
  const { events } = run(seqs.map((seq) => [train('104', circuitAt('RD', 1, seq))]));
  const dep = events.filter((e) => e.type === 'departure');
  assert.equal(dep.length, 1);
  assert.equal(dep[0].at, T0 + 6 * STEP);
});

test('a train overshooting its destination terminal to seq 0 and back does not depart it', () => {
  const seqs = [3, 1, 0, 0, 1, 1];
  const { events } = run(seqs.map((seq) => [train('105', circuitAt('RD', 2, seq), { DirectionNum: 2, DestinationStationCode: 'A15' })]));
  assert.deepEqual(
    events.filter((e) => e.type === 'departure'),
    [],
  );
});

test('a train first seen mid-line records no departure it did not witness', () => {
  const { events } = run([[train('102', circuitAt('RD', 1, 40))], [train('102', circuitAt('RD', 1, 42))]]);
  assert.deepEqual(
    events.filter((e) => e.type === 'departure'),
    [],
  );
});

test('a single-poll DirectionNum flip is ignored; two consecutive polls change it', () => {
  const c = circuitAt('RD', 1, 60);
  let { state } = run([[train('103', c, { DirectionNum: 1 })], [train('103', c, { DirectionNum: 2 })], [train('103', c, { DirectionNum: 1 })]]);
  assert.equal(state.trains['103'].directionNum, 1);
  ({ state } = run([[train('103', c, { DirectionNum: 2 })], [train('103', c, { DirectionNum: 2 })]], state));
  assert.equal(state.trains['103'].directionNum, 2);
});

test('trains are keyed by TrainId, so two trains sharing TrainNumber 118 stay distinct', () => {
  const { state } = run([
    [train('200', circuitAt('RD', 1, 10)), train('201', circuitAt('RD', 1, 80))],
    [train('200', circuitAt('RD', 1, 12)), train('201', circuitAt('RD', 1, 82))],
  ]);
  assert.deepEqual(Object.keys(state.trains).sort(), ['200', '201']);
  assert.equal(state.trains['200'].seq, 12);
  assert.equal(state.trains['201'].seq, 82);
  assert.equal(state.trains['200'].number, state.trains['201'].number);
});

test('a TrainNumber change at a terminal does not break the TrainId track', () => {
  const { state } = run([[train('202', circuitAt('RD', 1, 10), { TrainNumber: '118' })], [train('202', circuitAt('RD', 1, 12), { TrainNumber: '119' })]]);
  assert.equal(state.trains['202'].number, '119');
  assert.equal(state.trains['202'].firstSeenAt, T0);
});

test('arrival fires once, on the second consecutive poll at the station circuit', () => {
  const a01 = circuitAt('RD', 1, stationSeq('RD', 1, 'A01'));
  const before = circuitAt('RD', 1, stationSeq('RD', 1, 'A01') - 1);
  const after = circuitAt('RD', 1, stationSeq('RD', 1, 'A01') + 1);
  const { events } = run([[train('300', before)], [train('300', a01)], [train('300', a01)], [train('300', a01)], [train('300', after)], [train('300', after)]]);
  const arr = events.filter((e) => e.type === 'arrival');
  assert.deepEqual(arr, [{ type: 'arrival', trainId: '300', line: 'RD', track: 1, station: 'A01', at: T0 + 2 * STEP }]);
  assert.equal(
    events
      .filter((e) => e.type === 'departure')
      .map((e) => e.station)
      .join(),
    'A01',
  );
});

test('one poll on a station circuit is not an arrival', () => {
  const a01 = circuitAt('RD', 1, stationSeq('RD', 1, 'A01'));
  const after = circuitAt('RD', 1, stationSeq('RD', 1, 'A01') + 1);
  const { events } = run([[train('301', a01)], [train('301', after)]]);
  assert.deepEqual(
    events.filter((e) => e.type === 'arrival'),
    [],
  );
});

test('a train missing from one poll is kept; missing from two is lost', () => {
  assert.equal(LOST_AFTER_MISSED_POLLS, 2);
  let { state, events } = run([[train('400', circuitAt('RD', 1, 20))], []]);
  assert.ok(state.trains['400']);
  assert.equal(state.trains['400'].missed, 1);
  assert.deepEqual(events, []);
  ({ state, events } = run([[train('400', circuitAt('RD', 1, 22))]], state));
  assert.equal(state.trains['400'].missed, 0);
  assert.equal(state.trains['400'].seq, 22);
  ({ state, events } = run([[], []], state));
  assert.equal(state.trains['400'], undefined);
  assert.deepEqual(events, [{ type: 'lost', trainId: '400', reason: 'missing', at: T0 + STEP }]);
});

test('a train turning NoPassengers is lost', () => {
  const { state, events } = run([[train('401', circuitAt('RD', 1, 20))], [train('401', circuitAt('RD', 1, 22), { ServiceType: 'NoPassengers' })]]);
  assert.equal(state.trains['401'], undefined);
  assert.deepEqual(events, [{ type: 'lost', trainId: '401', reason: 'no-passengers', at: T0 + STEP }]);
});

test('candidates are Normal trains ordered by departure from the station after a time', () => {
  const { state } = run([
    [train('500', circuitAt('RD', 1, 1)), train('501', circuitAt('RD', 1, 1)), train('502', circuitAt('RD', 1, 1), { ServiceType: 'Special' })],
    [train('500', circuitAt('RD', 1, 3)), train('501', circuitAt('RD', 1, 1)), train('502', circuitAt('RD', 1, 3), { ServiceType: 'Special' })],
    [train('500', circuitAt('RD', 1, 6)), train('501', circuitAt('RD', 1, 3)), train('502', circuitAt('RD', 1, 6), { ServiceType: 'Special' })],
    [train('500', circuitAt('RD', 1, 9)), train('501', circuitAt('RD', 1, 6)), train('502', circuitAt('RD', 1, 9), { ServiceType: 'Special' })],
  ]);
  assert.deepEqual(candidates(state, { station: 'A15' }), ['500', '501']);
  assert.deepEqual(candidates(state, { station: 'A15', after: T0 + 2 * STEP }), ['501']);
  assert.deepEqual(candidates(state, { station: 'A15', line: 'GR' }), []);
  assert.deepEqual(candidates(state, { station: 'A14' }), []);
});

test('usableFix rejects loose or stationary fixes, including underground-style tight stationary ones', () => {
  const base = { lat: 39.1, lon: -77.1, time: T0 };
  assert.equal(usableFix({ ...base, accuracy: 20, speed: 12 }), true);
  assert.equal(usableFix({ ...base, accuracy: 50, speed: 12 }), false);
  assert.equal(usableFix({ ...base, accuracy: 20, speed: 5 }), false);
  assert.equal(usableFix({ ...base, accuracy: 13, speed: 0 }), false);
  assert.equal(usableFix({ ...base, accuracy: 40, speed: 0 }), false);
  assert.equal(usableFix({ ...base, accuracy: 300, speed: 0 }), false);
  assert.equal(usableFix(null), false);
});

test('kmhToMs converts the phone unit', () => {
  assert.equal(kmhToMs(36), 10);
  assert.ok(Number.isNaN(kmhToMs('fast')));
});

test('seqToPosition interpolates between station coordinates along a track', () => {
  const a15 = stations.get('A15');
  const a14 = stations.get('A14');
  const mid = seqToPosition(index, stations, 'RD', 1, (stationSeq('RD', 1, 'A15') + stationSeq('RD', 1, 'A14')) / 2);
  assert.ok(Math.abs(distanceM(mid, a15) - distanceM(mid, a14)) < 5);
  assert.deepEqual(seqToPosition(index, stations, 'RD', 1, 0), { lat: a15.lat, lon: a15.lon });
  assert.equal(seqToPosition(index, stations, 'RD', 9, 0), null);
});

function departures(ids, offsets) {
  const polls = [];
  for (let i = 0; i < 26; i++) {
    polls.push(ids.map((id, k) => train(id, circuitAt('RD', 1, Math.max(1, Math.min(60, 1 + (i - offsets[k]) * 2))))));
  }
  return polls;
}

function fixesAlong(state, id, times, jitter = 0) {
  const t = state.trains[id];
  return times.map((time) => {
    const sample = t.trail.reduce((best, p) => (Math.abs(p.at - time) < Math.abs(best.at - time) ? p : best));
    const pos = seqToPosition(index, stations, 'RD', sample.track, sample.seq);
    return { lat: pos.lat + jitter, lon: pos.lon, accuracy: 15, speed: 18, time };
  });
}

test('matching above-ground fixes lock the right candidate among two', () => {
  const { state } = run(departures(['600', '601'], [1, 9]));
  const ids = candidates(state, { station: 'A15' });
  assert.deepEqual(ids, ['600', '601']);
  const fixes = fixesAlong(state, '600', [T0 + 4 * STEP, T0 + 6 * STEP, T0 + 8 * STEP]);
  const lock = lockFromFixes(state, fixes, index, stations, ids);
  assert.equal(lock.trainId, '600');
  const second = fixesAlong(state, '601', [T0 + 12 * STEP, T0 + 14 * STEP, T0 + 16 * STEP]);
  assert.equal(lockFromFixes(state, second, index, stations, ids).trainId, '601');
});

test('underground-style fixes (tight accuracy, zero speed) never lock, even when positioned on a train', () => {
  const { state } = run(departures(['610'], [1]));
  const fixes = fixesAlong(state, '610', [T0 + 4 * STEP, T0 + 6 * STEP, T0 + 8 * STEP]).map((f, i) => ({ ...f, accuracy: [13, 25, 40][i], speed: 0 }));
  const lock = lockFromFixes(state, fixes, index, stations, ['610']);
  assert.equal(lock.trainId, null);
  assert.match(lock.reason, /no lock/);
});

test('two candidates equally close is ambiguous: no lock, never a guess', () => {
  const { state } = run(departures(['620', '621'], [1, 1]));
  const fixes = fixesAlong(state, '620', [T0 + 4 * STEP, T0 + 6 * STEP]);
  const lock = lockFromFixes(state, fixes, index, stations, ['620', '621']);
  assert.equal(lock.trainId, null);
  assert.match(lock.reason, /ambiguous/);
});

test('fixes far from every candidate, or too few usable fixes, give no lock', () => {
  const { state } = run(departures(['630'], [1]));
  const far = [T0 + 4 * STEP, T0 + 6 * STEP].map((time) => ({ lat: 38.5, lon: -77.5, accuracy: 10, speed: 20, time }));
  assert.equal(lockFromFixes(state, far, index, stations, ['630']).trainId, null);
  const one = fixesAlong(state, '630', [T0 + 4 * STEP]);
  assert.equal(lockFromFixes(state, one, index, stations, ['630']).trainId, null);
  assert.equal(lockFromFixes(state, [], index, stations, []).trainId, null);
});

test('observe never mutates the state it was given', () => {
  const first = run([[train('700', circuitAt('RD', 1, 1))]]).state;
  const frozen = JSON.stringify(first);
  observe(first, { TrainPositions: [train('700', circuitAt('RD', 1, 3))] }, index, T0 + STEP);
  assert.equal(JSON.stringify(first), frozen);
});

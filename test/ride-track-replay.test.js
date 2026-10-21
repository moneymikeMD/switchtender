// Replay of 40 live TrainPositions polls (15 s apart, 2026-10-21 13:29-13:39
// UTC, RD and GR only) through the ride tracker (CMB-150). Off-peak data;
// the assertions below are the facts observed in that recording.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCircuitIndex, buildStationIndex, emptyState, observe, candidates, locate } from '../src/ride/track.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/ride/${name}`, import.meta.url), 'utf8'));
const index = buildCircuitIndex(fixture('standard-routes.json'));
const stations = buildStationIndex(fixture('stations.json'));
const { polls } = fixture('positions.json');

function replay() {
  let state = emptyState();
  const events = [];
  for (const poll of polls) {
    const r = observe(state, poll, index, Date.parse(poll.recordedAt));
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

test('the recording is 40 polls of Normal RD and GR trains, each with a station coordinate available', () => {
  assert.equal(polls.length, 40);
  assert.ok(polls.every((p) => p.TrainPositions.every((t) => ['RD', 'GR'].includes(t.LineCode))));
  assert.ok(polls.every((p) => p.TrainPositions.every((t) => t.ServiceType === 'Normal')));
  for (const track of index.tracks.values()) for (const s of track.stations) assert.ok(stations.has(s.code), s.code);
});

test('TrainNumber repeats within a poll while TrainId does not', () => {
  const dup = polls.some((p) => new Set(p.TrainPositions.map((t) => t.TrainNumber)).size < p.TrainPositions.length);
  assert.equal(dup, true);
  assert.ok(polls.every((p) => new Set(p.TrainPositions.map((t) => t.TrainId)).size === p.TrainPositions.length));
});

test('the feed uses circuits StandardRoutes does not list, and the tracker keeps following through them', () => {
  const unknown = new Set(polls.flatMap((p) => p.TrainPositions.filter((t) => !locate(index, t.CircuitId)).map((t) => t.CircuitId)));
  assert.ok(unknown.has(411));
  const { state } = replay();
  assert.equal(state.polls, 40);
  assert.ok(Object.keys(state.trains).length >= 40);
});

test('exactly one train left Shady Grove in the window; an arriving train that overshoots to seq 0 is not a departure', () => {
  const { state, events } = replay();
  const a15 = events.filter((e) => e.type === 'departure' && e.station === 'A15');
  assert.deepEqual(
    a15.map((e) => [e.trainId, e.track]),
    [['508', 1]],
  );
  assert.deepEqual(candidates(state, { station: 'A15' }), ['508']);
  assert.deepEqual(candidates(state, { station: 'A15', after: a15[0].at + 1 }), []);
});

test('arrival at Metro Center comes at least 60 s before arrival at Gallery Place on the same train', () => {
  const { events } = replay();
  const arrivals = events.filter((e) => e.type === 'arrival');
  const pairs = arrivals.filter((e) => e.station === 'A01').map((a) => [a, arrivals.find((b) => b.trainId === a.trainId && b.station === 'B01')]);
  assert.ok(pairs.length >= 2);
  for (const [a, b] of pairs) {
    assert.ok(b, `train ${a.trainId} reached A01 but never B01 in the window`);
    assert.ok(b.at - a.at >= 60000, `train ${a.trainId}: ${(b.at - a.at) / 1000} s`);
  }
});

test('each train arrives at a station at most once and lost trains are the ones that left the feed', () => {
  const { state, events } = replay();
  const keys = events.filter((e) => e.type === 'arrival').map((e) => `${e.trainId}:${e.station}`);
  assert.equal(new Set(keys).size, keys.length);
  const lost = events.filter((e) => e.type === 'lost');
  assert.ok(lost.every((e) => e.reason === 'missing' && !state.trains[e.trainId]));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFork, approachPoint, leadMetres, FORK_TOLERANCE_METRES, LEAD_MIN_MILES, LEAD_MAX_MILES, LEAD_DEFAULT_MILES } from '../src/fork.js';
import { haversineMetres } from '../src/polyline.js';

const north = (lat) => [lat, 0];
const driveToWork = [north(0), north(0.01), north(0.02), north(0.035), north(0.05)];
const driveToLot = [north(0), north(0.015), north(0.02), [0.02, 0.01], [0.02, 0.02]];

test('findFork returns the divergence point of a shared prefix', () => {
  const fork = findFork(driveToWork, driveToLot);
  assert.equal(fork.status, 'diverges');
  assert.ok(haversineMetres(fork.point, north(0.02)) <= FORK_TOLERANCE_METRES + 1);
  assert.equal(fork.index, 2);
});

test('findFork treats routes within tolerance as shared despite differing vertices', () => {
  const jittered = driveToLot.map(([lat, lon], i) => (i < 3 ? [lat, lon + 0.00008] : [lat, lon]));
  const fork = findFork(driveToWork, jittered);
  assert.equal(fork.status, 'diverges');
  assert.ok(haversineMetres(fork.point, north(0.02)) <= FORK_TOLERANCE_METRES + 10);
});

test('findFork finds a fork between vertices of the drive to work', () => {
  const sparse = [north(0), north(0.05)];
  const fork = findFork(sparse, driveToLot);
  assert.equal(fork.status, 'diverges');
  assert.equal(fork.index, 0);
  assert.ok(haversineMetres(fork.point, north(0.02)) <= FORK_TOLERANCE_METRES + 1);
});

test('findFork on identical polylines is identical and points at the end', () => {
  const fork = findFork(driveToWork, [...driveToWork]);
  assert.equal(fork.status, 'identical');
  assert.deepEqual(fork.point, driveToWork.at(-1));
});

test('findFork on disjoint polylines is disjoint with a null point', () => {
  const far = [
    [1, 1],
    [1, 1.01],
  ];
  assert.deepEqual(findFork(driveToWork, far), { status: 'disjoint', point: null, index: null });
  assert.equal(findFork([], driveToLot).status, 'disjoint');
  assert.equal(findFork(driveToWork, []).point, null);
});

test('findFork honours a custom tolerance', () => {
  const offset = driveToLot.map(([lat, lon], i) => (i < 3 ? [lat, lon + 0.0004] : [lat, lon]));
  assert.equal(findFork(driveToWork, offset).status, 'disjoint');
  assert.equal(findFork(driveToWork, offset, 100).status, 'diverges');
});

test('approachPoint walks back 2414 m before the fork on a straight polyline', () => {
  const route = [north(0), north(0.01), north(0.03), north(0.05)];
  const fork = north(0.04);
  const { point, truncated } = approachPoint(route, fork, 2414);
  assert.equal(truncated, false);
  assert.ok(Math.abs(haversineMetres(point, fork) - 2414) < 2);
  assert.ok(point[0] < fork[0]);
});

test('approachPoint on the fork result of findFork', () => {
  const { point: fork } = findFork(driveToWork, driveToLot);
  const { point } = approachPoint(driveToWork, fork, 1000);
  assert.ok(Math.abs(haversineMetres(point, fork) - 1000) < 2);
});

test('approachPoint returns the start and says so when the lead exceeds the route', () => {
  const route = [north(0), north(0.01), north(0.02)];
  const result = approachPoint(route, north(0.02), 5000);
  assert.deepEqual(result, { point: route[0], truncated: true });
});

test('approachPoint with zero lead returns the fork itself', () => {
  const route = [north(0), north(0.02)];
  const { point, truncated } = approachPoint(route, north(0.01), 0);
  assert.equal(truncated, false);
  assert.ok(haversineMetres(point, north(0.01)) < 0.5);
});

test('approachPoint rejects bad input', () => {
  assert.throws(() => approachPoint([], north(0), 10), TypeError);
  assert.throws(() => approachPoint([north(0)], null, 10), TypeError);
  assert.throws(() => approachPoint([north(0)], north(0), -1), RangeError);
  assert.throws(() => approachPoint([north(0)], north(0), NaN), RangeError);
});

test('leadMetres defaults to 1.5 miles and validates 0.5 to 4 miles', () => {
  assert.equal(LEAD_DEFAULT_MILES, 1.5);
  assert.ok(Math.abs(leadMetres() - 2414.016) < 1e-6);
  assert.ok(Math.abs(leadMetres(LEAD_MIN_MILES) - 804.672) < 1e-6);
  assert.ok(Math.abs(leadMetres(LEAD_MAX_MILES) - 6437.376) < 1e-6);
  assert.throws(() => leadMetres(0.4), RangeError);
  assert.throws(() => leadMetres(4.1), RangeError);
  assert.throws(() => leadMetres(NaN), RangeError);
});

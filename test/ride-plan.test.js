// Tests for the ride plan (src/ride/plan.js) over the recorded StandardRoutes
// fixture, so the derived alert stations are the real ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCircuitIndex } from '../src/ride/track.js';
import { buildPlan, planLeg, alertText, lockText, clockAt, boundRight, nearAlert, LINE_CODES, TRANSFER_GAP_MS } from '../src/ride/plan.js';
import { ConfigError } from '../src/config.js';

const index = buildCircuitIndex(JSON.parse(readFileSync(new URL('./fixtures/ride/standard-routes.json', import.meta.url), 'utf8')));
const TZ = 'America/New_York';

const red = { line: 'Red', board: 'Shady Grove', alight: 'Gallery Place', board_code: 'A15', alight_code: 'B01', alert_code: null };
const green = { line: 'Green', board: 'Gallery Place', alight: 'Waterfront', board_code: 'F01', alight_code: 'F04', alert_code: null };

test("the morning plan: Red Glenmont-bound alerting at Metro Center, Green Branch Ave-bound alerting at L'Enfant Plaza", () => {
  const plan = buildPlan({ leg: 'am', legs: [red, green], index, timeZone: TZ });
  assert.equal(plan.legs.length, 2);
  const [r, g] = plan.legs;
  assert.deepEqual(
    { line: r.line, board: r.board, alight: r.alight, alert: r.alert, dir: r.dir },
    { line: 'RD', board: 'A15', alight: 'B01', alert: 'A01', dir: 1 },
  );
  assert.deepEqual(
    { line: g.line, board: g.board, alight: g.alight, alert: g.alert, dir: g.dir },
    { line: 'GR', board: 'F01', alight: 'F04', alert: 'F03', dir: -1 },
  );
  assert.deepEqual(g.stations, ['F01', 'F02', 'F03', 'F04']);
  assert.equal(r.stations[0], 'A15');
  assert.equal(r.stations.at(-1), 'B01');
  assert.equal(LINE_CODES.Red, 'RD');
  assert.equal(TRANSFER_GAP_MS, 120_000);
});

test('an explicit alert_code wins when it sits between board and alight; anything else is a config error naming the leg', () => {
  assert.equal(planLeg({ ...green, alert_code: 'F02' }, index, 'ride.am.legs[1]').alert, 'F02');
  const bad = (leg, re) =>
    assert.throws(
      () => planLeg(leg, index, 'ride.am.legs[0]'),
      (e) => e instanceof ConfigError && re.test(e.message),
    );
  bad({ ...green, alert_code: 'F04' }, /alert_code F04 is not between/);
  bad({ ...green, alert_code: 'F01' }, /alert_code F01 is not between/);
  bad({ ...red, board_code: null }, /board_code is required/);
  bad({ ...red, alight_code: 'F03' }, /no Red track runs from A15 to F03/);
  bad({ ...red, line: 'Blue' }, /not a line the tracker follows/);
  bad({ ...red, alight_code: 'A15' }, /no Red track runs from A15 to A15/);
  bad({ ...red, alight_code: 'A14' }, /A15 and A14 are adjacent/);
  assert.throws(() => buildPlan({ leg: 'am', legs: [], index }), /legs is empty/);
  assert.throws(() => buildPlan({ leg: 'am', legs: [red, green, red], index }), /at most 2/);
});

test("the words: transfer on the first leg, the train's departure time on the second, local time without a leading zero", () => {
  const plan = buildPlan({ leg: 'am', legs: [red, green], index, timeZone: TZ });
  assert.equal(alertText(plan, 0), 'Next stop Gallery Place. Transfer to Green.');
  assert.equal(alertText(plan, 1, Date.parse('2026-10-21T12:47:10Z')), "Next stop Waterfront. You're on the 8:47 from Gallery Place.");
  assert.equal(alertText(plan, 1, null), 'Next stop Waterfront.');
  assert.equal(lockText(plan, Date.parse('2026-10-21T12:14:00Z')), 'Tracking the 8:14 from Shady Grove');
  assert.equal(lockText(plan, null), 'Tracking a train from Shady Grove');
  assert.equal(clockAt(Date.parse('2026-10-21T17:05:00Z'), TZ), '1:05');
  assert.equal(clockAt(Date.parse('2026-10-21T04:30:00Z'), TZ), '12:30');
  const single = buildPlan({ leg: 'am', legs: [red], index, timeZone: TZ });
  assert.equal(alertText(single, 0), 'Next stop Gallery Place.');
});

test('boundRight needs the line and the direction; nearAlert is true from the station before the alert up to it', () => {
  const plan = buildPlan({ leg: 'am', legs: [red, green], index, timeZone: TZ });
  const [r, g] = plan.legs;
  assert.equal(boundRight({ line: 'RD', travel: 1 }, r), true);
  assert.equal(boundRight({ line: 'RD', travel: -1 }, r), false);
  assert.equal(boundRight({ line: 'RD', travel: null }, r), false);
  assert.equal(boundRight({ line: 'GR', travel: -1 }, g), true);
  assert.equal(boundRight(undefined, g), false);

  const seqOf = (line, track, code) => index.tracks.get(`${line}:${track}`).stations.find((s) => s.code === code).seq;
  const a02 = seqOf('RD', 1, 'A02');
  const a01 = seqOf('RD', 1, 'A01');
  assert.equal(nearAlert(index, { line: 'RD', track: 1, seq: a02 - 1 }, r), false);
  assert.equal(nearAlert(index, { line: 'RD', track: 1, seq: a02 }, r), true);
  assert.equal(nearAlert(index, { line: 'RD', track: 1, seq: a01 - 3 }, r), true);
  assert.equal(nearAlert(index, { line: 'RD', track: 1, seq: a01 }, r), true);
  assert.equal(nearAlert(index, { line: 'RD', track: 1, seq: a01 + 1 }, r), false);
  const f02 = seqOf('GR', 2, 'F02');
  const f03 = seqOf('GR', 2, 'F03');
  assert.equal(nearAlert(index, { line: 'GR', track: 2, seq: f02 + 1 }, g), false);
  assert.equal(nearAlert(index, { line: 'GR', track: 2, seq: f02 }, g), true);
  assert.equal(nearAlert(index, { line: 'GR', track: 2, seq: f03 }, g), true);
  assert.equal(nearAlert(index, { line: 'GR', track: 2, seq: f03 - 1 }, g), false);
  assert.equal(nearAlert(index, { line: 'GR', track: null, seq: null }, g), false);
  assert.equal(nearAlert(index, undefined, g), false);
});

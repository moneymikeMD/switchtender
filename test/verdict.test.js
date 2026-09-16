// Tests for the decision rule and the spoken line. Pure functions, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildOptions } from '../src/routes.js';
import {
  decide,
  speak,
  requiredMargin,
  confidenceBand,
  CONGESTION_MARGIN_SCALE,
} from '../src/verdict.js';

const fixture = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));

const decision = { transit_wins_ties: true, minimum_drive_margin_minutes: 5 };

/** Hand-built options: minutes in, seconds out, congestion score as given. */
function options(driveMin, transitMin, score) {
  return {
    driveThrough: {
      totalSeconds: driveMin * 60,
      congestion: { score, unknown: score === null },
    },
    parkAndRide: { totalSeconds: transitMin * 60 },
  };
}

test('the fixture, 45 driving against 40 park and ride, goes to transit', () => {
  const verdict = decide(buildOptions(fixture, 5), decision, { degraded: [] });
  assert.equal(verdict.choice, 'transit');
  assert.equal(verdict.driveMinutes, 45);
  assert.equal(verdict.transitMinutes, 40);
  assert.equal(verdict.marginMinutes, -5);
  assert.ok(verdict.congestionScore > 0 && verdict.congestionScore < 0.1);
  assert.equal(verdict.confidence, 1);
});

test('a tie goes to transit', () => {
  const verdict = decide(options(30, 30, 0), decision, {});
  assert.equal(verdict.choice, 'transit');
  assert.equal(verdict.marginMinutes, 0);
  assert.ok(verdict.reasons.some((r) => r.includes('ties')));
});

test('transit_wins_ties false lets an exact margin go to driving', () => {
  const noTies = { transit_wins_ties: false, minimum_drive_margin_minutes: 5 };
  assert.equal(decide(options(25, 30, 0), noTies, {}).choice, 'drive');
  assert.equal(decide(options(25, 30, 0), decision, {}).choice, 'transit');
});

test('driving wins a clear road by more than the floor margin', () => {
  const verdict = decide(options(20, 30, 0), decision, {});
  assert.equal(verdict.choice, 'drive');
  assert.equal(verdict.marginMinutes, 10);
  assert.equal(verdict.requiredMarginMinutes, 5);
  assert.equal(verdict.confidence, 1);
  assert.ok(verdict.reasons.some((r) => r.includes('clear')));
});

test('the same margin loses under heavy congestion because the required margin grew', () => {
  const verdict = decide(options(20, 30, 0.8), decision, {});
  assert.equal(verdict.choice, 'transit');
  assert.equal(verdict.requiredMarginMinutes, 5 * (1 + CONGESTION_MARGIN_SCALE * 0.8));
  assert.ok(verdict.requiredMarginMinutes > verdict.marginMinutes);
  assert.ok(verdict.reasons.some((r) => r.includes('jammed')));
});

test('required margin scales linearly with the score and is clamped', () => {
  assert.equal(requiredMargin(5, 0), 5);
  assert.equal(requiredMargin(5, 1), 5 * (1 + CONGESTION_MARGIN_SCALE));
  assert.equal(requiredMargin(5, 2), 5 * (1 + CONGESTION_MARGIN_SCALE));
  assert.equal(requiredMargin(5, null), 5);
});

test('unknown congestion uses the floor margin and lowers confidence with a reason', () => {
  const clear = decide(options(20, 30, 0), decision, {});
  const unknown = decide(options(20, 30, null), decision, {});
  assert.equal(unknown.choice, 'drive');
  assert.equal(unknown.requiredMarginMinutes, clear.requiredMarginMinutes);
  assert.equal(unknown.congestionScore, null);
  assert.ok(unknown.confidence < clear.confidence);
  assert.ok(unknown.reasons.some((r) => r.includes('unknown')));
});

test('a degraded signal lowers confidence without changing the choice', () => {
  const full = decide(options(20, 30, 0), decision, { degraded: [] });
  const degraded = decide(options(20, 30, 0), decision, {
    degraded: ['live incidents', 'rail alerts'],
  });
  assert.equal(degraded.choice, full.choice);
  assert.equal(degraded.marginMinutes, full.marginMinutes);
  assert.ok(degraded.confidence < full.confidence);
  assert.ok(degraded.reasons.some((r) => r.includes('live incidents')));
  assert.ok(degraded.reasons.some((r) => r.includes('rail alerts')));

  // Even a badly degraded transit-side picture cannot flip a transit verdict.
  const transit = decide(options(30, 30, 0), decision, {
    degraded: ['live incidents', 'scheduled events', 'rail alerts'],
  });
  assert.equal(transit.choice, 'transit');
});

test('a close call lowers confidence', () => {
  const clear = decide(options(20, 30, 0), decision, {});
  const close = decide(options(24, 30, 0), decision, {});
  assert.equal(close.choice, 'drive');
  assert.ok(close.confidence < clear.confidence);
  assert.ok(close.reasons.some((r) => r.includes('close call')));
});

test('confidence never reaches zero', () => {
  const verdict = decide(options(29, 30, null), decision, {
    degraded: Array(12).fill('a signal'),
  });
  assert.ok(verdict.confidence > 0);
});

test('confidence bands map to words', () => {
  assert.equal(confidenceBand(1), 'high');
  assert.equal(confidenceBand(0.75), 'high');
  assert.equal(confidenceBand(0.6), 'moderate');
  assert.equal(confidenceBand(0.2), 'low');
});

test('speak puts the verdict first and last, with the minutes and a confidence word', () => {
  const verdict = decide(options(20, 30, 0), decision, { degraded: ['rail alerts'] });
  const line = speak(verdict);
  const sentences = line.split('. ').map((s) => s.replace(/\.$/, ''));
  assert.equal(sentences[0], 'Keep driving');
  assert.equal(sentences.at(-1), 'Keep driving');
  assert.ok(line.includes('20 minutes'));
  assert.ok(line.includes('30 minutes'));
  assert.ok(/Confidence is (high|moderate|low)\./.test(line));
  // Order: time figure before reason before confidence.
  assert.ok(line.indexOf('20 minutes') < line.indexOf('saves'));
  assert.ok(line.indexOf('saves') < line.indexOf('Confidence'));
  assert.ok(line.indexOf('Confidence') < line.lastIndexOf('Keep driving'));
  // TTS hygiene: no abbreviations, no decimals.
  assert.ok(!/\bmin\b/.test(line));
  assert.ok(!/\d\.\d/.test(line));
});

test('speak on a transit verdict says so twice', () => {
  const line = speak(decide(buildOptions(fixture, 5), decision, {}));
  assert.ok(line.startsWith('Take the train.'));
  assert.ok(line.endsWith('Take the train.'));
  assert.ok(line.includes('40 minutes'));
});

// Live incidents (CMB-22) feed confidence and the reason, never the choice.

const steadyBox = { unstable: false, score: 0, count: 12, byCategory: {}, reasons: [] };
const unstableBox = {
  unstable: true,
  score: 0.75,
  count: 13,
  byCategory: {},
  reasons: ['accident on Example Pkwy to Sample St, 9 minutes of delay', 'second', 'third'],
};
const unknownBox = { unstable: false, score: null, count: null, byCategory: {}, reasons: ['live incidents unavailable: HTTP 500'] };

test('a steady incident box changes nothing but records the score', () => {
  const clean = decide(options(30, 60, 0), decision);
  const withBox = decide(options(30, 60, 0), decision, { incidents: steadyBox });
  assert.equal(withBox.choice, clean.choice);
  assert.equal(withBox.confidence, clean.confidence);
  assert.equal(withBox.incidentsScore, 0);
  assert.equal(withBox.roadUnstable, false);
});

test('an unstable road lowers confidence, speaks at most two incident reasons, and never flips the choice', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { incidents: unstableBox });
  assert.equal(v.choice, 'drive');
  assert.equal(v.choice, clean.choice);
  assert.ok(v.confidence < clean.confidence);
  assert.equal(v.roadUnstable, true);
  assert.equal(v.incidentsScore, 0.75);
  assert.ok(v.reasons.includes('the drive estimate is unstable'));
  assert.ok(v.reasons.includes(unstableBox.reasons[0]));
  assert.ok(v.reasons.includes('second'));
  assert.ok(!v.reasons.includes('third'));
});

test('a failed incident lookup is unknown, not clear: small penalty, reason, null score', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { incidents: unknownBox });
  assert.equal(v.choice, clean.choice);
  assert.ok(v.confidence < clean.confidence);
  assert.equal(v.incidentsScore, null);
  assert.equal(v.roadUnstable, false);
  assert.ok(v.reasons.some((r) => r.startsWith('live incidents unavailable')));
});

test('no incidents context at all leaves the incident fields null and false', () => {
  const v = decide(options(30, 60, 0), decision);
  assert.equal(v.incidentsScore, null);
  assert.equal(v.roadUnstable, false);
});

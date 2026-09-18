// Tests for the decision rule and the spoken line. Pure functions, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildOptions } from '../src/routes.js';
import { decide, speak, requiredMargin, confidenceBand, CONGESTION_MARGIN_SCALE, arrivalAt } from '../src/verdict.js';

const fixture = JSON.parse(readFileSync('test/fixtures/routes-congested.json', 'utf8'));

const decision = { transit_wins_ties: true, minimum_drive_margin_minutes: 5 };

/** Hand-built options: minutes in, seconds out, congestion score as given. */
function options(driveMin, transitMin, score) {
  return { driveThrough: { totalSeconds: driveMin * 60, congestion: { score, unknown: score === null } }, parkAndRide: { totalSeconds: transitMin * 60 } };
}

test('the fixture, 45 driving against 40 park and ride, goes to transit', () => {
  const verdict = decide(buildOptions(fixture, { platform: 5 }), decision, { degraded: [] });
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
  const degraded = decide(options(20, 30, 0), decision, { degraded: ['live incidents', 'rail alerts'] });
  assert.equal(degraded.choice, full.choice);
  assert.equal(degraded.marginMinutes, full.marginMinutes);
  assert.ok(degraded.confidence < full.confidence);
  assert.ok(degraded.reasons.some((r) => r.includes('live incidents')));
  assert.ok(degraded.reasons.some((r) => r.includes('rail alerts')));

  // Even a badly degraded transit-side picture cannot flip a transit verdict.
  const transit = decide(options(30, 30, 0), decision, { degraded: ['live incidents', 'scheduled events', 'rail alerts'] });
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
  const verdict = decide(options(29, 30, null), decision, { degraded: Array(12).fill('a signal') });
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
  const line = speak(decide(buildOptions(fixture, { platform: 5 }), decision, {}));
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
const unknownBox = { unstable: null, score: null, count: null, byCategory: {}, reasons: ['live incidents unavailable: HTTP 500'] };

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
  // One clause, so the crash itself survives the spoken cap.
  const clause = v.reasons.find((r) => r.startsWith('the drive estimate is unstable'));
  assert.equal(clause, `the drive estimate is unstable: ${unstableBox.reasons[0]}; second`);
  assert.ok(!clause.includes('third'));
  assert.ok(speak(v).includes(unstableBox.reasons[0]), 'the crash is heard');
});

test('a failed incident lookup is unknown, not clear: small penalty, reason, null score', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { incidents: unknownBox });
  assert.equal(v.choice, clean.choice);
  assert.ok(v.confidence < clean.confidence);
  assert.equal(v.incidentsScore, null);
  assert.equal(v.roadUnstable, null, 'unknown is not steady (rule 4)');
  assert.ok(v.reasons.some((r) => r.startsWith('live incidents unavailable')));
});

test('no incidents context at all leaves the incident fields null and false', () => {
  const v = decide(options(30, 60, 0), decision);
  assert.equal(v.incidentsScore, null);
  assert.equal(v.roadUnstable, false);
});

// Planned closures (CMB-23) and Maryland CHART records (CMB-16): confidence
// and reason only, never the choice.

const noClosures = { active: 0, addresses: [], reasons: [], score: null, sourceLive: true };
const someClosures = { active: 3, addresses: ['a', 'b', 'c'], reasons: ['planned road closure at 1300 Maine Avenue SW'], score: null, sourceLive: true };
const staleClosures = { active: null, addresses: [], reasons: ['planned closures source stale'], score: null, sourceLive: false };
const quietMaryland = { onRoute: 0, total: 47, descriptions: [], reasons: [], score: null };
const busyMaryland = { onRoute: 2, total: 47, descriptions: ['x', 'y'], reasons: ['2 maryland records on the route: x; y'], score: null };
const noMaryland = { onRoute: null, total: null, descriptions: [], reasons: ['maryland incidents unavailable: HTTP 500'], score: null };

test('clean closure and maryland results cost nothing and are recorded as zero', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { closures: noClosures, maryland: quietMaryland });
  assert.equal(v.confidence, clean.confidence);
  assert.equal(v.closuresActive, 0);
  assert.equal(v.marylandOnRoute, 0);
});

test('closures and maryland records on the route each lower confidence, add their reason, never flip the choice', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { closures: someClosures, maryland: busyMaryland });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.2));
  assert.equal(v.closuresActive, 3);
  assert.equal(v.marylandOnRoute, 2);
  assert.ok(v.reasons.includes(someClosures.reasons[0]));
  assert.ok(v.reasons.includes(busyMaryland.reasons[0]));
});

test('a stale or failed keyless feed is unknown: small penalty, spoken, null count', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { closures: staleClosures, maryland: noMaryland });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.2));
  assert.equal(v.closuresActive, null);
  assert.equal(v.marylandOnRoute, null);
  assert.ok(v.reasons.includes('planned closures source stale'));
  assert.ok(v.reasons.some((r) => r.startsWith('maryland incidents unavailable')));
});

function round(n) {
  return Math.round(n * 10) / 10;
}

// Scheduled events (CMB-13) and planned track work (CMB-26): confidence and
// reason only, never the choice.

const quietEvents = { count: 0, evening: 0, weighted: 0, reasons: [], score: 0, unknown: false };
const gameTonight = { count: 2, evening: 1, weighted: 1, reasons: ['Nationals Park game at 7:05 this evening'], score: 0.5, unknown: false };
const noEvents = { count: null, evening: null, weighted: null, reasons: ['scheduled events unavailable: HTTP 500'], score: null, unknown: true };
const noTrackwork = { active: 0, upcoming: 1, staleWindows: 0, reasons: [], score: null, unknown: false };
const singleTracking = { active: 1, upcoming: 1, staleWindows: 1, reasons: ['planned track work on the Red Line through Sunday'], score: null, unknown: false };
const noSchedule = {
  active: null,
  upcoming: null,
  staleWindows: null,
  reasons: ['track work schedule unavailable: no readable schedule table'],
  score: null,
  unknown: true,
};

test('quiet events and no active track work cost nothing and record zeros', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { events: quietEvents, trackwork: noTrackwork });
  assert.equal(v.confidence, clean.confidence);
  assert.equal(v.eveningEvents, 0);
  assert.equal(v.trackworkActive, 0);
  assert.equal(v.reasons.length, clean.reasons.length);
});

test('an evening event and active track work each lower confidence and are spoken, choice untouched', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { events: gameTonight, trackwork: singleTracking });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.3));
  assert.equal(v.eveningEvents, 1);
  assert.equal(v.trackworkActive, 1);
  assert.ok(v.reasons.includes(gameTonight.reasons[0]));
  assert.ok(v.reasons.includes(singleTracking.reasons[0]));
});

test('unknown events or schedule cost a little, are spoken, and leave counts null', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { events: noEvents, trackwork: noSchedule });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.2));
  assert.equal(v.eveningEvents, null);
  assert.equal(v.trackworkActive, null);
  assert.ok(v.reasons.some((r) => r.startsWith('scheduled events unavailable')));
  assert.ok(v.reasons.some((r) => r.startsWith('track work schedule unavailable')));
});

// WMATA rail alerts (CMB-35): same treatment as track work.

const noWmataAlerts = { active: 0, unknown: false, lines: [], categories: [], reasons: [] };
const railAlert = { active: 1, unknown: false, lines: ['Red'], categories: ['alert'], reasons: ['Single tracking on the Red Line'] };
const noWmataFeed = { active: null, unknown: true, reasons: ['rail alerts unavailable: HTTP 500'] };

test('no active rail alerts cost nothing and record zero, not null', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { wmata: noWmataAlerts });
  assert.equal(v.confidence, clean.confidence);
  assert.equal(v.wmataActive, 0);
});

test('an active rail alert on a configured line lowers confidence, is spoken, never flips the choice', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { wmata: railAlert });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.15));
  assert.equal(v.wmataActive, 1);
  assert.ok(v.reasons.includes(railAlert.reasons[0]));
});

test('an unknown rail-alerts feed costs a little, is spoken, and leaves the count null', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, { wmata: noWmataFeed });
  assert.equal(v.choice, clean.choice);
  assert.equal(v.confidence, round(clean.confidence - 0.1));
  assert.equal(v.wmataActive, null);
  assert.ok(v.reasons.some((r) => r.startsWith('rail alerts unavailable')));
});

test('no wmata context at all leaves wmataActive null without touching confidence', () => {
  const clean = decide(options(30, 60, 0), decision);
  const v = decide(options(30, 60, 0), decision, {});
  assert.equal(v.confidence, clean.confidence);
  assert.equal(v.wmataActive, null);
});

test('speak says at most three reason clauses and keeps the rest for the log', () => {
  const v = decide(options(30, 60, 0), decision, { incidents: unstableBox, closures: someClosures, maryland: busyMaryland, events: gameTonight });
  assert.ok(v.reasons.length > 3);
  const line = speak(v);
  assert.ok(line.toLowerCase().includes(v.reasons[0].toLowerCase()));
  assert.ok(line.includes(v.reasons[2]));
  assert.ok(!line.includes(v.reasons[3]));
});

test('findings are spoken before caveats, so a crash ahead beats "no X data" and a close call for the three slots', () => {
  // A close call (margin 6.5 against 5 needed), a failed events feed and a
  // crash: the crash must be heard.
  const v = decide(options(23.5, 30, 0), decision, { degraded: ['rail alerts'], incidents: unstableBox, events: noEvents, trackwork: singleTracking });
  assert.ok(v.reasons.some((r) => r === 'it is a close call'));
  const line = speak(v);
  assert.ok(line.includes('the drive estimate is unstable: accident on Example Pkwy'), line);
  assert.ok(!line.includes('close call'), line);
  assert.ok(!line.includes('no rail alerts data'), line);
  assert.ok(!line.includes('scheduled events unavailable'), line);
  // Logged in full, core then findings then caveats.
  const firstCaveat = v.reasons.findIndex((r) => r === 'it is a close call');
  const lastFinding = v.reasons.findIndex((r) => r === singleTracking.reasons[0]);
  assert.ok(lastFinding < firstCaveat);
  assert.ok(v.reasons.includes('no rail alerts data'));
  assert.ok(v.reasons.some((r) => r.startsWith('scheduled events unavailable')));
});

test('the spoken saving is the difference of the spoken minutes, and a difference that rounds away is "about the same"', () => {
  // 30.4 against 32.6: spoken as 30 and 33, so the saving is 3, not 2.
  const v = decide(options(30.4, 32.6, 0), decision, {});
  assert.equal(v.driveMinutes, 30);
  assert.equal(v.transitMinutes, 33);
  assert.equal(v.marginMinutes, 2.2);
  assert.ok(v.reasons[0].includes('driving saves only 3 minutes'), v.reasons[0]);
  // 30.2 against 30.4 both say 30.
  const same = decide(options(30.2, 30.4, 0), decision, {});
  assert.ok(same.reasons[0].startsWith('both options take about the same time'), same.reasons[0]);
  const faster = decide(options(33, 30, 0), decision, {});
  assert.equal(faster.reasons[0], 'transit is 3 minutes faster');
});

test('arrival clocks are 12-hour in the commute zone, at midnight, noon and across a DST change (CMB-32)', () => {
  const tz = 'America/New_York';
  // 03:59:30Z + 30 s = 04:00Z = midnight EDT.
  assert.equal(arrivalAt(new Date('2026-09-17T03:59:30Z'), 30, tz).clock, '12:00 AM');
  assert.equal(arrivalAt(new Date('2026-09-17T15:30:00Z'), 30 * 60, tz).clock, '12:00 PM');
  // 2026-11-01 05:30Z is 01:30 EDT; an hour later the clock reads 01:30 again, now EST.
  const before = arrivalAt(new Date('2026-11-01T05:30:00Z'), 0, tz);
  const after = arrivalAt(new Date('2026-11-01T05:30:00Z'), 3600, tz);
  assert.equal(before.clock, '1:30 AM');
  assert.equal(after.clock, '1:30 AM');
  assert.equal(after.iso, '2026-11-01T06:30:00.000Z');
  assert.equal(arrivalAt(new Date('2026-09-17T12:00:00Z'), 45 * 60, tz).clock, '8:45 AM');
});

test('decide stamps both arrivals when given a clock and a zone, and leaves them null otherwise', () => {
  const options = buildOptions(fixture, { platform: 5 });
  const bare = decide(options, decision, {});
  assert.equal(bare.driveArrival, null);
  assert.equal(bare.transitArrivalClock, null);
  assert.equal(bare.measuredFrom, 'fork');

  const now = new Date('2026-09-17T12:00:00Z');
  const v = decide(options, decision, { now, timeZone: 'America/New_York' });
  assert.equal(v.driveArrival, '2026-09-17T12:45:00.000Z');
  assert.equal(v.driveArrivalClock, '8:45 AM');
  assert.equal(v.transitArrival, '2026-09-17T12:40:00.000Z');
  assert.equal(v.transitArrivalClock, '8:40 AM');
});

test('speak says the arrival for the chosen option only, right after the times', () => {
  const options = buildOptions(fixture, { platform: 5 });
  const now = new Date('2026-09-17T12:00:00Z');
  const v = decide(options, decision, { now, timeZone: 'America/New_York' });
  assert.equal(v.choice, 'transit');
  const line = speak(v);
  assert.match(line, /^Take the train\. The train is 40 minutes, driving is 45 minutes\. You would arrive at 8:40 AM\. /);
  assert.doesNotMatch(line, /8:45 AM/);
  // Without a clock the sentence is simply absent.
  assert.doesNotMatch(speak(decide(options, decision, {})), /arrive/);
});

test('a whole-trip estimate opens by saying it was measured from home (CMB-30)', () => {
  const options = { ...buildOptions(fixture, { platform: 5 }), measuredFrom: 'origin' };
  const v = decide(options, decision, {});
  assert.equal(v.measuredFrom, 'origin');
  assert.ok(speak(v).startsWith('Starting from home. Take the train.'), speak(v));
  assert.ok(speak(decide(buildOptions(fixture, { platform: 5 }), decision, {})).startsWith('Take the train.'));
});

// The decision rule and the spoken line.
//
// Two durations and a congestion reading are not a decision. `decide` turns
// them into one, and `speak` turns that into a single sentence heard once at
// speed. Both are pure: no clock, no network, no config file. Everything they
// consume is passed in, and everything they conclude is returned in a plain
// object so it can be logged verbatim for later tuning.
//
// Rules from the ticket (CMB-10):
//   - Transit wins ties.
//   - Driving is recommended only when it beats transit by a margin, and the
//     margin grows with the congestion reading on the drive-through leg.
//   - Cost plays no part. Time and risk only.
//   - Unproven or missing signals move confidence and the reason. They never
//     flip the choice (CLAUDE.md rule 3).
//   - Unknown congestion is not clear congestion (CLAUDE.md rule 4).

// How much a fully jammed road (score 1) multiplies the floor margin. At the
// starting value a clear road demands the floor, a road reading 0.25 demands
// 1.75x the floor, and a road jammed end to end demands 4x. THIS IS A GUESS BY
// DESIGN: no logged history exists yet to fit it against. Every input to the
// rule is returned from decide() precisely so the guess can be tuned later.
export const CONGESTION_MARGIN_SCALE = 3;

// Confidence penalties. Also starting guesses, kept as flat subtractions so the
// arithmetic can be checked in one's head from the printed verdict.
export const PENALTY_UNKNOWN_CONGESTION = 0.2; // the deciding signal is missing
export const PENALTY_PER_DEGRADED_SIGNAL = 0.1; // an optional feed has no key
export const PENALTY_CLOSE_CALL = 0.2; // the choice hinged on a small number
export const CLOSE_CALL_MINUTES = 2; // |margin - required| below this is close
export const CONFIDENCE_FLOOR = 0.1; // never zero: a verdict was still given

// Spoken bands. A decimal is meaningless at 60 mph; a word is not.
export const CONFIDENCE_BANDS = [
  [0.75, 'high'],
  [0.5, 'moderate'],
  [0, 'low'],
];

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Required drive advantage, in minutes, for driving to be recommended.
 *
 *   required = floor * (1 + CONGESTION_MARGIN_SCALE * score)
 *
 * where `floor` is decision.minimum_drive_margin_minutes and `score` is the
 * distance-weighted congestion score of the drive-through leg (0 clear, 1
 * jammed end to end). A null score uses the floor unscaled: the caller is
 * expected to lower confidence for it, not to pretend the road is clear.
 */
export function requiredMargin(floorMinutes, congestionScore) {
  if (congestionScore === null || congestionScore === undefined) return floorMinutes;
  const score = Math.min(1, Math.max(0, congestionScore));
  return floorMinutes * (1 + CONGESTION_MARGIN_SCALE * score);
}

/** Map a 0..1 confidence to its spoken word. */
export function confidenceBand(confidence) {
  for (const [threshold, word] of CONFIDENCE_BANDS) {
    if (confidence >= threshold) return word;
  }
  return 'low';
}

/**
 * Decide between driving through and parking to ride.
 *
 * @param options   { driveThrough: { totalSeconds, congestion }, parkAndRide: { totalSeconds } }
 *                  as returned by routes.buildOptions.
 * @param decision  config.decision: { transit_wins_ties, minimum_drive_margin_minutes }.
 * @param context   { degraded: [signal names] }, usually config.secrets.degraded.
 * @returns a plain object; every field is an input or output of the rule.
 */
export function decide(options, decision, context = {}) {
  const degraded = context.degraded ?? [];
  const driveMinutes = options.driveThrough.totalSeconds / 60;
  const transitMinutes = options.parkAndRide.totalSeconds / 60;
  const congestionScore = options.driveThrough.congestion?.score ?? null;
  const congestionUnknown = congestionScore === null;

  // Positive means driving is faster.
  const marginMinutes = transitMinutes - driveMinutes;
  const requiredMarginMinutes = requiredMargin(
    decision.minimum_drive_margin_minutes,
    congestionScore,
  );

  // The choice depends on time and congestion only. Nothing below this line
  // may change it.
  const beatsMargin = decision.transit_wins_ties
    ? marginMinutes > requiredMarginMinutes
    : marginMinutes >= requiredMarginMinutes;
  const choice = beatsMargin ? 'drive' : 'transit';

  const reasons = [];
  const savedBy = Math.abs(Math.round(marginMinutes));
  if (choice === 'drive') {
    reasons.push(
      `driving saves ${savedBy} minutes, more than the ${Math.round(requiredMarginMinutes)} needed`,
    );
  } else if (marginMinutes <= 0) {
    reasons.push(
      marginMinutes === 0
        ? 'both options take the same time, and transit wins ties'
        : `transit is ${savedBy} minutes faster`,
    );
  } else {
    reasons.push(
      `driving saves only ${savedBy} minutes, less than the ${Math.round(requiredMarginMinutes)} needed`,
    );
  }

  let confidence = 1;

  if (congestionUnknown) {
    confidence -= PENALTY_UNKNOWN_CONGESTION;
    reasons.push('congestion on the road ahead is unknown');
  } else if (congestionScore >= 0.5) {
    reasons.push('the road ahead is jammed');
  } else if (congestionScore >= 0.15) {
    reasons.push('the road ahead is slow');
  } else {
    reasons.push('the road ahead is clear');
  }

  if (Math.abs(marginMinutes - requiredMarginMinutes) < CLOSE_CALL_MINUTES) {
    confidence -= PENALTY_CLOSE_CALL;
    reasons.push('it is a close call');
  }

  for (const signal of degraded) {
    confidence -= PENALTY_PER_DEGRADED_SIGNAL;
    reasons.push(`no ${signal} data`);
  }

  confidence = Math.max(CONFIDENCE_FLOOR, round1(Math.min(1, confidence)));

  return {
    choice,
    driveMinutes: Math.round(driveMinutes),
    transitMinutes: Math.round(transitMinutes),
    marginMinutes: round1(marginMinutes),
    requiredMarginMinutes: round1(requiredMarginMinutes),
    congestionScore: congestionUnknown ? null : round1(congestionScore * 100) / 100,
    confidence,
    reasons,
  };
}

const VERDICT_LINE = { drive: 'Keep driving.', transit: 'Take the train.' };

/**
 * One spoken line, in the order confirmed with the owner: verdict, time
 * figure, reason, confidence, verdict repeated. The repeat is so that a line
 * half heard over road noise is still unambiguous.
 *
 * Numbers are digits and units are whole words: a TTS engine reads "min" as
 * "min", not "minutes".
 */
export function speak(verdict) {
  const said = VERDICT_LINE[verdict.choice];
  const times =
    verdict.choice === 'drive'
      ? `Driving is ${verdict.driveMinutes} minutes, the train is ${verdict.transitMinutes} minutes.`
      : `The train is ${verdict.transitMinutes} minutes, driving is ${verdict.driveMinutes} minutes.`;
  const reason = verdict.reasons.length > 0 ? `${capitalise(verdict.reasons.join(', '))}.` : '';
  const confidence = `Confidence is ${confidenceBand(verdict.confidence)}.`;
  return [said, times, reason, confidence, said].filter(Boolean).join(' ');
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

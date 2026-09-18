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
export const PENALTY_UNSTABLE_ROAD = 0.3; // a live crash or fresh closure ahead (CMB-22)
export const PENALTY_UNKNOWN_INCIDENTS = 0.1; // the incident lookup was tried and failed
export const MAX_INCIDENT_REASONS = 2; // spoken reasons from the incident feed
export const PENALTY_ROUTE_DISRUPTION = 0.1; // a planned closure or Maryland record on the route (CMB-16, CMB-23)
export const PENALTY_UNKNOWN_FEED = 0.1; // a keyless feed was tried and failed
export const PENALTY_EVENING_EVENT = 0.1; // a scheduled event near the destination this evening (CMB-13)
export const PENALTY_TRACK_WORK = 0.2; // planned track work on the transit leg right now (CMB-26)
export const PENALTY_RAIL_ALERT = 0.15; // a live WMATA rail alert on a configured line (CMB-35), a starting guess between PENALTY_UNKNOWN_FEED and PENALTY_TRACK_WORK
export const CLOSE_CALL_MINUTES = 2; // |margin - required| below this is close
export const CONFIDENCE_FLOOR = 0.1; // never zero: a verdict was still given

// Spoken bands. A decimal is meaningless at 60 mph; a word is not.
// How many reason clauses the spoken line carries. Heard once at 60 mph, a
// fourth clause is noise; the log keeps them all.
export const MAX_SPOKEN_REASONS = 3;

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
 * @param context   { degraded: [signal names], incidents, closures, maryland,
 *                  events, trackwork } where degraded is usually
 *                  config.secrets.degraded and the others, if present, are the
 *                  results of incidents.fetchIncidents, closures.fetchClosures,
 *                  chart.fetchChart, events.fetchEvents and
 *                  trackwork.fetchTrackwork.
 * @returns a plain object; every field is an input or output of the rule.
 */
export function decide(options, decision, context = {}) {
  // Three lists, spoken in this order and logged as one: what the decision
  // rests on, what was found on the road, then the caveats. speak() says the
  // first MAX_SPOKEN_REASONS clauses, so a crash ahead is heard before "no
  // scheduled events data" is.
  const core = [];
  const findings = [];
  const caveats = [];
  const degraded = context.degraded ?? [];
  const measuredFrom = options.measuredFrom ?? 'fork';
  const driveMinutes = options.driveThrough.totalSeconds / 60;
  const transitMinutes = options.parkAndRide.totalSeconds / 60;
  const congestionScore = options.driveThrough.congestion?.score ?? null;
  const congestionUnknown = congestionScore === null;

  // Positive means driving is faster.
  const marginMinutes = transitMinutes - driveMinutes;
  const requiredMarginMinutes = requiredMargin(decision.minimum_drive_margin_minutes, congestionScore);

  // The choice depends on time and congestion only. Nothing below this line
  // may change it.
  const beatsMargin = decision.transit_wins_ties ? marginMinutes > requiredMarginMinutes : marginMinutes >= requiredMarginMinutes;
  const choice = beatsMargin ? 'drive' : 'transit';

  // The spoken figure is the difference of the spoken minutes, so "30 against
  // 33" is never followed by "2 minutes faster"; the rule itself uses the
  // exact margin. A difference that rounds away is "about the same".
  const savedBy = Math.abs(Math.round(transitMinutes) - Math.round(driveMinutes));
  if (choice === 'drive') {
    core.push(`driving saves ${savedBy} minutes, more than the ${Math.round(requiredMarginMinutes)} needed`);
  } else if (savedBy === 0) {
    core.push('both options take about the same time, and transit wins ties');
  } else if (marginMinutes < 0) {
    core.push(`transit is ${savedBy} minutes faster`);
  } else {
    core.push(`driving saves only ${savedBy} minutes, less than the ${Math.round(requiredMarginMinutes)} needed`);
  }

  let confidence = 1;

  if (congestionUnknown) {
    confidence -= PENALTY_UNKNOWN_CONGESTION;
    core.push('congestion on the road ahead is unknown');
  } else if (congestionScore >= 0.5) {
    core.push('the road ahead is jammed');
  } else if (congestionScore >= 0.15) {
    core.push('the road ahead is slow');
  } else {
    core.push('the road ahead is clear');
  }

  if (Math.abs(marginMinutes - requiredMarginMinutes) < CLOSE_CALL_MINUTES) {
    confidence -= PENALTY_CLOSE_CALL;
    caveats.push('it is a close call');
  }

  // Signals with no module to report on them. The engine passes nothing
  // here: every optional feed now reports its own missing key as an unknown
  // result, so it is charged once, by the branch below that reads it.
  for (const signal of degraded) {
    confidence -= PENALTY_PER_DEGRADED_SIGNAL;
    caveats.push(`no ${signal} data`);
  }

  // Live incidents (CMB-22): a trajectory signal, not a duration. An active
  // crash or a fresh closure on the remaining road means the drive estimate
  // is unstable, so confidence drops and the incident is the spoken reason,
  // folded into one clause so the crash itself is heard within the cap. It
  // never touches the choice. Absent context.incidents means the lookup was
  // not consulted at all; a lookup that was tried and failed (no key, or an
  // error) arrives with score null and is charged here. roadUnstable is null
  // then: unknown is not steady (rule 4).
  const incidents = context.incidents ?? null;
  let incidentsScore = null;
  let roadUnstable = incidents ? null : false;
  if (incidents) {
    if (incidents.score === null) {
      confidence -= PENALTY_UNKNOWN_INCIDENTS;
      caveats.push(incidents.reasons?.[0] ?? 'live incidents unavailable');
    } else {
      incidentsScore = Math.round(incidents.score * 100) / 100;
      roadUnstable = Boolean(incidents.unstable);
      if (roadUnstable) {
        confidence -= PENALTY_UNSTABLE_ROAD;
        const what = (incidents.reasons ?? []).slice(0, MAX_INCIDENT_REASONS).join('; ');
        findings.push(what ? `the drive estimate is unstable: ${what}` : 'the drive estimate is unstable');
      }
    }
  }

  // Planned District closures (CMB-23) and Maryland CHART records on the
  // route (CMB-16). Both are logged for modelling and, for now, only move
  // confidence and the reason: a count of open permits or maintenance events
  // has not yet been shown to predict a slower drive. Unknown (a failed
  // fetch or a stale source) costs a little and is spoken; a clean zero costs
  // nothing.
  const closures = context.closures ?? null;
  const closuresActive = closures ? closures.active : null;
  if (closures) {
    if (closures.active === null) {
      confidence -= PENALTY_UNKNOWN_FEED;
      caveats.push(closures.reasons?.[0] ?? 'planned closures unavailable');
    } else if (closures.active > 0) {
      confidence -= PENALTY_ROUTE_DISRUPTION;
      findings.push(closures.reasons?.[0] ?? `${closures.active} planned road closures near the destination`);
    }
  }

  const maryland = context.maryland ?? null;
  const marylandOnRoute = maryland ? maryland.onRoute : null;
  if (maryland) {
    if (maryland.onRoute === null) {
      confidence -= PENALTY_UNKNOWN_FEED;
      caveats.push(maryland.reasons?.[0] ?? 'maryland incidents unavailable');
    } else if (maryland.onRoute > 0) {
      confidence -= PENALTY_ROUTE_DISRUPTION;
      findings.push(maryland.reasons?.[0] ?? `${maryland.onRoute} maryland records on the route`);
    }
  }

  // Scheduled events at the configured venues (CMB-13). The one agreed
  // exception to ignoring the evening: a game or concert is already known, so
  // it may lower confidence in the drive and be spoken. Still never the choice.
  const events = context.events ?? null;
  const eveningEvents = events && !events.unknown ? events.evening : null;
  if (events) {
    if (events.unknown) {
      confidence -= PENALTY_UNKNOWN_FEED;
      caveats.push(events.reasons?.[0] ?? 'scheduled events unavailable');
    } else if (events.evening > 0) {
      confidence -= PENALTY_EVENING_EVENT;
      findings.push(...(events.reasons ?? []).slice(0, MAX_INCIDENT_REASONS));
    }
  }

  // Planned track work on the transit leg (CMB-26). An active window makes
  // the transit duration actively wrong, which is a bigger dent than an event.
  // Upcoming windows are informational and not spoken at the fork.
  const trackwork = context.trackwork ?? null;
  const trackworkActive = trackwork && !trackwork.unknown ? trackwork.active : null;
  if (trackwork) {
    if (trackwork.unknown) {
      confidence -= PENALTY_UNKNOWN_FEED;
      caveats.push(trackwork.reasons?.[0] ?? 'track work schedule unavailable');
    } else if (trackwork.active > 0) {
      confidence -= PENALTY_TRACK_WORK;
      findings.push(...(trackwork.reasons ?? []).slice(0, MAX_INCIDENT_REASONS));
    }
  }

  // Live WMATA rail alerts on the transit leg's configured lines (CMB-35).
  // Same treatment as track work: a real-time signal on the transit option,
  // never the choice.
  const wmata = context.wmata ?? null;
  const wmataActive = wmata && !wmata.unknown ? wmata.active : null;
  if (wmata) {
    if (wmata.unknown) {
      confidence -= PENALTY_UNKNOWN_FEED;
      caveats.push(wmata.reasons?.[0] ?? 'rail alerts unavailable');
    } else if (wmata.active > 0) {
      confidence -= PENALTY_RAIL_ALERT;
      findings.push(...(wmata.reasons ?? []).slice(0, MAX_INCIDENT_REASONS));
    }
  }

  const reasons = [...core, ...findings, ...caveats];
  confidence = Math.max(CONFIDENCE_FLOOR, round1(Math.min(1, confidence)));

  // Arrival at the destination door for each option (CMB-32). Needs a clock
  // and a zone; without both the fields are null and nothing is spoken.
  const now = context.now instanceof Date ? context.now : null;
  const timeZone = context.timeZone ?? null;
  const arrival = (seconds) => (now && timeZone ? arrivalAt(now, seconds, timeZone) : { iso: null, clock: null });
  const driveArrival = arrival(options.driveThrough.totalSeconds);
  const transitArrival = arrival(options.parkAndRide.totalSeconds);

  return {
    choice,
    measuredFrom,
    driveMinutes: Math.round(driveMinutes),
    transitMinutes: Math.round(transitMinutes),
    driveArrival: driveArrival.iso,
    driveArrivalClock: driveArrival.clock,
    transitArrival: transitArrival.iso,
    transitArrivalClock: transitArrival.clock,
    marginMinutes: round1(marginMinutes),
    requiredMarginMinutes: round1(requiredMarginMinutes),
    congestionScore: congestionUnknown ? null : Math.round(congestionScore * 100) / 100,
    incidentsScore,
    roadUnstable,
    closuresActive,
    marylandOnRoute,
    eveningEvents,
    trackworkActive,
    wmataActive,
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
  // A whole-trip estimate (CMB-30) says where it was measured from, so the
  // same sentence shape is never mistaken for the one heard at the fork.
  const from = verdict.measuredFrom === 'origin' ? 'Starting from home.' : '';
  const times =
    verdict.choice === 'drive'
      ? `Driving is ${verdict.driveMinutes} minutes, the train is ${verdict.transitMinutes} minutes.`
      : `The train is ${verdict.transitMinutes} minutes, driving is ${verdict.driveMinutes} minutes.`;
  // Arrival for the chosen option only (CMB-32, owner decision 2026-09-17):
  // both are in the JSON, one is worth hearing.
  const clock = verdict.choice === 'drive' ? verdict.driveArrivalClock : verdict.transitArrivalClock;
  const arrival = clock ? `You would arrive at ${clock}.` : '';
  // At most MAX_SPOKEN_REASONS clauses are said aloud (owner decision
  // 2026-09-16); the full list stays on the verdict object for the log.
  // decide() orders them core, findings, caveats, so the cap trims caveats
  // ("no X data", "it is a close call") before anything found on the road.
  const spokenReasons = verdict.reasons.slice(0, MAX_SPOKEN_REASONS);
  const reason = spokenReasons.length > 0 ? `${capitalise(spokenReasons.join(', '))}.` : '';
  const confidence = `Confidence is ${confidenceBand(verdict.confidence)}.`;
  return [from, said, times, arrival, reason, confidence, said].filter(Boolean).join(' ');
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * When a trip of `seconds` starting at `now` ends, as an ISO instant and as a
 * 12-hour clock reading in the commute's zone ("9:52 AM"). Twelve-hour is the
 * owner's choice (CMB-32); a TTS engine reads "AM" and "PM" cleanly.
 */
export function arrivalAt(now, seconds, timeZone) {
  const at = new Date(now.getTime() + seconds * 1000);
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
    .format(at)
    // Intl may separate the meridiem with a narrow no-break space; TTS and
    // tests want a plain one.
    .replace(/ | /g, ' ');
  return { iso: at.toISOString(), clock };
}

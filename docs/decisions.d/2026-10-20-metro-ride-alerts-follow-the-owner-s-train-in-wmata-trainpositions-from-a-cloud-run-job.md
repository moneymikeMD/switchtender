---
date: 2026-10-20
slug: metro-ride-alerts-follow-the-owner-s-train-in-wmata-trainpositions-from-a-cloud-run-job
title: "Metro ride alerts follow the owner's train in WMATA TrainPositions from a Cloud Run Job"
---

# Metro ride alerts follow the owner's train in WMATA TrainPositions from a Cloud Run Job

## Decision

Transfer and exit alerts come from following the owner's actual train in WMATA's TrainPositions feed (keyed by TrainId), not from GPS, timers or third-party apps. A Cloud Run Job per ride polls the feed, locks the Red train from GPS fixes on the above-ground stretch Shady Grove to Grosvenor, and alerts on arrival at the station before the target (Metro Center, L'Enfant Plaza, Archives). Rides start automatically: morning from the park-and-ride lot fence (weekdays 05:30-10:00), evening from a Waterfront entrance fence (weekdays 16:30-22:30) gated on GPS going underground. Alerts go to a separate ntfy.sh topic at max priority and the phone vibrates until dismissed; nothing is spoken. Green legs track two candidate trains, each alert naming its train. Ride state is one GCS object per ride created with ifGenerationMatch=0. Epic CMB-148.

## Why

GPS is unavailable on most of the ride (Red underground from Medical Center south, all of Green), so only the operator feed can tell where the train is. Live check 2026-10-20: TrainId is stable within a trip while TrainNumber changes at terminals and is not unique; alerting on departure from the previous station gave only 15-30 s before the target, arrival gives 75-110 s. Rejected: Transit/Google Maps/Citymapper get-off alerts (owner wants to own the interaction), timers (wrong when trains run off schedule), accelerometer stop counts (holds miscount), office-fence or manual evening starts (happy-hour days; manual taps get forgotten), spoken alerts (rude on the train), learned walk delay (owner: use addl_walk_mins), request-bound loops and Cloud Tasks (60 min and 30 min caps), reusing the verdict ntfy topic (the vibrate macro would fire on the 7:30 verdict push).

## Cost

One Cloud Run Job execution per ride (about 1-1.5 h at 1 vCPU, cents per month), about 280 WMATA calls per ride against a 50,000/day key, a new GCS bucket and ntfy topic, and roles/run.developer on the one Job for the runtime service account.

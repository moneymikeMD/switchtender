---
date: 2026-11-05
slug: the-evening-ride-starts-on-the-waterfront-entrance-fence-alone-and-narrows-red-by-gps-past-grosvenor
title: "The evening ride starts on the Waterfront entrance fence alone and narrows Red by GPS past Grosvenor"
supersedes: docs/decisions.d/2026-10-20-metro-ride-alerts-follow-the-owner-s-train-in-wmata-trainpositions-from-a-cloud-run-job.md
---

# The evening ride starts on the Waterfront entrance fence alone and narrows Red by GPS past Grosvenor

## Decision

The evening ride (CMB-161) has no underground GPS gate. The Waterfront entrance fence alone starts it. Green tracks the first two trains to leave Waterfront after the fence, each alert naming its departure, with no GPS lock. Each Green candidate's arrival at Gallery Place gives Red two candidates after the transfer gap. When a Red candidate leaves Grosvenor (gps_after_code) the Job sends a quiet status that starts the phone's fix loop for gps_window_mins (default 10), and a lock narrows Red to one train; without a lock every Red candidate still alerts. This replaces the 'gated on GPS going underground' evening start in the CMB-148 record.

## Why

The CMB-149 spike (2026-10-21) showed no fix distinguishes underground from street: accuracy 13-600 m and speed 0 in both. Green from Waterfront is underground end to end, so no GPS lock can run there. Owner, 2026-11-05: walking past the entrance is an acceptable start, with no bars near that stop. Rejected: the underground gate (undetectable), an office fence (happy-hour days, CMB-158), a manual tap (forgotten, CMB-158), a GPS lock on Green (underground), and ending the ride when Red does not lock (about half of above-ground fixes exceed 50 m, so a poor-GPS evening would lose its exit alert).

## Cost

An entrance walk-past costs a ride of alerts naming trains the owner is not on, ended by the cancel button. An unlocked evening sends up to four Red alerts instead of one. About ten minutes of phone GPS per evening ride, and one more WMATA-polled Job execution per walk-past.

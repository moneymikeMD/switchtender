---
date: 2026-09-16
slug: tomtom-not-mapquest-is-the-dc-incident-feed-chosen-by-live-query-over-desk-research
title: "TomTom, not MapQuest, is the DC incident feed, chosen by live query over desk research"
---

# TomTom, not MapQuest, is the DC incident feed, chosen by live query over desk research

## Decision

On 2026-09-16 both providers were queried against the same District bounding box in the same minute. TomTom is the incident source because it separates cause from congestion; MapQuest, which desk research had ranked first, is a closure and construction feed whose congestion fields are empty in practice. HERE was untested and no longer pursued.

## Why

TomTom returned 71 incidents with 32 carrying a delay in seconds and a magnitude. MapQuest returned 78 records but no congestion records, zero delay fields and 46 described only as Closed, so it cannot tell a crash queue from steady congestion.

## Cost

unrecorded in memory 9e963253

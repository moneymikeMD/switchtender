---
date: 2026-09-16
slug: planned-wmata-track-work-is-scraped-from-the-html-schedule-page-not-a-structured-feed
title: "Planned WMATA track work is scraped from the HTML schedule page, not a structured feed"
---

# Planned WMATA track work is scraped from the HTML schedule page, not a structured feed

## Decision

CMB-14 spike 2026-09-16: no WMATA API or RSS feed carries future track work. Switchtender scrapes the wmata.com/service/track-work.cfm table (CMB-26) and makes a parse failure distinguishable in logs from a genuine empty result. 3e3599dd later confirmed GTFS-RT alerts carry no advance notice.

## Why

The Rail Incidents API only shows conditions already in effect, the RSS feed is a 404, and GTFS static calendar_dates carry no reason text. The HTML table is the only verified-current source with future windows.

## Cost

unrecorded in memory 9793fa24

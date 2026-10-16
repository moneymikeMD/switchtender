---
date: 2026-09-15
slug: switchtender-v2-is-a-now-decision-tool-at-i-270-exit-9-all-v1-code-scrapped
title: "Switchtender v2 is a now-decision tool at I-270 Exit 9; all v1 code scrapped"
---

# Switchtender v2 is a now-decision tool at I-270 Exit 9; all v1 code scrapped

## Decision

Grilling 2026-09-15 scrapped v1 and made v2 a now-decision tool that fires 4 miles before Exit 9 (Shady Grove West lot). Metro wins ties; driving must beat it by a margin that scales with congestion. It runs on Cloud Run via a plain shared-secret endpoint and logs every field to a Google Sheet; only .env files survive from v1.

## Why

v1 compared home-to-office against home-to-Shady-Grove-to-office, but the leg from the house to Exit 9 is common to both and cancels out, so the premise was wrong.

## Cost

unrecorded in memory a01a4add

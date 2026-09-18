// Live WMATA rail incidents (CMB-35), scored the way src/trackwork.js scores
// planned track work: line-matched against config.transit.lines, feeding
// confidence and the spoken reason, never the verdict (CLAUDE.md rule 3).
//
// Endpoint and shape confirmed live 2026-09-18 against the project's own key
// (public docs at developer.wmata.com were not enough to trust blind):
// `GET https://api.wmata.com/Incidents.svc/json/Incidents`, header `api_key`,
// `{ Incidents: [{ IncidentID, Description, LinesAffected, IncidentType, ... }] }`.
// `LinesAffected` is semicolon-separated two-letter codes with a trailing
// semicolon, e.g. `"SV;"`, `"OR;RD;"` -- not the full line names trackwork.js
// and config.transit.lines already use.

import { getJson } from './http.js';

export const ENDPOINT = 'https://api.wmata.com/Incidents.svc/json/Incidents';

const CODE_TO_LINE = { RD: 'Red', OR: 'Orange', YL: 'Yellow', GR: 'Green', BL: 'Blue', SV: 'Silver' };

// The only IncidentType this project has observed live is "Alert" (scheduled
// maintenance and service notices). Anything else normalises to 'other'
// rather than being dropped, since WMATA's docs don't enumerate the full set.
const CATEGORY = { Alert: 'alert' };

/** `"OR;RD;"` -> `['Orange', 'Red']`. An unrecognised code is dropped, not thrown. */
export function linesAffected(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((code) => CODE_TO_LINE[code] ?? null)
    .filter(Boolean);
}

export function unknownWmata(reason) {
  return { active: null, unknown: true, reasons: [`rail alerts unavailable: ${reason}`] };
}

/** Incidents affecting none of `lines` are filtered out before this runs. */
export function assessWmata(incidents, lines) {
  if (!Array.isArray(incidents)) return unknownWmata('response had no incident list');
  const wanted = new Set(lines);
  const matched = incidents.filter((incident) => linesAffected(incident?.LinesAffected).some((line) => wanted.has(line)));
  return {
    active: matched.length,
    unknown: false,
    lines: [...new Set(matched.flatMap((i) => linesAffected(i.LinesAffected).filter((l) => wanted.has(l))))],
    categories: [...new Set(matched.map((i) => CATEGORY[i.IncidentType] ?? 'other'))],
    reasons: matched.map((i) => i.Description).filter(Boolean),
  };
}

/**
 * Fetch and assess in one call, mirroring fetchTrackwork: never throws, a
 * missing key or a failed/unparseable response is `unknownWmata`, not a
 * clear zero (CLAUDE.md rule 4).
 */
export async function fetchWmata(lines, apiKey, fetchImpl = fetch, { signal } = {}) {
  try {
    if (!apiKey) return unknownWmata('no TRANSIT_API_KEY');
    const { data, error } = await getJson(ENDPOINT, { fetchImpl, headers: { api_key: apiKey }, signal });
    if (error) return unknownWmata(error);
    return assessWmata(data?.Incidents, lines);
  } catch (cause) {
    return unknownWmata(`unexpected error (${cause?.name ?? 'Error'})`);
  }
}

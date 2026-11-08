// Attribution entries that ride on every verdict result (CMB-133), so any client can show who supplied the data.
// Pure over the signal results; nothing here reads the environment or the network.

const GOOGLE = { source: 'Google', text: 'Powered by Google' };
const TOMTOM = { source: 'TomTom', text: 'Live incident data by TomTom' };
const CHART = { source: 'CHART', text: 'Maryland incident data from CHART (Maryland DOT State Highway Administration)' };
// UNVERIFIED: the CC BY 4.0 terms reading for DDOT data has not been confirmed by the terms ticket.
const DDOT = { source: 'DDOT', text: 'Road closure data from the District Department of Transportation (DDOT), CC BY 4.0' };
const WMATA = { source: 'WMATA', text: 'Rail alert data from the WMATA public API' };
const TRACKWORK = { source: 'WMATA track work', text: 'Planned track work read from the wmata.com planned track work page' };
const TICKETMASTER = { source: 'Ticketmaster', text: 'Event data from Ticketmaster' };
const MLB = { source: 'MLB', text: 'Event data from MLB' };

const consulted = (result) => result != null && result.unknown !== true;

/**
 * Build the attributions list: an array of { source, text } objects, Google first. A signal is
 * listed only when it returned data; null (not consulted) and unknown (tried, no data) add nothing.
 * Entries never imply that WMATA endorses this app.
 */
export function buildAttributions({ incidents = null, closures = null, maryland = null, events = null, trackwork = null, wmata = null, venues = [] } = {}) {
  const list = [GOOGLE];
  if (consulted(incidents) && incidents.score != null) list.push(TOMTOM);
  if (consulted(maryland) && maryland.total != null) list.push(CHART);
  if (consulted(closures) && closures.total != null) list.push(DDOT);
  if (consulted(wmata)) list.push(WMATA);
  if (consulted(events)) {
    const providers = new Set((venues ?? []).map((v) => v?.provider ?? 'ticketmaster'));
    if (providers.has('ticketmaster')) list.push(TICKETMASTER);
    if (providers.has('mlb')) list.push(MLB);
  }
  if (consulted(trackwork)) list.push(TRACKWORK);
  return list.map((entry) => ({ ...entry }));
}

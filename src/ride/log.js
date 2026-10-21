// Rides tab: one row per ride, appended when the ride ends (CMB-151).
//
// Separate from the verdicts and arrivals tabs, not in ARRIVAL_PLACES and
// never joined to a verdict, so the scoring join in BigQuery stays clean. The
// Job writes the row at the end of a ride from the ride object; the HTTP
// endpoints never write here. Same Sheets plumbing and the same never-throws
// policy as src/log.js.

import { appendRow, ensureHeader, tokenFromEnvOrMetadata, localTime, cell } from '../log.js';

/** Column order. Append only; never reorder. */
export const RIDES_HEADER = Object.freeze([
  'timestamp',
  'local_date',
  'weekday',
  'leg',
  'fence_at',
  'lock_method',
  'train_id',
  'alerts',
  'alert_count',
  'end_reason',
  'fix_count',
  'cancel_reason',
  'ride_key',
]);

/**
 * Build one rides row from a ride object (shape in src/ride/state.js).
 * `now` is when the row is written; the ride's own times are in the cells.
 */
export function buildRideRow({ now = new Date(), timeZone = 'UTC', ride }) {
  const t = localTime(now, timeZone);
  const alerts = Array.isArray(ride.alerts) ? ride.alerts : [];
  return [
    t.timestamp,
    ride.local_date ?? t.localDate,
    t.weekday,
    ride.leg ?? null,
    ride.fence_at ?? null,
    ride.lock?.method ?? null,
    ride.lock?.train_id ?? null,
    alerts.length > 0 ? alerts.map((a) => ({ at: a.at ?? null, circuit: a.circuit ?? null, station: a.station ?? null, train_id: a.train_id ?? null })) : null,
    alerts.length,
    ride.ended?.reason ?? null,
    Array.isArray(ride.fixes) ? ride.fixes.length : 0,
    ride.cancel?.reason ?? null,
    ride.key ?? null,
  ].map(cell);
}

/** Append one ride to the rides tab. Never throws. Returns { ok, error }. */
export async function logRide({ now = new Date(), config, ride, tokenProvider = tokenFromEnvOrMetadata, fetchImpl = fetch, signal }) {
  try {
    const sheetId = config?.log?.sheet_id;
    const tab = config?.ride?.sheet_tab ?? 'rides';
    if (!sheetId) return { ok: false, error: 'no sheet id configured' };
    if (!ride || typeof ride !== 'object') return { ok: false, error: 'no ride' };

    const token = await tokenProvider({ fetchImpl, signal });
    if (!token) return { ok: false, error: 'no credentials' };

    const target = { sheetId, tab, token, fetchImpl, signal };
    const header = await ensureHeader({ ...target, header: [...RIDES_HEADER] });
    if (!header.ok) return { ok: false, error: header.error ?? `header check failed (${header.status})` };

    const row = buildRideRow({ now, timeZone: config?.route?.timezone ?? 'UTC', ride });
    const appended = await appendRow(row, target);
    if (!appended.ok) return { ok: false, error: appended.error ?? `append failed (${appended.status})` };
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: `unexpected: ${cause?.message ?? cause}` };
  }
}

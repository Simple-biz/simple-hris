/**
 * The master list's date columns ("Start Date", `off_boarded_at`, the
 * `offboarded_sheet` mirror) are FREE TEXT — they come off the Google Sheet, so
 * one column holds ISO timestamps, US short dates and spelled-out months at the
 * same time. Every comparison against a payroll week key needs them collapsed
 * to a `YYYY-MM-DD` calendar date first, without a timezone shift.
 *
 * Pure, no I/O, client-safe: the same parse has to run in Payroll Readiness
 * (server) and in the Payment Catalog's offboard filter, and the two MUST agree
 * to the day — a start date that parses on one surface and not the other is a
 * person who is aged off one list and kept on the other.
 *
 * Anything that is not one of the three recognised shapes returns null rather
 * than a guess, and every caller treats null as "keep the person" — an
 * unparseable date must never be the reason someone disappears.
 */

/** Format a local date as `YYYY-MM-DD` (no timezone shift). */
function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Normalize a master-list date cell to a `YYYY-MM-DD` calendar date, so it can
 * be compared against a week key and rendered without a timezone shift. Three
 * shapes are handled; anything else returns null rather than a guess.
 */
export function normalizeMasterDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Already a date (or a timestamp) — take the calendar-date prefix verbatim.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Sheet exports write M/D/YYYY. Native Date parsing of that is locale-dependent
  // on Node ("5/4/2026" can read as April 5), so parse the parts explicitly.
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const year = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // Spelled-out forms ("July 20, 2026") parse to LOCAL midnight, so local getters
  // read back the same calendar date that was written.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
}

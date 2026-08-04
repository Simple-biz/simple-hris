/**
 * Snap a rate-change effective date to the START of the pay week that contains it.
 *
 * WHY THIS EXISTS
 * Pay weeks run Sunday→Saturday (and Monday→Sunday for HSL before the 2026-05-31
 * week-model cutover — see hsl-week-model.ts). `resolveRateAsOfDate` picks the newest
 * history row whose `effective_from <= day`, per day. So a raise entered effective on a
 * MONDAY leaves the preceding SUNDAY of the SAME pay week resolving to the OLD rate:
 *
 *   pay week   Sun 07-26 ── Mon 07-27 ── … ── Sat 08-01
 *   raise eff              ^ 2026-07-27 (355)
 *   result     Sun pays 225 (old), Mon–Sat pay 355 (new)   <-- one day stranded
 *
 * The Google Sheet that Accounting pays from instead prices the whole week at the new
 * rate, so the sheet and the engine disagree by (stranded hours × rate delta). A 2026
 * sweep found 64 such stranded changes worth ₱44,125.52 — see
 * scripts/audit-midweek-effective-date-underpay.mts.
 *
 * The stranding is made invisible by the catalog-consistency rule: when the dated
 * history agrees with the Payment Catalog as of the last worked day, the flat catalog
 * override stands DOWN and the week prorates through history, so the correct catalog
 * rate never rescues the stranded day.
 *
 * For HSL the error compounds, because the stranded day is a Sunday and therefore also
 * carries the +₱15/h weekend premium — the premium is applied to the OLD base rate.
 * (The premium itself cancels out of the shortfall arithmetic: paid is
 * hours × (oldReg + 15) and owed is hours × (newReg + 15), so the gap is exactly
 * hours × (newReg − oldReg).)
 *
 * Rate changes are a WEEK-GRAINED concept in this system — pay is computed per pay week
 * and paystubs are issued per pay week — so an effective date that lands mid-week has no
 * coherent meaning. Snapping to the week start is what "the rate for this week is X"
 * actually means.
 */

/** Sun→Sat (every department today) vs Mon→Sun (HSL before the 2026-05-31 cutover). */
export type PayWeekModel = 'sun_sat' | 'mon_sun';

/** Local-midnight copy, so no time component can shift the day. */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The first day of the pay week CONTAINING `date`.
 *
 * Unlike {@link payWeekFromUploadStart} in calendar-column-dedupe.ts — which for
 * `mon_sun` returns the first Monday on or AFTER its argument (correct for anchoring a
 * week off an upload's start date) — this always walks BACKWARD to the week start, which
 * is what snapping an effective date requires.
 *
 *   sun_sat: the Sunday on or before `date`
 *   mon_sun: the Monday on or before `date`
 */
export function payWeekStartContaining(date: Date, model: PayWeekModel = 'sun_sat'): Date {
  const d = localMidnight(date);
  const dow = d.getDay(); // Sun=0 … Sat=6
  const back = model === 'mon_sun' ? (dow === 0 ? 6 : dow - 1) : dow;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** `YYYY-MM-DD` for a local date — never `toISOString()`, which shifts across timezones. */
export function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Snap an intended effective date to its pay-week start, reporting whether it moved.
 *
 * Callers writing to `employee_rate_history` should persist `snapped` and surface
 * `moved` to the user, so "effective Monday" visibly becomes "effective from the Sunday
 * that opens that pay week" rather than silently stranding a day.
 */
export function snapEffectiveFromToPayWeekStart(
  intended: Date,
  model: PayWeekModel = 'sun_sat',
): { snapped: Date; iso: string; moved: boolean; daysMoved: number } {
  const start = payWeekStartContaining(intended, model);
  const a = localMidnight(intended).getTime();
  const b = start.getTime();
  const daysMoved = Math.round((a - b) / 86_400_000);
  return { snapped: start, iso: toLocalIsoDate(start), moved: daysMoved !== 0, daysMoved };
}

/**
 * String convenience for the API routes, which carry `effective_from` as `YYYY-MM-DD`.
 * A malformed value is returned unchanged — snapping must never be the reason a rate
 * write fails; the caller's own validation owns that.
 */
export function snapEffectiveFromIso(
  iso: string | null | undefined,
  model: PayWeekModel = 'sun_sat',
): { iso: string | null; moved: boolean; daysMoved: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
  if (!m) return { iso: iso ?? null, moved: false, daysMoved: 0 };
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return { iso: iso ?? null, moved: false, daysMoved: 0 };
  const r = snapEffectiveFromToPayWeekStart(d, model);
  return { iso: r.iso, moved: r.moved, daysMoved: r.daysMoved };
}

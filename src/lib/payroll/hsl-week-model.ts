/**
 * HSL week-model cutover resolver.
 *
 * Management is moving HSL's work/PAB week from Mon→Sun ("Sunday-to-Sunday") to
 * Sun→Sat ("Sunday-to-Saturday"), effective a specific cutover date (the start
 * of the new pay period — week of 2026-07-05). This is an EFFECTIVE-DATE cutover,
 * NOT a global flip: periods before the cutover keep computing Mon→Sun so all
 * historical pay/PAB/calendars stay byte-identical to what was already produced
 * (and consistent with frozen disbursement_records + final_pay snapshots); periods
 * on/after the cutover compute Sun→Sat.
 *
 * The cutover date lives in app_settings under {@link HSL_WEEK_MODEL_CUTOVER_KEY}.
 * When UNSET, every period resolves to 'mon_sun' → the change is a complete no-op.
 *
 * IMPORTANT guardrails for callers:
 *  - PAB-MONTH ownership stays MONDAY-based for ALL departments (do NOT switch
 *    HSL to getPabMonthRangeSunSat). A Sun→Sat HSL week is owned by the month of
 *    the Monday inside it (its Sunday + 1 day). This prevents a boundary week
 *    jumping payroll cycles.
 *  - HSL's PAB SCORING rule is preserved (≥5 of 7 days incl. weekend + overnight
 *    credit). Only the week ANCHOR moves (Monday-start → Sunday-start) and the
 *    period-end snap moves (closing Sunday → closing Saturday).
 *  - Resolve the model from a STABLE anchor (the Hubstaff upload/file start date
 *    or PAB month) — never from a value that itself depends on the week shape.
 */

export const HSL_WEEK_MODEL_CUTOVER_KEY = 'hsl.week_model_cutover';

/** Mon→Sun (legacy / pre-cutover) vs Sun→Sat (post-cutover). */
export type HslWeekModel = 'mon_sun' | 'sun_sat';

/** Parse a YYYY-MM-DD string as a local calendar date at midnight. */
function parseLocalIso(value: string | null | undefined): Date | null {
  if (!value || typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toLocalMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Resolve which week model applies to a period, given its stable anchor date
 * (the upload/file start, or any date inside the PAB month) and the configured
 * cutover date (app_settings `hsl.week_model_cutover`, a YYYY-MM-DD string).
 *
 *  - No cutover configured            → 'mon_sun' (no change anywhere).
 *  - anchor on/after the cutover date → 'sun_sat'.
 *  - anchor before the cutover date   → 'mon_sun'.
 *
 * Comparison is day-granular and local (no UTC shift), so a cutover of
 * "2026-07-05" treats any period anchored on 2026-07-05 or later as Sun→Sat.
 */
export function resolveHslWeekModel(
  anchor: Date | string | null | undefined,
  cutoverIso: string | null | undefined,
): HslWeekModel {
  const cut = parseLocalIso(cutoverIso);
  if (!cut) return 'mon_sun';
  const a =
    typeof anchor === 'string'
      ? parseLocalIso(anchor)
      : anchor instanceof Date && !Number.isNaN(anchor.getTime())
        ? toLocalMidnight(anchor)
        : null;
  if (!a) return 'mon_sun';
  return a.getTime() >= cut.getTime() ? 'sun_sat' : 'mon_sun';
}

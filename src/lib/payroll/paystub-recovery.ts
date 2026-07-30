/**
 * Server-side recovery of a past pay week's EXACT discretionary figures, for the
 * Employee "Pay Stubs" tab. Pre-HRIS-launch, most weeks were never formally locked
 * into `paystub_dispatch_queue`, so the tab used to reconstruct them from raw hours
 * and zero out everything the wizard adds on top (adjustments, performance/KPI
 * bonuses, MESA reimbursement) — an "estimate".
 *
 * But the wizard already persists the exact numbers per week in `app_settings`:
 *
 *  - `payroll.wizard.final_pay.<sourceFile>` — auto-published on a 1.5s debounce
 *    every time the wizard is open on the LIVE cycle (and on lock / dispatch). It
 *    carries each employee's EXACT `final`, `initial`, regular/OT pay + hours, and
 *    the MESA deduction + disbursement. This is the same snapshot the Employee
 *    Dashboard trusts for its "Estimated Take-Home", so it is authoritative for the
 *    total that was actually paid out via Payment Dispatch.
 *  - `payroll.wizard.additions.<sourceFile>` — written when a clerk clicks "Lock in
 *    additions". Carries the real accounting Adjustment (`bonusOverrides`, PHP
 *    signed delta), its note (`bonusOverrideNotes`), and Orphanage pay
 *    (`orphanageAmounts`), keyed by the employee's Hubstaff email.
 *
 * Combining the exact total (final_pay) with the deterministic PAB/Tech/MESA-
 * deduction split (`computeCurrentPay`) and the real Adjustment (additions blob)
 * lets the paystub reconcile EXACTLY to what the wizard computed — no estimate.
 *
 * Keep the field shapes here in lockstep with `PayrollFinalEntry` in
 * `EmployeeDashboard.tsx` and the additions payload in `PayrollWizard.tsx`
 * (`publishFinalPaySnapshot` / `saveAdditionsProgress`).
 */
import { getAppSetting, getAppSettings } from "@/lib/supabase/app-settings";
import type { ProrationBlockRaw } from "@/lib/payroll/paystub-view";

/** One employee's exact figures from `payroll.wizard.final_pay.<sourceFile>`. */
export interface WizardFinalPayEntry {
  /** The exact net pay the wizard computed = what Payment Dispatch paid out. */
  final: number;
  regularPay: number | null;
  otPay: number | null;
  regularHours: number;
  otHours: number;
  totalHours: number;
  /** Regular + OT, before bonuses/deductions. */
  initial: number | null;
  /** ₱100 MESA contribution withheld (older snapshots omit it → undefined). */
  mesaDeduction?: number | null;
  /** MESA emergency disbursement folded into `final` this run (older snapshots
   *  omit it → undefined). This is the field a pure hours-based estimate cannot
   *  recover; the snapshot preserves it. */
  mesaDisbursement?: number | null;
  /** Exact dispatched bonus breakdown (added 2026-07-18). Snapshots written before
   *  this omit them → undefined, and the recovery falls back to distributing the
   *  exact `final` across the engine-derived split. When present, the paystub
   *  itemizes EXACTLY what was dispatched. */
  perfectAttendanceBonus?: number | null;
  techBonus?: number | null;
  otherBonuses?: number | null;
  adjustment?: number | null;
  orphanagePay?: number | null;
  /** Hourly rates + Adj. note (added 2026-07-21) so the mark-paid path can rebuild
   *  the FULL paystub payload from this snapshot (see paystub-fresh.ts). Older
   *  snapshots omit them → undefined, and the stale staged values are kept. */
  regularRate?: number | null;
  otRate?: number | null;
  adjustmentNote?: string | null;
  /** HSL weekend (Sat+Sun) carve-out of regularPay/otPay (added 2026-07-30) so a
   *  merge/recovery can rebuild the stub's Weekend earnings lines. All-null =
   *  the row has no weekend block (non-HSL); hours are numbers whenever it does.
   *  Older snapshots omit the fields → undefined, and the merge keeps whatever
   *  weekend block the staged payload already carries. */
  weekendRegularHours?: number | null;
  weekendOtHours?: number | null;
  weekendRegularPay?: number | null;
  weekendOtPay?: number | null;
  /** Mid-week rate-change proration block (added 2026-07-30), payload-shaped —
   *  the per-rate segments the statement's "Prorated" chip + basis line render
   *  from. Travels with the figures it explains: null = the row has no
   *  mid-period change; undefined (older snapshots) = the merge keeps whatever
   *  block the staged payload already carries. */
  proration?: ProrationBlockRaw | null;
}

/** The discretionary overlay recovered for one employee + week. */
export interface WeekDiscretionary {
  /** Exact wizard snapshot for this employee, if one was published for this week. */
  finalPay: WizardFinalPayEntry | null;
  /** USD→PHP rate captured in the snapshot for this week (null on older snapshots
   *  that predate storing it → caller falls back to the current rate). */
  fxRate: number | null;
  /** Signed PHP accounting adjustment (the "Adj." column), 0 when none/unknown. */
  adjustment: number;
  /** The adjustment's note, null when the adjustment is 0 or no note was saved. */
  adjustmentNote: string | null;
  /** Orphanage pay folded into the total (not itemized on the stub), 0 when none. */
  orphanage: number;
  /** True when EITHER a final_pay snapshot or an additions blob exists for this
   *  week — i.e. the week was actually processed in the wizard, so the recovered
   *  figures are authoritative (what was paid), not a bare hours estimate. */
  hasWizardData: boolean;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** Match a map keyed by any of the employee's emails (case-insensitive). The
 *  additions blob is keyed by the raw Hubstaff email, which may be the work OR
 *  personal address in any case, so try every known alias. */
function pickByEmail<T>(map: Record<string, T>, emailsLower: string[]): T | undefined {
  for (const e of emailsLower) {
    if (Object.prototype.hasOwnProperty.call(map, e)) return map[e];
  }
  // Case-insensitive fallback (keys stored with original casing).
  const lc = new Map<string, T>();
  for (const [k, v] of Object.entries(map)) lc.set(k.trim().toLowerCase(), v);
  for (const e of emailsLower) {
    const v = lc.get(e);
    if (v !== undefined) return v;
  }
  return undefined;
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Parse a `payroll.wizard.final_pay.<file>` JSON value into this employee's exact
 *  figures + the week's FX rate. Best-effort — malformed/absent → nulls. */
function parseFinalPaySnapshot(
  raw: string | null,
  emailsLower: string[],
): { finalPay: WizardFinalPayEntry | null; fxRate: number | null } {
  if (!raw) return { finalPay: null, fxRate: null };
  try {
    const parsed = JSON.parse(raw) as {
      finals?: Record<string, WizardFinalPayEntry>;
      fx_rate?: number;
    };
    const entry = pickByEmail(parsed.finals ?? {}, emailsLower);
    const finalPay =
      entry && typeof entry.final === "number" && Number.isFinite(entry.final) ? entry : null;
    const fxRate =
      typeof parsed.fx_rate === "number" && parsed.fx_rate > 0 ? parsed.fx_rate : null;
    return { finalPay, fxRate };
  } catch {
    return { finalPay: null, fxRate: null };
  }
}

/**
 * BATCH loader for the summary list: one `app_settings` round-trip for every
 * week's `final_pay` snapshot, returning each employee's exact figures + fx. This
 * is what lets the Pay Stubs list render totals for every snapshot week WITHOUT a
 * per-week `computeCurrentPay` (the old slow path). Weeks with no snapshot map to
 * `{ finalPay: null, fxRate: null }` (the caller computes those lazily).
 */
export async function loadFinalPayForWeeks(
  sourceFiles: string[],
  emails: string[],
): Promise<Map<string, { finalPay: WizardFinalPayEntry | null; fxRate: number | null }>> {
  const emailsLower = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, { finalPay: WizardFinalPayEntry | null; fxRate: number | null }>();
  const files = [...new Set(sourceFiles.filter(Boolean))];
  if (files.length === 0) return out;
  const keys = files.map((f) => `payroll.wizard.final_pay.${f}`);
  let values: Record<string, string | null> = {};
  try {
    values = await getAppSettings(keys);
  } catch {
    for (const f of files) out.set(f, { finalPay: null, fxRate: null });
    return out;
  }
  for (const f of files) {
    out.set(f, parseFinalPaySnapshot(values[`payroll.wizard.final_pay.${f}`] ?? null, emailsLower));
  }
  return out;
}

/**
 * Load the exact discretionary overlay for one employee + CSV-upload week from the
 * wizard's persisted `app_settings` blobs. Best-effort: a missing/omitted blob or
 * a parse failure degrades gracefully (finalPay=null, adjustment/orphanage=0).
 *
 * @param sourceFile the Hubstaff CSV filename (the per-week key)
 * @param emails     the caller's own emails (work + personal + session), any case
 */
export async function loadWeekDiscretionary(
  sourceFile: string,
  emails: string[],
): Promise<WeekDiscretionary> {
  const emailsLower = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

  const [finalRaw, additionsRaw] = await Promise.all([
    getAppSetting(`payroll.wizard.final_pay.${sourceFile}`),
    getAppSetting(`payroll.wizard.additions.${sourceFile}`),
  ]);

  // ── Exact per-employee figures (final_pay snapshot) ──────────────────────────
  const { finalPay, fxRate } = parseFinalPaySnapshot(finalRaw, emailsLower);

  // ── Real accounting Adjustment + note + Orphanage (additions blob) ───────────
  let adjustment = 0;
  let adjustmentNote: string | null = null;
  let orphanage = 0;
  let additionsPresent = false;
  if (additionsRaw) {
    try {
      const parsed = JSON.parse(additionsRaw) as {
        bonusOverrides?: Record<string, unknown>;
        bonusOverrideNotes?: Record<string, unknown>;
        orphanageAmounts?: Record<string, unknown>;
      };
      additionsPresent = true;
      adjustment = round2(toNumber(pickByEmail(parsed.bonusOverrides ?? {}, emailsLower)));
      const note = pickByEmail(parsed.bonusOverrideNotes ?? {}, emailsLower);
      adjustmentNote = typeof note === "string" && note.trim() ? note.trim() : null;
      orphanage = round2(toNumber(pickByEmail(parsed.orphanageAmounts ?? {}, emailsLower)));
    } catch {
      /* malformed blob — treat as absent */
    }
  }

  return {
    finalPay,
    fxRate,
    adjustment,
    // Only surface a note when there's actually an adjustment to annotate.
    adjustmentNote: adjustment !== 0 ? adjustmentNote : null,
    orphanage,
    hasWizardData: finalPay != null || additionsPresent,
  };
}

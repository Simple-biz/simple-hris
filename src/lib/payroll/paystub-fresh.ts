/**
 * Freshest-truth resolver for a staged paystub.
 *
 * The Payroll Wizard stages each employee's paystub payload into
 * `paystub_dispatch_queue` ONCE, at "Lock in Values & Send to Payment Dispatch" —
 * but the wizard keeps recomputing after that (additions edited in another
 * session, a rate change, a KPI submission), and it publishes those live figures
 * to `payroll.wizard.final_pay.<sourceFile>` on a debounce. Payment Dispatch
 * already PAYS from that snapshot (the `useDispatchQueue` overlay), so a stub
 * built from the stale staged payload can contradict the money actually sent
 * (2026-07-21: two employees were emailed stubs understating their pay).
 *
 * `getFreshPaystubEntry` closes that gap: it returns the staged payload with the
 * snapshot's per-employee figures merged OVER it whenever the snapshot is newer
 * than the lock. The merged payload keeps the exact `DispatchEmployee` shape the
 * n8n `pay_vars` node and `mapPayloadToPayStub` read, so every consumer —
 * Payment Dispatch's stub viewer, the emailed statement, the employee Pay Stubs
 * tab (after the mark-paid path persists the merge back) — shows the SAME
 * numbers the wizard shows and Payment Dispatch pays.
 */
import type { PaystubQueueEntry } from "@/lib/supabase/paystub-dispatch-queue";
import { getPaystubDispatchEntry } from "@/lib/supabase/paystub-dispatch-queue";
import { getAppSettingWithMeta } from "@/lib/supabase/app-settings";
import type { WizardFinalPayEntry } from "@/lib/payroll/paystub-recovery";

export interface FreshPaystubEntry {
  /** The raw staged queue row (null when this (cycle, employee) was never staged). */
  staged: PaystubQueueEntry | null;
  /** The freshest renderable payload — staged, with newer wizard-snapshot figures
   *  merged over it when available. Null when nothing renderable is staged. */
  payload: Record<string, unknown> | null;
  /** The queue row's cycle-level pay_period, with the snapshot fx merged in. */
  payPeriod: Record<string, unknown> | null;
  /** True when the snapshot changed at least one figure vs. the staged payload —
   *  the caller should persist the merged payload back to the queue row. */
  refreshed: boolean;
  error: string | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Money-equality with a sub-centavo tolerance; nulls only equal nulls. */
function sameAmount(a: unknown, b: unknown): boolean {
  const x = numOrNull(a);
  const y = numOrNull(b);
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) < 0.005;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Snapshot finals are keyed by lowercased work AND personal email — but we match
 * on the WORK email only (the queue's `recipient_email` and the payload's own
 * `email`). A personal-email fallback is deliberately NOT attempted: personal
 * addresses are shared/recycled across people in the master list, so a row with
 * no work-email hit (e.g. someone dropped from the run) could otherwise merge a
 * DIFFERENT employee's figures.
 */
function pickSnapshotEntry(
  finals: Record<string, WizardFinalPayEntry>,
  staged: { recipient_email: string; payload: Record<string, unknown> | null },
): WizardFinalPayEntry | null {
  const p = obj(staged.payload);
  const candidates = [staged.recipient_email, typeof p.email === "string" ? p.email : null]
    .filter((e): e is string => Boolean(e))
    .map((e) => e.trim().toLowerCase());
  for (const e of candidates) {
    const entry = finals[e];
    if (entry && typeof entry.final === "number" && Number.isFinite(entry.final)) return entry;
  }
  return null;
}

/** The subset of a staged queue row the merge needs — satisfied by a full
 *  `PaystubQueueEntry` and by the lightweight batch selects in the employee
 *  Pay Stubs list/export paths. */
export interface StagedPaystubLike {
  recipient_email: string;
  payload: Record<string, unknown> | null;
  pay_period: Record<string, unknown> | null;
  locked_at: string | null;
  excluded: boolean;
}

/**
 * PURE merge core: staged payload ⊕ one week's wizard snapshot (raw
 * `app_settings` value + its `updated_at`) → the freshest paystub payload.
 *
 * The snapshot wins only when ALL of these hold (else the staged payload is
 * returned untouched, `refreshed: false`):
 *  - the row is NOT `excluded` — "do not pay" rows are settled from their
 *    STAGED amounts (arrears ledger), and the wizard's snapshot never speaks
 *    for them, so their stub must stay exactly what was staged;
 *  - the snapshot parses and has a WORK-email entry for this employee;
 *  - it was written AFTER the queue row was locked (`updated_at > locked_at`),
 *    so a snapshot predating a re-lock can never regress it;
 *  - it carries the itemized bonus breakdown (snapshots since 2026-07-18) —
 *    an old total-only snapshot can't rebuild a full statement.
 */
export function mergeSnapshotIntoStaged(
  staged: StagedPaystubLike,
  snapValue: string | null,
  snapUpdatedAt: string | null,
): { payload: Record<string, unknown> | null; payPeriod: Record<string, unknown> | null; refreshed: boolean } {
  const base = { payload: staged.payload, payPeriod: staged.pay_period, refreshed: false };
  if (!staged.payload || staged.excluded || !snapValue) return base;

  // Newer-than-lock guard: both are timestamptz ISO strings.
  const snapAt = snapUpdatedAt ? Date.parse(snapUpdatedAt) : NaN;
  const lockedAt = staged.locked_at ? Date.parse(staged.locked_at) : NaN;
  if (!Number.isFinite(snapAt) || (Number.isFinite(lockedAt) && snapAt <= lockedAt)) return base;

  let finals: Record<string, WizardFinalPayEntry> = {};
  let snapFx = 0;
  try {
    const parsed = JSON.parse(snapValue) as {
      finals?: Record<string, WizardFinalPayEntry>;
      fx_rate?: number;
    };
    finals = parsed.finals ?? {};
    snapFx = typeof parsed.fx_rate === "number" && parsed.fx_rate > 0 ? parsed.fx_rate : 0;
  } catch {
    return base;
  }

  const entry = pickSnapshotEntry(finals, staged);
  if (!entry) return base;
  // Itemization required — a total-only (pre-2026-07-18) snapshot can't rebuild
  // the statement's line items, and mixing its total with stale lines would
  // produce a stub that doesn't reconcile.
  if (
    entry.perfectAttendanceBonus === undefined ||
    entry.techBonus === undefined ||
    entry.otherBonuses === undefined
  ) {
    return base;
  }

  const p = obj(staged.payload);
  const oldPay = obj(p.pay_php);
  const oldHours = obj(p.hours);
  const oldRates = obj(p.rates_php);
  const oldPeriod = obj(p.pay_period ?? staged.pay_period);

  const pab = num(entry.perfectAttendanceBonus);
  const tech = num(entry.techBonus);
  const other = num(entry.otherBonuses);
  const adjustment = num(entry.adjustment);
  const nextPay = {
    regular: entry.regularPay ?? null,
    ot: entry.otPay ?? null,
    initial: entry.initial ?? null,
    bonuses_total: round2(pab + tech + other + adjustment),
    perfect_attendance_bonus: pab,
    tech_bonus: tech,
    other_bonuses: other,
    adjustment,
    mesa_deduction: num(entry.mesaDeduction),
    mesa_disbursement: num(entry.mesaDisbursement),
    orphanage_pay: num(entry.orphanagePay),
    final: entry.final,
  };
  const nextHours = {
    total: num(entry.totalHours),
    regular: num(entry.regularHours),
    ot: num(entry.otHours),
  };
  // Rates joined the snapshot 2026-07-21 — older snapshots keep the staged rates.
  const nextRates = {
    regular: entry.regularRate !== undefined ? entry.regularRate : (numOrNull(oldRates.regular)),
    ot: entry.otRate !== undefined ? entry.otRate : (numOrNull(oldRates.ot)),
  };
  const nextNote =
    entry.adjustmentNote !== undefined
      ? entry.adjustmentNote
      : typeof p.adjustment_note === "string"
        ? p.adjustment_note
        : null;

  // Field-by-field change detection (NOT JSON.stringify — jsonb round-trips
  // reorder keys, which would flag every merge as a change).
  const changed =
    (Object.keys(nextPay) as Array<keyof typeof nextPay>).some((k) => !sameAmount(oldPay[k], nextPay[k])) ||
    (Object.keys(nextHours) as Array<keyof typeof nextHours>).some((k) => !sameAmount(oldHours[k], nextHours[k])) ||
    (Object.keys(nextRates) as Array<keyof typeof nextRates>).some((k) => !sameAmount(oldRates[k], nextRates[k])) ||
    (nextNote ?? null) !== ((typeof p.adjustment_note === "string" ? p.adjustment_note : null) ?? null);
  if (!changed) return base;

  const merged = {
    ...p,
    hours: nextHours,
    rates_php: nextRates,
    pay_php: nextPay,
    adjustment_note: nextNote,
    pay_period: { ...oldPeriod, ...(snapFx > 0 ? { fx_rate: snapFx } : {}) },
  };
  const payPeriod = { ...obj(staged.pay_period), ...(snapFx > 0 ? { fx_rate: snapFx } : {}) };
  return { payload: merged, payPeriod, refreshed: true };
}

/** The snapshot `app_settings` key for one pay-week source file. */
export function finalPaySnapshotKey(sourceFile: string): string {
  return `payroll.wizard.final_pay.${sourceFile}`;
}

/**
 * Fetching wrapper around {@link mergeSnapshotIntoStaged} for one
 * (cycle, employee): reads the staged queue row + that week's snapshot and
 * returns the freshest renderable payload.
 */
export async function getFreshPaystubEntry(
  sourceFile: string,
  recipientEmail: string,
): Promise<FreshPaystubEntry> {
  const { row: staged, error } = await getPaystubDispatchEntry(sourceFile, recipientEmail);
  if (error || !staged?.payload) {
    return { staged: staged ?? null, payload: null, payPeriod: staged?.pay_period ?? null, refreshed: false, error };
  }

  let snap: { value: string; updatedAt: string | null } | null = null;
  try {
    snap = await getAppSettingWithMeta(finalPaySnapshotKey(sourceFile));
  } catch {
    snap = null; // snapshot unavailable — the staged payload still renders
  }

  const merged = mergeSnapshotIntoStaged(staged, snap?.value ?? null, snap?.updatedAt ?? null);
  return { staged, ...merged, error: null };
}

/**
 * ONE rule for "what did the Payroll Wizard actually decide for this payee".
 *
 * Three carriers of the wizard's figures exist for a single cycle, and they can
 * all disagree:
 *
 *   A. `paystub_dispatch_queue.amount_php` + `payload.pay_php` — written ONCE, at
 *      "Lock in Values & Send to Payment Dispatch". Durable, per-row, itemized.
 *   B. `app_settings` `payroll.wizard.final_pay.<sourceFile>` — republished on a
 *      1.5s debounce for as long as a wizard tab sits on the live week, so it can
 *      be newer than the lock (a late Adj., a post-lock rate fix) or older than it
 *      (a re-lock whose publish was held by one of the wizard's own gates).
 *   C. `computeCurrentPay()` — a server recomputation that knows nothing about the
 *      accounting layer (Adj., Orphanage, KPI/dept bonuses, MESA). It is the
 *      REASON the snapshot overlay exists at all
 *      (docs/features/payroll-wizard-final-pay.md §5).
 *
 * `paystub-fresh.ts` already owned the precedence between A and B for the emailed
 * statement. Payment Dispatch's queue implemented a *different*, looser rule — it
 * applied B with no recency check, no itemization check, on held rows, and keyed
 * on either email — and fell back to C rather than to A. So the money a clerk sent
 * and the statement that person received could be priced from different carriers,
 * and a locked value could be silently replaced by a wizard-blind recompute.
 *
 * This module is that precedence, extracted once, pure and client-safe (zero
 * imports), so the queue and the paystub engine cannot drift again:
 *
 *   snapshot (only when it QUALIFIES) → locked stage → nothing (caller keeps C)
 *
 * A snapshot qualifies exactly as `mergeSnapshotIntoStaged` requires:
 *   - the staged row is not `excluded` — held rows settle from their STAGED
 *     amounts (the arrears ledger), and the snapshot never speaks for them;
 *   - it was written AFTER the lock (`updated_at > locked_at`), so a snapshot
 *     predating a re-lock can never regress it;
 *   - it is itemized (snapshots since 2026-07-18);
 *   - its own hourly rate does not contradict the Payment Catalog;
 *   - it was matched on the WORK email (the caller's job — see
 *     {@link pickWizardSnapshotEntry}).
 */

/** One employee's figures inside `payroll.wizard.final_pay.<sourceFile>`.
 *
 *  The canonical, fully-documented shape is `WizardFinalPayEntry` in
 *  `paystub-recovery.ts`, which EXTENDS this — so the two are kept in lockstep by
 *  the compiler. Only the fields the precedence rules read are declared here. */
export interface WizardSnapshotEntry {
  /** Lowercased work email — the canonical identity of the person this entry is
   *  for. The finals map keys the SAME entry under work AND personal email. */
  workEmail?: string | null;
  final: number;
  regularPay?: number | null;
  otPay?: number | null;
  regularHours?: number;
  otHours?: number;
  totalHours?: number;
  initial?: number | null;
  mesaDeduction?: number | null;
  mesaDisbursement?: number | null;
  perfectAttendanceBonus?: number | null;
  techBonus?: number | null;
  otherBonuses?: number | null;
  adjustment?: number | null;
  orphanagePay?: number | null;
  regularRate?: number | null;
  otRate?: number | null;
  /** Presence-only here: an HSL sheet-form row stores a DERIVED OT differential
   *  in `otRate`, which legitimately never matches the catalog's OT column. */
  hoganSheet?: object | null;
}

/** An employee-scope Payment Catalog rate (PHP) — the rate a snapshot must agree
 *  with to be trusted. Structurally the `CatalogRateClaim` of paystub-fresh. */
export interface CatalogRateClaimLike {
  regular: number;
  ot: number | null;
}

/** `payload.pay_php`, exactly as the wizard staged it. Every field optional: a
 *  jsonb round-trip is untyped, and rows staged before a field existed omit it. */
export interface StagedPayPhp {
  regular?: number | null;
  ot?: number | null;
  initial?: number | null;
  bonuses_total?: number | null;
  perfect_attendance_bonus?: number | null;
  tech_bonus?: number | null;
  other_bonuses?: number | null;
  adjustment?: number | null;
  orphanage_pay?: number | null;
  mesa_deduction?: number | null;
  mesa_disbursement?: number | null;
  final?: number | null;
}

/** `payload.hours`, exactly as the wizard staged it. */
export interface StagedHours {
  total?: number | null;
  regular?: number | null;
  ot?: number | null;
}

/** The locked stage for one (cycle, payee) — carrier A. */
export interface StagedLockedRow {
  /** The locked total. NULL is possible on a step-7 held row staged with no
   *  payload; such a row carries no usable locked figure. */
  amountPHP: number | null;
  amountUSD: number | null;
  lockedAt: string | null;
  /** Wizard "do not pay". A held row's amounts are settled from the stage. */
  excluded: boolean;
  payPhp?: StagedPayPhp | null;
  hours?: StagedHours | null;
}

/** Which carrier priced the row. `'recomputed'` is never produced here — it is
 *  what the caller keeps when this module returns null. */
export type WizardValueSource = 'snapshot' | 'lock';

/** The wizard's itemized figures for one payee. Absent (`null` breakdown) when
 *  the winning carrier has no itemization — never substituted from elsewhere. */
export interface WizardBreakdown {
  /** Regular + OT before bonuses/deductions. */
  initialPayPHP: number | null;
  /** PAB + Tech + other/dept/KPI + the signed Adj. delta — everything in the
   *  total beyond Initial, orphanage and MESA. Legitimately NEGATIVE when the
   *  Adj. delta outweighs the bonuses (docs/features/payroll-wizard-final-pay.md §2). */
  bonusTotalPHP: number;
  pabBonusPHP: number;
  techBonusPHP: number;
  orphanagePayPHP: number;
  mesaDeductionPHP: number;
  mesaDisbursementPHP: number;
  totalHours: number | null;
  otHours: number | null;
}

export interface WizardRowValues {
  source: WizardValueSource;
  /** The amount the clerk must send, in PHP. */
  amountPHP: number;
  /** The locked USD twin when the LOCK won and carried one; null otherwise (the
   *  caller re-derives from the cycle FX). */
  amountUSD: number | null;
  breakdown: WizardBreakdown | null;
  /** The locked total, whenever a staged row carried one — so a caller can show
   *  what the lock said even when the snapshot legitimately won. */
  lockedAmountPHP: number | null;
  /** The snapshot won AND its total differs from the locked one: the wizard
   *  re-priced this person after the values were locked. Not an error — a
   *  post-lock Adj./rate fix is exactly why the snapshot outranks the stage —
   *  but never silent (docs/features/paystub-dispatch.md: mark-paid reconciles
   *  and flags rather than choosing quietly). */
  repricedAfterLock: boolean;
  /** A snapshot entry existed but was REJECTED because its hourly rate
   *  contradicts the Payment Catalog (stale wizard session). The lock was used
   *  instead. Mirrors `FreshPaystubEntry.staleRateSnapshot`. */
  staleRateSnapshot: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Snapshot-vs-lock recency. `true` only when the snapshot provably post-dates the
 * lock; an unparseable snapshot timestamp is never newer, and an unparseable or
 * absent lock timestamp cannot hold a snapshot back (there is nothing to regress).
 */
export function snapshotIsNewerThanLock(
  snapUpdatedAt: string | null | undefined,
  lockedAt: string | null | undefined,
): boolean {
  const snapAt = snapUpdatedAt ? Date.parse(snapUpdatedAt) : NaN;
  const locked = lockedAt ? Date.parse(lockedAt) : NaN;
  if (!Number.isFinite(snapAt)) return false;
  return !Number.isFinite(locked) || snapAt > locked;
}

/**
 * Itemized = carries the bonus split (snapshots since 2026-07-18). A total-only
 * snapshot cannot rebuild a breakdown, and pairing its total with someone else's
 * line items produces figures that don't reconcile.
 */
export function snapshotEntryIsItemized(entry: WizardSnapshotEntry): boolean {
  return (
    entry.perfectAttendanceBonus !== undefined &&
    entry.techBonus !== undefined &&
    entry.otherBonuses !== undefined
  );
}

/**
 * The Payment Catalog is the rate source of truth, so a snapshot computed at any
 * other rate is provably from a wizard session holding pre-change data — stale
 * however new its `updated_at` is (2026-07-29: a stale tab republished
 * ₱175-computed figures 18 minutes after the ₱225 catalog fix).
 *
 * Fail-open by construction: no claim, or a snapshot with no rate fields, cannot
 * contradict anything.
 */
export function snapshotRateContradictsCatalog(
  entry: WizardSnapshotEntry,
  claim: CatalogRateClaimLike | null | undefined,
): boolean {
  if (!claim) return false;
  const snapReg = numOrNull(entry.regularRate);
  const snapOt = numOrNull(entry.otRate);
  const regStale = snapReg != null && Math.abs(snapReg - claim.regular) > 0.005;
  // An HSL sheet-form row's `otRate` is the DERIVED 0.5× differential, which
  // never matches the catalog's standalone OT column and doesn't need to — the
  // differential comes off the regular rate, so the check above already covers it.
  const otStale =
    entry.hoganSheet == null &&
    snapOt != null &&
    claim.ot != null &&
    Math.abs(snapOt - claim.ot) > 0.005;
  return regStale || otStale;
}

/**
 * Pick one payee's snapshot entry, matching on the WORK email ONLY.
 *
 * The finals map is keyed by work AND personal email, but personal addresses are
 * shared and recycled across master rows — a personal-email fallback could merge
 * a DIFFERENT employee's figures onto this row. Same rule as
 * `pickSnapshotEntry` in paystub-fresh.ts.
 */
export function pickWizardSnapshotEntry(
  finals: Record<string, WizardSnapshotEntry> | null | undefined,
  workEmail: string | null | undefined,
): WizardSnapshotEntry | null {
  if (!finals || !workEmail) return null;
  const key = workEmail.trim().toLowerCase();
  if (!key) return null;
  const entry = finals[key];
  if (!entry || typeof entry.final !== 'number' || !Number.isFinite(entry.final)) return null;
  // A snapshot that names its own canonical identity must agree with the key we
  // looked it up under; a mismatch means we reached it through an alias that
  // belongs to somebody else.
  if (entry.workEmail != null) {
    const canonical = entry.workEmail.trim().toLowerCase();
    if (canonical && canonical !== key) return null;
  }
  return entry;
}

function breakdownFromSnapshot(entry: WizardSnapshotEntry): WizardBreakdown {
  const pab = num(entry.perfectAttendanceBonus);
  const tech = num(entry.techBonus);
  const other = num(entry.otherBonuses);
  const adjustment = num(entry.adjustment);
  return {
    initialPayPHP: numOrNull(entry.initial),
    // Same composition `mergeSnapshotIntoStaged` writes into the paystub payload,
    // so the queue's chip and the statement's lines can never disagree.
    bonusTotalPHP: round2(pab + tech + other + adjustment),
    pabBonusPHP: pab,
    techBonusPHP: tech,
    orphanagePayPHP: num(entry.orphanagePay),
    mesaDeductionPHP: num(entry.mesaDeduction),
    mesaDisbursementPHP: num(entry.mesaDisbursement),
    totalHours: numOrNull(entry.totalHours),
    otHours: numOrNull(entry.otHours),
  };
}

function breakdownFromStage(staged: StagedLockedRow): WizardBreakdown | null {
  const p = staged.payPhp;
  if (!p) return null;
  // `bonuses_total` is staged pre-composed (pab + tech + other + adjustment); it
  // is read rather than recomputed so the row shows exactly what was locked.
  const total = numOrNull(p.bonuses_total);
  if (total === null) return null;
  return {
    initialPayPHP: numOrNull(p.initial),
    bonusTotalPHP: total,
    pabBonusPHP: num(p.perfect_attendance_bonus),
    techBonusPHP: num(p.tech_bonus),
    orphanagePayPHP: num(p.orphanage_pay),
    mesaDeductionPHP: num(p.mesa_deduction),
    mesaDisbursementPHP: num(p.mesa_disbursement),
    totalHours: numOrNull(staged.hours?.total),
    otHours: numOrNull(staged.hours?.ot),
  };
}

/**
 * Resolve the figures Payment Dispatch must show and pay for one payee.
 *
 * Returns `null` when NEITHER carrier can speak for this person — no qualifying
 * snapshot entry and no locked total. The caller then keeps whatever
 * `computeCurrentPay` produced: an absent saved value falls back to live
 * computation and never to ₱0 (docs/features/payroll-wizard-week-replay.md, rule 3).
 */
export function resolveWizardRowValues(params: {
  /** The payee's WORK email. Snapshot matching is work-email-only. */
  workEmail: string | null | undefined;
  finals: Record<string, WizardSnapshotEntry> | null | undefined;
  snapshotUpdatedAt: string | null | undefined;
  /** Null when the wizard never staged this person (they reach the queue from
   *  `employee_hourly_rates` alone). */
  staged: StagedLockedRow | null | undefined;
  catalogClaim?: CatalogRateClaimLike | null;
}): WizardRowValues | null {
  const { workEmail, finals, snapshotUpdatedAt, staged, catalogClaim } = params;
  const lockedAmountPHP = numOrNull(staged?.amountPHP);

  const entry = pickWizardSnapshotEntry(finals, workEmail);
  let staleRateSnapshot = false;
  if (entry) {
    // Held rows settle from the stage; the snapshot never speaks for them.
    const heldByWizard = staged?.excluded === true;
    const newerThanLock = snapshotIsNewerThanLock(snapshotUpdatedAt, staged?.lockedAt ?? null);
    const itemized = snapshotEntryIsItemized(entry);
    const rateStale = snapshotRateContradictsCatalog(entry, catalogClaim);
    staleRateSnapshot = rateStale;
    if (!heldByWizard && newerThanLock && itemized && !rateStale) {
      const total = round2(entry.final);
      return {
        source: 'snapshot',
        amountPHP: total,
        amountUSD: null,
        breakdown: breakdownFromSnapshot(entry),
        lockedAmountPHP,
        repricedAfterLock: lockedAmountPHP != null && Math.abs(total - lockedAmountPHP) > 0.005,
        staleRateSnapshot: false,
      };
    }
  }

  if (lockedAmountPHP === null) return null;
  return {
    source: 'lock',
    amountPHP: lockedAmountPHP,
    amountUSD: numOrNull(staged?.amountUSD),
    breakdown: breakdownFromStage(staged!),
    lockedAmountPHP,
    repricedAfterLock: false,
    staleRateSnapshot,
  };
}

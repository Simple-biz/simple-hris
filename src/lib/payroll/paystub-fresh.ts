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
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import type { WizardFinalPayEntry } from "@/lib/payroll/paystub-recovery";
// The three gates that decide whether a snapshot may speak for a payee live in
// ONE pure module, shared with Payment Dispatch's queue. They used to exist only
// here, while the queue overlay applied the snapshot with none of them — so the
// money a clerk sent and the statement that person received could be priced from
// different carriers. See src/lib/payroll/wizard-dispatch-values.ts.
import {
  snapshotEntryIsItemized,
  snapshotIsNewerThanLock,
  snapshotRateContradictsCatalog,
} from "@/lib/payroll/wizard-dispatch-values";

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
  /** True when a newer snapshot existed but was REJECTED because its hourly
   *  rate contradicts the employee's Payment Catalog rate — see
   *  {@link mergeSnapshotIntoStaged}. The staged payload was returned instead. */
  staleRateSnapshot?: boolean;
  error: string | null;
}

/**
 * An employee-scope Payment Catalog rate (PHP), used to VALIDATE a wizard
 * snapshot before it is allowed to overwrite staged figures. The catalog is
 * the source of truth for rates: a snapshot computed at any other rate can
 * only have come from a wizard session holding pre-change data.
 */
export interface CatalogRateClaim {
  regular: number;
  ot: number | null;
}

/**
 * Employee-scope PHP catalog rates keyed by normalized email — one query,
 * reusable across a batch of merges. USD/COP structures are omitted: their
 * PHP-equivalent depends on the FX rate, so an exact comparison against the
 * snapshot's PHP rate isn't possible; those employees keep the pre-guard
 * behavior. Returns an empty map when the catalog is unreachable (guard
 * disabled — merges behave exactly as before).
 */
export async function getCatalogRateClaimsByEmail(): Promise<Map<string, CatalogRateClaim>> {
  const map = new Map<string, CatalogRateClaim>();
  try {
    const { structures } = await listPayStructures();
    // Insertion order is created_at ASC, so a later duplicate for the same
    // email wins — the same last-write-wins rule as buildCatalogRateIndex.
    for (const s of structures) {
      if (s.scope !== "employee" || s.currency !== "PHP") continue;
      const em = (s.employeeEmail ?? "").trim().toLowerCase();
      if (!em || !Number.isFinite(s.regularRate)) continue;
      map.set(em, {
        regular: s.regularRate,
        ot: s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : null,
      });
    }
  } catch {
    // Catalog unavailable — return an empty map so merging degrades gracefully.
  }
  return map;
}

/** Resolve one employee's claim from the bulk map, trying each alias email. */
export function catalogClaimForEmails(
  claims: Map<string, CatalogRateClaim>,
  emails: Array<string | null | undefined>,
): CatalogRateClaim | null {
  for (const e of emails) {
    if (typeof e !== "string") continue;
    const em = e.trim().toLowerCase();
    if (!em) continue;
    const hit = claims.get(em);
    if (hit) return hit;
  }
  return null;
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
 * Field-wise equality for two payload-shaped `proration` blocks (either side
 * may be a jsonb round-trip, so key ORDER must not matter and numbers compare
 * with the same sub-centavo tolerance as every other figure here).
 */
/**
 * Field-wise equality for two payload-shaped `hogan_sheet` blocks (the HSL
 * sheet-form legs, 2026-08-11) — same jsonb-round-trip and tolerance rules as
 * {@link sameProrationBlock}.
 */
function sameHoganBlock(a: unknown, b: unknown): boolean {
  const ao = a && typeof a === "object" ? (a as Record<string, unknown>) : null;
  const bo = b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  if (!ao || !bo) return ao === bo || (!ao && !bo);
  if (
    !sameAmount(ao.mf_hours, bo.mf_hours) ||
    !sameAmount(ao.we_hours, bo.we_hours) ||
    !sameAmount(ao.ot_hours, bo.ot_hours)
  ) {
    return false;
  }
  const aRates = ao.rates_php && typeof ao.rates_php === "object" ? obj(ao.rates_php) : null;
  const bRates = bo.rates_php && typeof bo.rates_php === "object" ? obj(bo.rates_php) : null;
  if (!aRates !== !bRates) return false;
  if (aRates && bRates) {
    if (
      !sameAmount(aRates.regular, bRates.regular) ||
      !sameAmount(aRates.weekend, bRates.weekend) ||
      !sameAmount(aRates.ot_differential, bRates.ot_differential)
    ) {
      return false;
    }
  }
  const aPay = obj(ao.pay_php);
  const bPay = obj(bo.pay_php);
  return (
    sameAmount(aPay.base, bPay.base) &&
    sameAmount(aPay.weekend, bPay.weekend) &&
    sameAmount(aPay.ot_differential, bPay.ot_differential)
  );
}

function sameProrationBlock(a: unknown, b: unknown): boolean {
  const ao = a && typeof a === "object" ? (a as Record<string, unknown>) : null;
  const bo = b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  if (!ao || !bo) return ao === bo || (!ao && !bo);

  const dateOf = (o: Record<string, unknown>) =>
    typeof o.effective_date === "string" && o.effective_date ? o.effective_date : null;
  if (dateOf(ao) !== dateOf(bo)) return false;

  const sameRates = (x: unknown, y: unknown) => {
    const xo = obj(x);
    const yo = obj(y);
    return sameAmount(xo.regular, yo.regular) && sameAmount(xo.ot, yo.ot);
  };
  if (!sameRates(ao.old_rates_php, bo.old_rates_php)) return false;
  if (!sameRates(ao.new_rates_php, bo.new_rates_php)) return false;

  const sameSegs = (x: unknown, y: unknown) => {
    const xs = Array.isArray(x) ? x : [];
    const ys = Array.isArray(y) ? y : [];
    if (xs.length !== ys.length) return false;
    for (let i = 0; i < xs.length; i++) {
      const xi = obj(xs[i]);
      const yi = obj(ys[i]);
      if (
        !sameAmount(xi.rate_php, yi.rate_php) ||
        !sameAmount(xi.hours, yi.hours) ||
        !sameAmount(xi.pay_php, yi.pay_php)
      ) {
        return false;
      }
    }
    return true;
  };
  const aSegs = obj(ao.segments);
  const bSegs = obj(bo.segments);
  return (
    sameSegs(aSegs.regular, bSegs.regular) &&
    sameSegs(aSegs.ot, bSegs.ot) &&
    sameSegs(aSegs.weekend_regular, bSegs.weekend_regular) &&
    sameSegs(aSegs.weekend_ot, bSegs.weekend_ot)
  );
}

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
 *    an old total-only snapshot can't rebuild a full statement;
 *  - when `catalogRatePhp` is supplied (the employee has an employee-scope PHP
 *    Payment Catalog structure), the snapshot's own rates must MATCH it. The
 *    catalog is the source of truth for rates, so a snapshot carrying any other
 *    rate is provably from a wizard session holding pre-change data — a
 *    still-open stale tab republishing after a rate fix would otherwise merge
 *    old-rate figures over corrected staged values, and the result is
 *    internally consistent so no downstream check can catch it (2026-07-29:
 *    a stale session republished ₱175-computed figures 18 minutes AFTER the
 *    ₱225 catalog fix). Rejection is signalled via `staleRateSnapshot: true`.
 */
export function mergeSnapshotIntoStaged(
  staged: StagedPaystubLike,
  snapValue: string | null,
  snapUpdatedAt: string | null,
  catalogRatePhp?: CatalogRateClaim | null,
): {
  payload: Record<string, unknown> | null;
  payPeriod: Record<string, unknown> | null;
  refreshed: boolean;
  staleRateSnapshot?: boolean;
} {
  const base = { payload: staged.payload, payPeriod: staged.pay_period, refreshed: false };
  if (!staged.payload || staged.excluded || !snapValue) return base;

  // Newer-than-lock guard: both are timestamptz ISO strings.
  if (!snapshotIsNewerThanLock(snapUpdatedAt, staged.locked_at)) return base;

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
  if (!snapshotEntryIsItemized(entry)) return base;

  // ── Catalog rate check: the snapshot must have been computed at the rate the
  // Payment Catalog decrees. A mismatch on any rate the snapshot carries means
  // the publishing wizard session predates the current catalog — its figures
  // are stale no matter how new its `updated_at` is. (Snapshots without rate
  // fields — pre-2026-07-21 — can't be validated and keep the old behavior.)
  // (Sheet-form snapshots (HSL 2026-08-11) store the DERIVED 0.5× differential as
  // `otRate`, which never matches the catalog's standalone OT column and doesn't
  // need to — the shared predicate scopes the OT check accordingly.)
  if (snapshotRateContradictsCatalog(entry, catalogRatePhp)) {
    return { ...base, staleRateSnapshot: true };
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

  // ── HSL weekend carve-out (snapshots since 2026-07-30) ──
  // The snapshot's regular/OT figures are about to overwrite the staged ones, so
  // the weekend block that itemizes them must move in the same write — a stale
  // weekend block under fresh totals would advertise money the lines don't sum
  // to. Older snapshots (fields undefined) can't speak for the block, so the
  // staged one is kept exactly as-is. All-null fields = the row has no weekend
  // block (non-HSL) → the merged payload's block is null too.
  const oldWeekend = p.weekend && typeof p.weekend === "object" ? obj(p.weekend) : null;
  const hasWeekendFields = entry.weekendRegularHours !== undefined;
  const nextWeekend = !hasWeekendFields
    ? (oldWeekend as Record<string, unknown> | null)
    : entry.weekendRegularHours == null
      ? null
      : {
          hours: { regular: num(entry.weekendRegularHours), ot: num(entry.weekendOtHours) },
          pay_php: {
            regular: numOrNull(entry.weekendRegularPay),
            ot: numOrNull(entry.weekendOtPay),
          },
          premium_php_per_hour: oldWeekend ? num(oldWeekend.premium_php_per_hour) || 15 : 15,
        };
  const weekendChanged = (() => {
    if (!hasWeekendFields) return false;
    if (!oldWeekend !== !nextWeekend) return true;
    if (!oldWeekend || !nextWeekend || !("hours" in nextWeekend)) return false;
    const oh = obj(oldWeekend.hours);
    const op = obj(oldWeekend.pay_php);
    const nw = nextWeekend as { hours: { regular: number; ot: number }; pay_php: { regular: number | null; ot: number | null } };
    return (
      !sameAmount(oh.regular, nw.hours.regular) ||
      !sameAmount(oh.ot, nw.hours.ot) ||
      !sameAmount(op.regular, nw.pay_php.regular) ||
      !sameAmount(op.ot, nw.pay_php.ot)
    );
  })();

  // ── Mid-week proration block (snapshots since 2026-07-30) ──
  // Same contract as the weekend block: the block EXPLAINS the regular/OT
  // figures (per-rate basis for the "Prorated" chip), so it must travel in the
  // same write as the figures themselves. Older snapshots (field undefined)
  // can't speak for it and the staged block is kept; `null` means the row has
  // no mid-period change and clears a stale block.
  const oldProration = p.proration && typeof p.proration === "object" ? (p.proration as Record<string, unknown>) : null;
  const hasProrationField = entry.proration !== undefined;
  const nextProration = !hasProrationField ? oldProration : (entry.proration ?? null);
  const prorationChanged = hasProrationField && !sameProrationBlock(oldProration, entry.proration ?? null);

  // ── Hogan sheet-form legs (snapshots since 2026-08-11) ──
  // Same contract again: the block IS the statement's M-F / Weekend /
  // OT-Differential lines, so it must move in the same write as the regular/OT
  // figures it decomposes. Older snapshots (field undefined) can't speak for
  // it; `null` means not a sheet-form row and clears a stale block.
  const oldHogan =
    p.hogan_sheet && typeof p.hogan_sheet === "object" ? (p.hogan_sheet as Record<string, unknown>) : null;
  const hasHoganField = entry.hoganSheet !== undefined;
  const nextHogan = !hasHoganField ? oldHogan : (entry.hoganSheet ?? null);
  const hoganChanged = hasHoganField && !sameHoganBlock(oldHogan, entry.hoganSheet ?? null);

  // Field-by-field change detection (NOT JSON.stringify — jsonb round-trips
  // reorder keys, which would flag every merge as a change). fx_rate is part of
  // the statement too (the USD line), so an fx-only snapshot update must merge.
  const changed =
    (Object.keys(nextPay) as Array<keyof typeof nextPay>).some((k) => !sameAmount(oldPay[k], nextPay[k])) ||
    (Object.keys(nextHours) as Array<keyof typeof nextHours>).some((k) => !sameAmount(oldHours[k], nextHours[k])) ||
    (Object.keys(nextRates) as Array<keyof typeof nextRates>).some((k) => !sameAmount(oldRates[k], nextRates[k])) ||
    weekendChanged ||
    prorationChanged ||
    hoganChanged ||
    (snapFx > 0 && !sameAmount(oldPeriod.fx_rate, snapFx)) ||
    (nextNote ?? null) !== ((typeof p.adjustment_note === "string" ? p.adjustment_note : null) ?? null);
  if (!changed) return base;

  const merged = {
    ...p,
    hours: nextHours,
    // Only rewrite the weekend key when the snapshot actually carries the
    // fields — an old-shape snapshot must not stamp `weekend: null` onto a
    // payload that never had (or already has) a block.
    ...(hasWeekendFields ? { weekend: nextWeekend } : {}),
    // Same rule for the proration block (see above).
    ...(hasProrationField ? { proration: nextProration } : {}),
    // Same rule for the Hogan sheet-form block (see above).
    ...(hasHoganField ? { hogan_sheet: nextHogan } : {}),
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

  // The employee's catalog rate claim gates the merge (see mergeSnapshotIntoStaged).
  const claims = snap ? await getCatalogRateClaimsByEmail() : new Map<string, CatalogRateClaim>();
  const p = obj(staged.payload);
  const claim = catalogClaimForEmails(claims, [
    recipientEmail,
    typeof p.email === "string" ? p.email : null,
  ]);

  const merged = mergeSnapshotIntoStaged(staged, snap?.value ?? null, snap?.updatedAt ?? null, claim);
  if (merged.staleRateSnapshot) {
    console.warn(
      `[paystub-fresh] ${sourceFile} / ${recipientEmail}: wizard snapshot rejected — its rate ` +
        `contradicts the Payment Catalog (stale wizard session). Staged figures kept; ` +
        `reload the wizard and re-lock the week to heal the snapshot.`,
    );
  }
  return { staged, ...merged, error: null };
}

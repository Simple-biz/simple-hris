/**
 * Wizard-sourced money the Overview hero's hours×rates sum cannot see — KPI /
 * catalog bonuses, the Payroll Notes adjustment, orphanage pay, MESA deduction
 * + disbursement — plus urgent one-off payments recorded during the cycle's
 * dispatch week. The Accounting Overview adds `extrasTotalPhp` on top of its
 * salary sum (and its own PAB accrual) so "Total payout" reads as the FULL
 * pay run instead of initial pay alone.
 *
 * Per-person source precedence mirrors Payment Dispatch (paystub-fresh.ts,
 * minus its per-person rate-validity gates — those need Payment Catalog claims
 * and are overkill for a dashboard aggregate):
 *   - the staged row in `paystub_dispatch_queue` (the lock), overlaid by the
 *     live `payroll.wizard.final_pay.<file>` snapshot when that snapshot is
 *     newer than the row's lock AND carries the itemized bonus fields
 *     (snapshots written before 2026-07-18 don't);
 *   - before any lock exists, the snapshot alone (its `finals` map is keyed by
 *     BOTH work and personal email, so entries are deduped by content);
 *   - neither → all zeros with provenance 'none', and the hero shows plain
 *     salary exactly as it did before this module existed.
 *
 * PAB is deliberately EXCLUDED from `extrasTotalPhp`: the hero already accrues
 * PAB itself (pabMetrics) once the period closes, and the staged PAB is only
 * nonzero on the final PAB week — adding both would double-count it. The
 * staged PAB sum is still reported in `components.pabPhp` for transparency.
 */
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { getAppSettingWithMeta } from '@/lib/supabase/app-settings';

export interface PayoutExtrasComponents {
  /** Staged/live Perfect Attendance total — informational only, NOT in `extrasTotalPhp`. */
  pabPhp: number;
  techPhp: number;
  /** KPI Calculator + Bonus Catalog money ("Performance" on stubs). */
  otherBonusesPhp: number;
  /** Signed Payroll Notes "Adjustment" bridge total (can be negative). */
  adjustmentPhp: number;
  /** Positive number; subtracted from the total. */
  mesaDeductionPhp: number;
  mesaDisbursementPhp: number;
  orphanagePhp: number;
}

export interface PayoutExtras {
  sourceFile: string;
  /** 'wizard' = live final_pay snapshot won for at least one person; 'staged' =
   *  lock-time figures only; 'none' = the cycle has no wizard data yet. */
  provenance: 'wizard' | 'staged' | 'none';
  /** Timestamp of the freshest figure used (snapshot updated_at or lock time). */
  asOf: string | null;
  components: PayoutExtrasComponents;
  /** The `urgent_<sun>_to_<sat>` bucket of the week AFTER the CSV week — the
   *  week this cycle is actually dispatched in. Null when the filename carries
   *  no parseable period end. */
  urgentWeek: string | null;
  /** Σ amount_php of PAID urgent dispatches (one-offs + MESA payouts) in that week. */
  urgentPaidPhp: number;
  /** tech + otherBonuses + adjustment + mesaDisbursement + orphanage
   *  − mesaDeduction + urgentPaid. PAB excluded (see module doc). */
  extrasTotalPhp: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const ZERO: PayoutExtrasComponents = {
  pabPhp: 0,
  techPhp: 0,
  otherBonusesPhp: 0,
  adjustmentPhp: 0,
  mesaDeductionPhp: 0,
  mesaDisbursementPhp: 0,
  orphanagePhp: 0,
};

type StagedRow = {
  recipient_email: string | null;
  excluded: boolean | null;
  locked_at: string | null;
  payload: Record<string, unknown> | null;
};

/** Component slice of a staged payload's `pay_php` block. */
function fromPayload(payload: Record<string, unknown> | null): PayoutExtrasComponents {
  const p = (payload?.['pay_php'] ?? null) as Record<string, unknown> | null;
  if (!p) return ZERO;
  return {
    pabPhp: num(p['perfect_attendance_bonus']),
    techPhp: num(p['tech_bonus']),
    otherBonusesPhp: num(p['other_bonuses']),
    adjustmentPhp: num(p['adjustment']),
    mesaDeductionPhp: num(p['mesa_deduction']),
    mesaDisbursementPhp: num(p['mesa_disbursement']),
    orphanagePhp: num(p['orphanage_pay']),
  };
}

/** Component slice of a `payroll.wizard.final_pay` snapshot entry. */
function fromSnapshotEntry(e: Record<string, unknown>): PayoutExtrasComponents {
  return {
    pabPhp: num(e['perfectAttendanceBonus']),
    techPhp: num(e['techBonus']),
    otherBonusesPhp: num(e['otherBonuses']),
    adjustmentPhp: num(e['adjustment']),
    mesaDeductionPhp: num(e['mesaDeduction']),
    mesaDisbursementPhp: num(e['mesaDisbursement']),
    orphanagePhp: num(e['orphanagePay']),
  };
}

/** Snapshots older than 2026-07-18 lack the itemized split — for those the
 *  staged payload stays authoritative (same rule paystub-fresh applies). */
function snapshotEntryItemized(e: Record<string, unknown>): boolean {
  return (
    e['otherBonuses'] !== undefined ||
    e['adjustment'] !== undefined ||
    e['perfectAttendanceBonus'] !== undefined ||
    e['techBonus'] !== undefined
  );
}

function accumulate(total: PayoutExtrasComponents, c: PayoutExtrasComponents): void {
  total.pabPhp += c.pabPhp;
  total.techPhp += c.techPhp;
  total.otherBonusesPhp += c.otherBonusesPhp;
  total.adjustmentPhp += c.adjustmentPhp;
  total.mesaDeductionPhp += c.mesaDeductionPhp;
  total.mesaDisbursementPhp += c.mesaDisbursementPhp;
  total.orphanagePhp += c.orphanagePhp;
}

/**
 * The urgent bucket tied to a cycle: payroll for CSV week Sun–Sat is dispatched
 * the FOLLOWING Sun–Sat week, and urgent dispatches are bucketed by their
 * clerk-entered sent_date into `urgent_<sun>_to_<sat>` (urgent-cycle.ts). So the
 * cycle's urgent money lives in the week right after the filename's period end.
 */
export function urgentBucketForCycle(sourceFile: string): string | null {
  const m = /_to_(\d{4}-\d{2}-\d{2})/.exec(sourceFile);
  if (!m) return null;
  const end = new Date(`${m[1]}T00:00:00Z`);
  if (isNaN(end.getTime())) return null;
  const sun = new Date(end);
  sun.setUTCDate(sun.getUTCDate() + 1);
  // Snap to the Sun–Sat week containing end+1 (a no-op when end is a Saturday).
  sun.setUTCDate(sun.getUTCDate() - sun.getUTCDay());
  const sat = new Date(sun);
  sat.setUTCDate(sat.getUTCDate() + 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `urgent_${iso(sun)}_to_${iso(sat)}`;
}

export async function computePayoutExtras(sourceFile: string): Promise<PayoutExtras> {
  const supabase = createSupabaseServiceRoleClient();
  const total: PayoutExtrasComponents = { ...ZERO };
  let provenance: PayoutExtras['provenance'] = 'none';
  let asOf: string | null = null;
  const urgentWeek = urgentBucketForCycle(sourceFile);
  let urgentPaidPhp = 0;

  if (!supabase) {
    return { sourceFile, provenance, asOf, components: total, urgentWeek, urgentPaidPhp, extrasTotalPhp: 0 };
  }

  const stagedRes = await selectAllPaged<StagedRow>((from, to) =>
    supabase
      .from('paystub_dispatch_queue')
      .select('recipient_email, excluded, locked_at, payload')
      .eq('cycle_source_file', sourceFile)
      .order('recipient_email', { ascending: true })
      .range(from, to),
  );
  if (stagedRes.error) throw new Error(`paystub_dispatch_queue read failed: ${stagedRes.error}`);
  const staged = stagedRes.rows.filter((r) => !r.excluded);

  const snapMeta = await getAppSettingWithMeta(`payroll.wizard.final_pay.${sourceFile}`);
  let finals: Record<string, Record<string, unknown>> | null = null;
  if (snapMeta?.value) {
    try {
      const parsed = JSON.parse(snapMeta.value) as { finals?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.finals && typeof parsed.finals === 'object') {
        finals = parsed.finals as Record<string, Record<string, unknown>>;
      }
    } catch {
      /* malformed snapshot → staged figures only */
    }
  }
  const snapUpdatedMs = snapMeta?.updatedAt ? Date.parse(snapMeta.updatedAt) : NaN;

  if (staged.length > 0) {
    provenance = 'staged';
    let usedSnapshot = false;
    let maxLockedMs = NaN;
    for (const row of staged) {
      const lockedMs = row.locked_at ? Date.parse(row.locked_at) : NaN;
      if (Number.isFinite(lockedMs) && (!Number.isFinite(maxLockedMs) || lockedMs > maxLockedMs)) {
        maxLockedMs = lockedMs;
      }
      // Work email only — personal emails are shared across people (the
      // Rhocel/John Corpuz cross-wire), so safe readers never match by them.
      const workKey = row.recipient_email?.trim().toLowerCase() ?? '';
      const entry = workKey && finals ? finals[workKey] : undefined;
      const snapshotWins =
        entry != null &&
        snapshotEntryItemized(entry) &&
        Number.isFinite(snapUpdatedMs) &&
        (!Number.isFinite(lockedMs) || snapUpdatedMs > lockedMs);
      accumulate(total, snapshotWins ? fromSnapshotEntry(entry) : fromPayload(row.payload));
      if (snapshotWins) usedSnapshot = true;
    }
    if (usedSnapshot) {
      provenance = 'wizard';
      asOf = snapMeta?.updatedAt ?? null;
    } else {
      asOf = Number.isFinite(maxLockedMs) ? new Date(maxLockedMs).toISOString() : null;
    }
  } else if (finals) {
    // Pre-lock: snapshot only. The finals map holds the SAME entry under a
    // person's work and personal email — dedupe by content signature.
    provenance = 'wizard';
    asOf = snapMeta?.updatedAt ?? null;
    const seen = new Set<string>();
    for (const entry of Object.values(finals)) {
      if (!entry || typeof entry !== 'object') continue;
      const sig = JSON.stringify(entry);
      if (seen.has(sig)) continue;
      seen.add(sig);
      accumulate(total, fromSnapshotEntry(entry));
    }
  }

  if (urgentWeek) {
    const urgentRes = await selectAllPaged<{ amount_php: number | null }>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select('amount_php')
        .eq('cycle_source_file', urgentWeek)
        .eq('status', 'paid')
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (urgentRes.error) throw new Error(`payment_dispatches urgent read failed: ${urgentRes.error}`);
    urgentPaidPhp = round2(urgentRes.rows.reduce((s, r) => s + num(r.amount_php), 0));
  }

  for (const k of Object.keys(total) as (keyof PayoutExtrasComponents)[]) {
    total[k] = round2(total[k]);
  }
  const extrasTotalPhp = round2(
    total.techPhp +
      total.otherBonusesPhp +
      total.adjustmentPhp +
      total.mesaDisbursementPhp +
      total.orphanagePhp -
      total.mesaDeductionPhp +
      urgentPaidPhp,
  );

  return { sourceFile, provenance, asOf, components: total, urgentWeek, urgentPaidPhp, extrasTotalPhp };
}

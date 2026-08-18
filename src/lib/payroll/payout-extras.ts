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
 *   - excluded (do-not-pay) rows count ONLY once a paid employee dispatch
 *     exists for them this cycle (the Excluded tab's "Pay now" settles them
 *     from their staged amounts — mirroring listExcludedArrears), and are
 *     never snapshot-merged;
 *   - before any lock exists, the snapshot alone (entries deduped by their
 *     `workEmail` identity — the finals map keys the SAME entry under work AND
 *     personal email; content-signature fallback for pre-2026-07-30 snapshots
 *     that lack the field);
 *   - neither → all zeros with provenance 'none', and the hero shows plain
 *     salary exactly as it did before this module existed.
 *
 * PAB is deliberately EXCLUDED from `extrasTotalPhp`: the hero already accrues
 * PAB itself (pabMetrics) once the period closes, and the staged PAB is only
 * nonzero on the final PAB week — adding both would double-count it. The
 * staged PAB sum is still reported in `components.pabPhp` for transparency.
 *
 * A snapshot READ FAILURE throws (strict read) instead of degrading to "no
 * snapshot": pre-lock, that degradation would zero the bonuses and the caller
 * would publish the deflated total to the CEO board. The route turns the throw
 * into a 500 and the Overview keeps its last known extras.
 */
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';

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
  /** Per-person itemization keyed by lowercased WORK email — the exact figures
   *  the aggregate `components` summed, per the same precedence (qualifying
   *  snapshot entry, else staged row; excluded rows only once settled). Fed to
   *  the Overview table CSV export so its per-row bonus/adjustment columns can
   *  never disagree with the hero. The route strips this unless asked
   *  (`?per_person=1`) — it is ~1,000 entries and the hero polls every 30s. */
  byEmail: Record<string, PayoutExtrasPerson>;
}

export interface PayoutExtrasPerson {
  components: PayoutExtrasComponents;
  /** The carrier's final pay for the row (staged `pay_php.final` or snapshot
   *  `final`), or null when the carrier doesn't state one. */
  finalPhp: number | null;
  /** Which carrier priced this person (mirrors the aggregate's precedence). */
  source: 'wizard' | 'staged' | 'excluded_settled';
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** What selectAllPaged expects a page builder to resolve to. The `payload->pay_php`
 *  projection and the dynamic payee_type select string defeat supabase-js's
 *  select-string type parser, so those builders are cast to this explicitly. */
type PageOf<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

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
  /** `payload->pay_php` projected server-side — the full payload is multi-KB per
   *  row (pay_period, weekend, proration, notes) and this module only reads the
   *  seven money fields, so shipping ~1,000 whole payloads per call would be
   *  10–50× the necessary transfer (cf. LIST_COLUMNS in paystub-dispatch-queue.ts). */
  pay_php: Record<string, unknown> | null;
};

/** Component slice of a staged row's projected `pay_php` block. */
function fromPayPhp(p: Record<string, unknown> | null): PayoutExtrasComponents {
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

/**
 * Short in-memory TTL cache. The Overview refetches on every live-refresh nonce
 * bump (Realtime bursts on the hot `app_settings` table + 30s poll + focus),
 * and the wizard republishes its snapshot at most every 1.5s — recomputing a
 * whole cycle's queue scan per viewer per bump is pure waste. 15s of staleness
 * is invisible next to the client's own 30s poll floor.
 */
const CACHE_TTL_MS = 15_000;
const extrasCache = new Map<string, { at: number; extras: PayoutExtras }>();

export async function computePayoutExtras(sourceFile: string): Promise<PayoutExtras> {
  const cached = extrasCache.get(sourceFile);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.extras;

  const supabase = createSupabaseServiceRoleClient();
  const total: PayoutExtrasComponents = { ...ZERO };
  // Per-person mirror of `total` — every accumulate() below also records the
  // same figures under the person's work email, so the export column set and
  // the hero aggregate are the same numbers by construction.
  const byEmail: Record<string, PayoutExtrasPerson> = {};
  let provenance: PayoutExtras['provenance'] = 'none';
  let asOf: string | null = null;
  const urgentWeek = urgentBucketForCycle(sourceFile);
  let urgentPaidPhp = 0;

  if (!supabase) {
    return { sourceFile, provenance, asOf, components: total, urgentWeek, urgentPaidPhp, extrasTotalPhp: 0, byEmail };
  }

  const stagedRes = await selectAllPaged<StagedRow>(
    (from, to) =>
      supabase
        .from('paystub_dispatch_queue')
        .select('recipient_email, excluded, locked_at, pay_php:payload->pay_php')
        .eq('cycle_source_file', sourceFile)
        .order('recipient_email', { ascending: true })
        .range(from, to) as unknown as PageOf<StagedRow>,
  );
  if (stagedRes.error) throw new Error(`paystub_dispatch_queue read failed: ${stagedRes.error}`);
  const staged = stagedRes.rows.filter((r) => !r.excluded);
  const stagedExcluded = stagedRes.rows.filter((r) => r.excluded);

  const snapMeta = await getAppSettingWithMetaStrict(`payroll.wizard.final_pay.${sourceFile}`);
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

  if (stagedRes.rows.length > 0) {
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
      const c = snapshotWins ? fromSnapshotEntry(entry) : fromPayPhp(row.pay_php);
      accumulate(total, c);
      if (workKey) {
        byEmail[workKey] = {
          components: { ...c },
          finalPhp: snapshotWins
            ? finiteOrNull(entry['final'])
            : finiteOrNull(row.pay_php?.['final']),
          source: snapshotWins ? 'wizard' : 'staged',
        };
      }
      if (snapshotWins) usedSnapshot = true;
    }
    // Excluded (do-not-pay) rows: their money counts only once Accounting
    // actually settles them (the Excluded tab's "Pay now" writes a paid
    // employee dispatch under the regular cycle_source_file). Settled rows are
    // priced from their STAGED amounts — never snapshot-merged — mirroring the
    // arrears ledger's rule.
    if (stagedExcluded.length > 0) {
      const paidEmails = await paidEmployeeDispatchEmails(supabase, sourceFile);
      for (const row of stagedExcluded) {
        const em = row.recipient_email?.trim().toLowerCase() ?? '';
        if (em && paidEmails.has(em)) {
          const c = fromPayPhp(row.pay_php);
          accumulate(total, c);
          byEmail[em] = {
            components: { ...c },
            finalPhp: finiteOrNull(row.pay_php?.['final']),
            source: 'excluded_settled',
          };
        }
      }
    }
    if (usedSnapshot) {
      provenance = 'wizard';
      asOf = snapMeta?.updatedAt ?? null;
    } else {
      asOf = Number.isFinite(maxLockedMs) ? new Date(maxLockedMs).toISOString() : null;
    }
  } else if (finals) {
    // Pre-lock: snapshot only. The finals map holds the SAME entry under a
    // person's work and personal email — dedupe by the entry's `workEmail`
    // identity (added 2026-07-30); content signature is the fallback for older
    // snapshots, accepting that two people with byte-identical figures collapse.
    //
    // Unlike the staged-row branch above, there's no `pay_php` fallback here —
    // a snapshot written before 2026-07-18 has none of the itemized fields, so
    // every component would silently coerce to 0 via `num()` while still
    // reading as a trustworthy 'wizard' figure with a real timestamp. Only
    // claim 'wizard' provenance once at least one entry actually carries the
    // itemized fields; otherwise report 'none' so the caller (and the
    // Overview UI) can tell "genuinely zero" apart from "can't answer."
    let usedItemized = false;
    const seen = new Set<string>();
    for (const entry of Object.values(finals)) {
      if (!entry || typeof entry !== 'object') continue;
      const we = entry['workEmail'];
      const sig = typeof we === 'string' && we ? `id:${we}` : JSON.stringify(entry);
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (!snapshotEntryItemized(entry)) continue;
      usedItemized = true;
      const c = fromSnapshotEntry(entry);
      accumulate(total, c);
      const workEmail = typeof we === 'string' ? we.trim().toLowerCase() : '';
      if (workEmail) {
        byEmail[workEmail] = {
          components: { ...c },
          finalPhp: finiteOrNull(entry['final']),
          source: 'wizard',
        };
      }
    }
    if (usedItemized) {
      provenance = 'wizard';
      asOf = snapMeta?.updatedAt ?? null;
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

  const extras: PayoutExtras = { sourceFile, provenance, asOf, components: total, urgentWeek, urgentPaidPhp, extrasTotalPhp, byEmail };
  extrasCache.set(sourceFile, { at: Date.now(), extras });
  return extras;
}

/** A number when the carrier states one, null otherwise — the export must show
 *  "unknown" rather than a ₱0 nobody computed. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Lowercased recipient emails with a PAID employee dispatch for the cycle.
 *  `payee_type` postdates the table's DDL — environments without the column
 *  get a re-query treating every row as an employee (same probe pattern the
 *  dispatch readers use). */
async function paidEmployeeDispatchEmails(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  sourceFile: string,
): Promise<Set<string>> {
  type PaidRow = { recipient_email: string | null; payee_type?: string | null };
  const build = (withPayeeType: boolean) =>
    selectAllPaged<PaidRow>(
      (from, to) =>
        supabase
          .from('payment_dispatches')
          .select(withPayeeType ? 'recipient_email, payee_type' : 'recipient_email')
          .eq('cycle_source_file', sourceFile)
          .eq('status', 'paid')
          .order('id', { ascending: true })
          .range(from, to) as unknown as PageOf<PaidRow>,
    );
  let res = await build(true);
  if (res.error && /payee_type/i.test(res.error)) res = await build(false);
  if (res.error) throw new Error(`payment_dispatches read failed: ${res.error}`);
  const out = new Set<string>();
  for (const r of res.rows) {
    if ((r.payee_type ?? 'employee') !== 'employee') continue;
    const em = r.recipient_email?.trim().toLowerCase();
    if (em) out.add(em);
  }
  return out;
}

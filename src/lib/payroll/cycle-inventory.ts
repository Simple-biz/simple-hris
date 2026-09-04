import 'server-only';

/**
 * Which pay cycles EXIST, as opposed to which ones were declared.
 *
 * Backs Admin → Diagnostics → Payroll Cycles' unclosed rows (Kane, 2026-09-04:
 * *"can we add the unclosed? ... and still add the data in there"*). A close-out
 * record only proves a cycle was CLOSED; nothing else in the system enumerates
 * the cycles that happened. This does, from the two tables that carry a cycle
 * key on every row.
 *
 * ── What this may and may not be used for ──────────────────────────────────
 * **It may not produce a rate, and callers must not build one from it.** Both
 * source tables were measured against production on 2026-09-04 and both
 * misreport settlement — see `src/lib/admin/cycle-performance.ts` for the
 * numbers. What they CAN answer honestly is narrower:
 *
 *   - "does a cycle with this source file exist, and over what dates"
 *   - "how many distinct payees hold a PAID dispatch row in it"
 *
 * The second is computed by the shared {@link tallyPaidDispatches} — the same
 * function the close-out record freezes with — because a cycle's paid count
 * must mean the same thing whether or not anyone closed it. Re-counting `status
 * === 'paid'` by hand here would double-count a retried payment and make an
 * unclosed cycle's figure quietly incomparable to a closed one's
 * (pay-cycle-report-snapshot.ts § "THE single tally").
 *
 * What it deliberately does NOT answer is who was still OWED. That is a fact
 * about Payment Dispatch's client-side queue and no server table reproduces it
 * (cycle-closeout.md), which is exactly why an unclosed cycle carries no
 * denominator and therefore no rate.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import {
  tallyPaidDispatches,
  type PayCycleDispatchLike,
} from '@/lib/accounting/pay-cycle-report-snapshot';
import type { ObservedCycle } from '@/lib/admin/cycle-performance';

interface DispatchRow extends PayCycleDispatchLike {
  cycle_source_file: string | null;
  cycle_period_start: string | null;
  cycle_period_end: string | null;
  created_at: string | null;
}

interface LedgerRow {
  source_file: string | null;
  cycle_period_start: string | null;
  cycle_period_end: string | null;
  status: string | null;
}

/**
 * The `disbursement_records` statuses that mean "still owed", matching
 * `loadRecordsOutstanding` in `cycle-closeout-store.ts` exactly. Kept identical
 * on purpose: the Outstanding column must mean one thing whether the number came
 * from a frozen record or from this live read.
 */
const OUTSTANDING_STATUSES = new Set(['not_paid', 'threshold', 'problem', 'pending']);

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/**
 * Every cycle observed in `payment_dispatches` and `disbursement_records`,
 * keyed by source file.
 *
 * Both tables are read because neither is complete: measured 2026-09-04,
 * `2026-08-02` and `2026-08-23` have dispatch rows but **no ledger rows**, while
 * cycles back to `2026-03-01` have ledger rows and no dispatch rows. A cycle
 * missing from one table is not a cycle that did not happen.
 *
 * Rows with no source file are skipped rather than bucketed together: they
 * cannot be matched against a close-out key, so an "unknown" bucket would be a
 * permanent phantom cycle nobody can ever close.
 */
export async function listObservedCycles(): Promise<{
  cycles: ObservedCycle[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { cycles: [], error: 'Supabase client unavailable' };

  // Paged, both: payment_dispatches passed 9,000 rows and disbursement_records
  // 20,000. PostgREST caps un-ranged reads at 1,000 with NO error, which here
  // would silently drop the oldest cycles entirely.
  const [dispatchRes, ledgerRes] = await Promise.all([
    selectAllPaged<DispatchRow>((from, to) =>
      supabase
        .from('payment_dispatches')
        .select(
          'cycle_source_file, cycle_period_start, cycle_period_end, created_at, status, payee_type, recipient_email, amount_usd, amount_php',
        )
        .order('id', { ascending: true })
        .range(from, to),
    ),
    selectAllPaged<LedgerRow>((from, to) =>
      supabase
        .from('disbursement_records')
        .select('source_file, cycle_period_start, cycle_period_end, status')
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);

  // A dispatch-read failure is fatal: without it every cycle would report zero
  // paid people, which reads as a catastrophe rather than as a failed read.
  if (dispatchRes.error) return { cycles: [], error: dispatchRes.error };

  /**
   * A cycle is a PERIOD, not a file.
   *
   * Measured 2026-09-04: Jul 26 – Aug 1 holds dispatch rows under two different
   * source files (a re-upload renames the CSV), and grouping by file listed that
   * one pay week twice — once with 1,019 paid and once with 1. Grouping by
   * period also lets `tallyPaidDispatches` see all of a week's rows at once, so
   * a person paid under both file names is counted ONCE, which a per-file tally
   * summed afterwards could never do.
   *
   * A row with no period falls back to its file name so it still gets a bucket
   * rather than colliding with every other undated row.
   */
  const groupKey = (start: string | null, end: string | null, file: string): string =>
    start && end ? `p:${start}|${end}` : `f:${file}`;

  const dispatchGroups = new Map<string, { rows: DispatchRow[]; files: Set<string> }>();
  for (const row of dispatchRes.rows) {
    const file = trimOrNull(row.cycle_source_file);
    if (!file) continue;
    const key = groupKey(
      trimOrNull(row.cycle_period_start),
      trimOrNull(row.cycle_period_end),
      file,
    );
    const bucket = dispatchGroups.get(key);
    if (bucket) {
      bucket.rows.push(row);
      bucket.files.add(file);
    } else {
      dispatchGroups.set(key, { rows: [row], files: new Set([file]) });
    }
  }

  // The ledger is best-effort: it only supplies the Outstanding audit count and
  // the existence of older cycles. A failure there degrades to "unknown"
  // outstanding (never 0) rather than losing the paid figures we do have.
  const ledgerGroups = new Map<
    string,
    { outstanding: number; files: Set<string>; start: string | null; end: string | null }
  >();
  if (!ledgerRes.error) {
    for (const row of ledgerRes.rows) {
      const file = trimOrNull(row.source_file);
      if (!file) continue;
      const start = trimOrNull(row.cycle_period_start);
      const end = trimOrNull(row.cycle_period_end);
      const key = groupKey(start, end, file);
      let bucket = ledgerGroups.get(key);
      if (!bucket) {
        // Seeded at 0, not left absent, so a cycle whose ledger rows are ALL
        // settled reports 0 outstanding rather than "unknown" — different facts.
        bucket = { outstanding: 0, files: new Set(), start, end };
        ledgerGroups.set(key, bucket);
      }
      bucket.files.add(file);
      if (OUTSTANDING_STATUSES.has(row.status ?? '')) bucket.outstanding += 1;
    }
  }

  const keys = new Set<string>([...dispatchGroups.keys(), ...ledgerGroups.keys()]);
  const cycles: ObservedCycle[] = [];

  for (const key of keys) {
    const group = dispatchGroups.get(key);
    const rows = group?.rows ?? [];
    // NO dispatch rows means the paid count is UNKNOWN, not zero.
    // `payment_dispatches` only reaches back to 2026-05-24 while the ledger
    // holds cycles from 2026-03-01, so reporting 0 would announce that ~700
    // people went unpaid in each of a dozen weeks that in fact paid everyone.
    const known = rows.length > 0;
    const tally = tallyPaidDispatches(rows);

    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    let lastActivityAt: string | null = null;
    for (const r of rows) {
      periodStart ??= trimOrNull(r.cycle_period_start);
      periodEnd ??= trimOrNull(r.cycle_period_end);
      const at = trimOrNull(r.created_at);
      if (at && (!lastActivityAt || at > lastActivityAt)) lastActivityAt = at;
    }
    const led = ledgerGroups.get(key);
    periodStart ??= led?.start ?? null;
    periodEnd ??= led?.end ?? null;

    const files = new Set<string>([...(group?.files ?? []), ...(led?.files ?? [])]);
    const sourceFiles = [...files].sort();
    if (sourceFiles.length === 0) continue; // no file = nothing a close-out could key

    cycles.push({
      sourceFile: sourceFiles[0] as string,
      sourceFiles,
      periodStart,
      periodEnd,
      paid: known ? tally.payeeCount : null,
      employeesPaid: known ? tally.employeeCount : null,
      contractorsPaid: known ? tally.contractorCount : null,
      paidUSD: tally.paidUSD,
      paidPHP: tally.paidPHP,
      recordsOutstanding: led ? led.outstanding : null,
      lastActivityAt,
    });
  }

  return { cycles, error: null };
}

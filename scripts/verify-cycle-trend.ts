/**
 * READ-ONLY: run the REAL trend rule over LIVE data and print the chart as text.
 *
 * `listObservedCycles` is `server-only` and cannot be imported outside Next, so
 * its grouping is replicated here (period-keyed, `tallyPaidDispatches`) — the
 * SHARED tally is imported, never re-implemented, because a hand-rolled count
 * would make this verification agree with nothing.
 *
 * Nothing is written. No PII is printed.
 *
 *   npx tsx scripts/verify-cycle-trend.ts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  parseCycleCloseout,
  aggregateUnpaidByProcessor,
  type CycleCloseoutRecord,
} from '@/lib/payroll/cycle-closeout';
import type { CycleCloseoutSummary } from '@/lib/payroll/cycle-closeout-store';
import { tallyPaidDispatches } from '@/lib/accounting/pay-cycle-report-snapshot';
import {
  buildCyclePerformance,
  selectTrendCycles,
  type ObservedCycle,
} from '@/lib/admin/cycle-performance';

dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env' });
dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env.local' });

const trimOrNull = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  /** Paged — every one of these tables is past the 1,000-row PostgREST cap. */
  async function pageAll<T>(table: string, cols: string, order: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from(table).select(cols).order(order, { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  // ── close-outs ──
  const settings = await pageAll<{ key: string; value: string }>('app_settings', 'key, value', 'key');
  const records = settings
    .filter((r) => r.key.startsWith('dispatch.cycle_closeout.'))
    .map((r) => parseCycleCloseout(r.value))
    .filter((r): r is CycleCloseoutRecord => r !== null);
  const summaries: CycleCloseoutSummary[] = records.map((rec) => {
    const { payees, ...rest } = rec.unpaid;
    return { ...rec, unpaid: { ...rest, byProcessor: aggregateUnpaidByProcessor(payees) } };
  });

  // ── observed cycles, grouped by PERIOD (a cycle is a period, not a file) ──
  type D = {
    cycle_source_file: string | null; cycle_period_start: string | null;
    cycle_period_end: string | null; created_at: string | null; status: string | null;
    payee_type: string | null; recipient_email: string | null;
    amount_usd: number | null; amount_php: number | null;
  };
  type L = { source_file: string | null; cycle_period_start: string | null; cycle_period_end: string | null; status: string | null };

  const dispatches = await pageAll<D>('payment_dispatches',
    'cycle_source_file, cycle_period_start, cycle_period_end, created_at, status, payee_type, recipient_email, amount_usd, amount_php', 'id');
  const ledger = await pageAll<L>('disbursement_records',
    'source_file, cycle_period_start, cycle_period_end, status', 'id');

  const key = (s: string | null, e: string | null, f: string) => (s && e ? `p:${s}|${e}` : `f:${f}`);
  const dGroups = new Map<string, { rows: D[]; files: Set<string> }>();
  for (const r of dispatches) {
    const f = trimOrNull(r.cycle_source_file);
    if (!f) continue;
    const k = key(trimOrNull(r.cycle_period_start), trimOrNull(r.cycle_period_end), f);
    const b = dGroups.get(k) ?? { rows: [], files: new Set<string>() };
    b.rows.push(r); b.files.add(f); dGroups.set(k, b);
  }
  const lGroups = new Map<string, { files: Set<string>; start: string | null; end: string | null }>();
  for (const r of ledger) {
    const f = trimOrNull(r.source_file);
    if (!f) continue;
    const s = trimOrNull(r.cycle_period_start), e = trimOrNull(r.cycle_period_end);
    const k = key(s, e, f);
    const b = lGroups.get(k) ?? { files: new Set<string>(), start: s, end: e };
    b.files.add(f); lGroups.set(k, b);
  }

  const observed: ObservedCycle[] = [];
  for (const k of new Set([...dGroups.keys(), ...lGroups.keys()])) {
    const g = dGroups.get(k);
    const rows = g?.rows ?? [];
    const known = rows.length > 0;
    const t = tallyPaidDispatches(rows);
    let ps: string | null = null, pe: string | null = null;
    for (const r of rows) {
      ps ??= trimOrNull(r.cycle_period_start);
      pe ??= trimOrNull(r.cycle_period_end);
    }
    const led = lGroups.get(k);
    ps ??= led?.start ?? null; pe ??= led?.end ?? null;
    const files = [...new Set([...(g?.files ?? []), ...(led?.files ?? [])])].sort();
    if (files.length === 0) continue;
    observed.push({
      sourceFile: files[0]!, sourceFiles: files, periodStart: ps, periodEnd: pe,
      paid: known ? t.payeeCount : null,
      employeesPaid: known ? t.employeeCount : null,
      contractorsPaid: known ? t.contractorCount : null,
      paidUSD: t.paidUSD, paidPHP: t.paidPHP,
      recordsOutstanding: null, lastActivityAt: null,
    });
  }

  const perf = buildCyclePerformance(summaries, observed);
  const trend = selectTrendCycles(perf.cycles);

  console.log(`cycles: ${perf.cycles.length} · trend points: ${trend.points.length}`);
  console.log(`HRIS starts: ${trend.hrisStart} · collapsed "No HRIS yet": ${trend.preHrisCycles} weeks to ${trend.preHrisLastPeriodEnd}`);
  console.log(`people-paid axis top: ${trend.maxPaid}\n`);
  console.log('period end    state            rate      paid   column');
  for (const p of trend.points) {
    const bar = p.rate == null
      ? (p.state === 'not_run' ? '(hatch — not run)' : '(hatch — no rate)')
      : '#'.repeat(Math.max(1, Math.round(p.rate * 28)));
    console.log(
      `${p.periodEnd}   ${p.state.padEnd(15)} ${(p.rate == null ? '—' : (p.rate * 100).toFixed(2) + '%').padStart(7)}  ` +
      `${String(p.paid ?? '—').padStart(5)}   ${bar}`,
    );
  }

  let fail = 0;
  const check = (ok: boolean, msg: string) => {
    console.log(`${ok ? '  OK  ' : ' FAIL '} ${msg}`);
    if (!ok) fail += 1;
  };
  console.log('');
  check(trend.points.every((p) => (p.rate != null) === (p.state === 'closed')),
    'a rate exists on closed points and NOWHERE else');
  check(trend.points.every((p) => p.state !== 'not_run' || p.paid == null),
    'every not_run point has paid === null (never a zero)');
  check(trend.points.every((p) => p.state !== 'no_denominator' || p.paid != null),
    'every no_denominator point has a real paid number');
  const ends = trend.points.map((p) => p.periodEnd);
  check(JSON.stringify(ends) === JSON.stringify([...ends].sort()), 'points are oldest-first');
  check(trend.hrisStart != null && trend.points[0]!.periodEnd === trend.hrisStart,
    'the first column IS the HRIS start week');
  const closedInTrend = trend.points.filter((p) => p.state === 'closed').length;
  check(closedInTrend === perf.totals.measuredCycles,
    `closed columns (${closedInTrend}) === measured cycles (${perf.totals.measuredCycles})`);
  check(trend.points.some((p) => p.state === 'not_run'),
    'the four-week stop is visible as not_run (it is the point of the chart)');

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

/**
 * READ-ONLY: run the REAL insight rule (`buildKpiInsights`) over LIVE rows and
 * print the three cards as text. The route's reads are `server-only`, so the
 * same projections are replicated here — the aggregation is imported, never
 * re-implemented. Nothing is written. No names or emails are printed.
 *
 *   npx tsx scripts/verify-kpi-insights.ts [YYYY-MM-DD selected week]
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  buildKpiInsights,
  trendWindow,
  scopeInsightDeptKeys,
  type InsightAppliedRow,
  type InsightStatusRow,
} from '@/lib/manager/kpi-insights';
import { MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';

dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env' });
dotenv.config({ path: 'c:/Users/Kane/Desktop/simple-hris/.env.local' });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim());

async function paged<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

const peso = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const t0 = Date.now();
  const depts = scopeInsightDeptKeys([...MANAGER_BONUS_DEPT_KEYS], { kind: 'elevated' });
  const { data: latest, error: le } = await sb
    .from('hsl_bonus_period_status')
    .select('period_start')
    .in('department', depts)
    .in('status', ['ready', 'locked'])
    .lte('period_start', sundayOf(manilaTodayIso()))
    .order('period_start', { ascending: false })
    .limit(1);
  if (le) throw new Error(le.message);
  const through = sundayOf((latest?.[0] as { period_start: string }).period_start);
  const selected = process.argv[2] ?? through;
  const weeks = trendWindow(through);
  const readWeeks = Array.from(new Set([...weeks, selected]));
  const [statuses, appliedByWeek] = await Promise.all([
    paged<InsightStatusRow>((f, t) =>
      sb.from('hsl_bonus_period_status').select('department, period_start, status').in('department', depts).in('period_start', readWeeks).order('id').range(f, t),
    ),
    Promise.all(
      readWeeks.map((w) =>
        paged<InsightAppliedRow>((f, t) =>
          sb.from('bonus_catalog_applied').select('department, period_start, employee_email, employee_name, amount').in('department', depts).eq('period_start', w).order('id').range(f, t),
        ),
      ),
    ),
  ]);
  const applied = appliedByWeek.flat();
  const ms = Date.now() - t0;
  const out = buildKpiInsights({ weeks, depts, selectedWeek: selected, applied, statuses });

  console.log(`depts ${depts.length} · through ${through} · selected ${selected} · ${applied.length} applied rows · ${statuses.length} status rows · ${ms} ms`);
  console.log('\nTREND (sent to Accounting)');
  for (const w of out.weeks) {
    console.log(
      `  ${w.weekStart}  ${w.measured ? peso(w.sent).padStart(15) : '     (no point)'}  sent ${w.sentDepts}/${depts.length}  pending ${peso(w.pending)} (${w.pendingDepts})  people ${w.sentPeople}`,
    );
  }
  console.log('\nDEPARTMENT AVERAGES');
  for (const d of [...out.depts].sort((a, b) => b.avgWeekly - a.avgWeekly)) {
    console.log(`  ${d.dept.padEnd(18)} avg/wk ${peso(d.avgWeekly).padStart(14)}  per person ${peso(d.avgPerPerson).padStart(11)}  weeks ${d.weeksSent}`);
  }
  const s = out.spotlight;
  console.log(`\nTOP EARNER ${s.weekStart}: ${peso(s.topAmount)} · tied ${s.tiedCount} · people paid ${s.peoplePaid} · sent ${s.top.map((t) => t.sent).join(',')} · depts ${s.top.map((t) => t.depts.join('+')).join(' | ')}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

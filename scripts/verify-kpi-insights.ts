/**
 * READ-ONLY: run the REAL insight rule (`buildKpiInsights`) over LIVE rows and
 * print the three cards as text. The route's reads are `server-only`, so the
 * same projections are replicated here — the aggregation and the scope rule are
 * imported, never re-implemented. Nothing is written. No names or emails are
 * printed.
 *
 *   npx tsx scripts/verify-kpi-insights.ts [YYYY-MM-DD selected week]        Departments
 *   npx tsx scripts/verify-kpi-insights.ts --hsl [YYYY-MM-DD selected week]  HSL Branches
 *
 * `--hsl` scopes as a manager granted EVERY branch (`hsl:<key>` for each code
 * team and each stored data sub-team), so it prints the widest view the HSL
 * route can return.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  buildKpiInsights,
  trendWindow,
  scopeHslInsightBranchKeys,
  scopeInsightDeptKeys,
  type InsightAppliedRow,
  type InsightStatusRow,
} from '@/lib/manager/kpi-insights';
import { MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { HSL_DEPT_KEYS } from '@/lib/hsl-bonus/schema';
import { BUILTIN_SUBS_SETTING_KEY } from '@/lib/departments/builtin-subs';
import { HSL_BUILTIN_KEY } from '@/lib/departments/registry';
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

const HSL = process.argv.includes('--hsl');
const ARG_WEEK = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

/** Every stored HSL data sub-team key (the route reads the same setting). */
async function hslDataBranchKeys(): Promise<string[]> {
  const { data, error } = await sb.from('app_settings').select('value').eq('key', BUILTIN_SUBS_SETTING_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  const raw = (data as { value?: string } | null)?.value;
  if (!raw) return [];
  const map = JSON.parse(raw) as Record<string, { key?: string }[]>;
  return (map[HSL_BUILTIN_KEY] ?? []).map((s) => (s.key ?? '').trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const t0 = Date.now();
  let depts: string[];
  if (HSL) {
    const data = await hslDataBranchKeys();
    const all = [...HSL_DEPT_KEYS, ...data];
    depts = scopeHslInsightBranchKeys(all, all.map((k) => `hsl:${k}`), data);
    console.log(`HSL data sub-teams stored: ${data.join(', ') || 'none'}`);
  } else {
    depts = scopeInsightDeptKeys([...MANAGER_BONUS_DEPT_KEYS], { kind: 'elevated' });
  }
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
  const selected = ARG_WEEK ?? through;
  const weeks = trendWindow(through);
  const readWeeks = Array.from(new Set([...weeks, selected]));
  const [statuses, appliedByWeek] = await Promise.all([
    paged<InsightStatusRow>((f, t) =>
      sb.from('hsl_bonus_period_status').select('department, period_start, status').in('department', depts).in('period_start', readWeeks).order('id').range(f, t),
    ),
    Promise.all(
      readWeeks.map((w) =>
        HSL
          ? paged<Omit<InsightAppliedRow, 'amount'> & { calculated_bonus: number | string | null }>((f, t) =>
              sb.from('hsl_bonus_entries').select('department, period_start, employee_email, employee_name, calculated_bonus').in('department', depts).eq('period_start', w).order('id').range(f, t),
            ).then((rows) => rows.map(({ calculated_bonus, ...rest }) => ({ ...rest, amount: calculated_bonus })))
          : paged<InsightAppliedRow>((f, t) =>
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

/**
 * READ-ONLY. Does every stored HSL KPI figure still equal what its own inputs score?
 *
 * WHY THIS EXISTS (Kane, 2026-09-22, karens@simple.biz "comes out to 1200 but it
 * should be 1450"). `POST /api/hsl-bonus/entries` upserts `calculated_bonus`
 * EXACTLY as the browser sends it — the route never re-derives it from `kpi_data`,
 * and entry saves are deliberately unaudited (volume). So the paid figure is a
 * client assertion, and until this script there was nothing anywhere that could
 * say whether a stored peso still matches the rule that is supposed to produce it.
 *
 * It re-derives with the SAME scorer the card uses — `calcBonus`/`calcManagerBonus`
 * plus `calcHslCatalogTotal` — so a disagreement is a real defect, never a second
 * opinion from a copied sum.
 *
 * LEGACY ROWS ARE NOT DRIFT, and are reported apart so they cannot hide it. A
 * `rulesFromCatalog` branch (Intake, Filing) had its code rules DELETED on
 * 2026-09-22; weeks scored before that carry schema keys no live rule reads, so
 * re-deriving them yields ₱0 by construction. That is the documented reopen
 * exposure (`hsl-subdepartments.md` §7d), not a wrong stored figure.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/audit-hsl-bonus-stored-vs-derived.mts [--dept <key>] [--week YYYY-MM-DD]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { HSL_DEPTS, calcBonus, calcManagerBonus } = await import('../src/lib/hsl-bonus/schema');
const { hslCatalogBonusesFor, calcHslCatalogTotal, HSL_CATALOG_KPI_PREFIX } = await import(
  '../src/lib/hsl-bonus/catalog-bonus'
);
type KpiData = Record<string, unknown>;

const sb = createSupabaseServiceRoleClient();
if (!sb) { console.error('Supabase is not configured (.env.local)'); process.exit(1); }

const argv = process.argv.slice(2);
const argOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const onlyDept = argOf('--dept');
const onlyWeek = argOf('--week');

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll<T>(table: string, select: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb!.from(table).select(select)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;

type Entry = {
  department: string; period_start: string; employee_email: string;
  employee_name: string | null; is_manager: boolean;
  kpi_data: KpiData | null; calculated_bonus: number | null;
};

const entries = await pageAll<Entry>('hsl_bonus_entries', '*', (q) => {
  let x = q;
  if (onlyDept) x = x.eq('department', onlyDept);
  if (onlyWeek) x = x.eq('period_start', onlyWeek);
  return x;
});

const bonusRows = await pageAll<any>('bonus_catalog_bonuses', '*', (q) => q);
const asgRows = await pageAll<any>('bonus_catalog_assignments', '*', (q) => q);

const bonuses = bonusRows.map((b) => ({
  id: b.id, name: b.name, description: b.description ?? undefined, kind: b.kind,
  cadence: b.cadence ?? undefined, amount: b.amount ?? undefined,
  formula: b.formula ?? undefined, currency: b.currency ?? undefined,
}));
const assignments = asgRows.map((a) => ({
  id: a.id, bonusId: a.bonus_id, scope: a.scope, departmentKey: a.department_key ?? '',
  employeeEmail: a.employee_email ?? undefined, employeeName: a.employee_name ?? undefined,
  excludedEmails: a.excluded_emails ?? undefined, sharedTeam: a.shared_team ?? undefined,
}));

/** A branch not in HSL_DEPTS is an accountant-created DATA branch: no code rules. */
const cfgFor = (dept: string) =>
  (HSL_DEPTS as Record<string, any>)[dept] ??
  { key: dept, name: dept, cadence: 'weekly', rules: [], rulesFromCatalog: true };

const hasCatalogKey = (k: KpiData) =>
  Object.keys(k).some((x) => x.startsWith(HSL_CATALOG_KPI_PREFIX));
const hasSchemaKey = (k: KpiData) =>
  Object.keys(k).some((x) => !x.startsWith(HSL_CATALOG_KPI_PREFIX));

type Row = { e: Entry; stored: number; derived: number; delta: number };
const drift: Row[] = [];
const legacy: Row[] = [];
let checked = 0;

for (const e of entries) {
  const kpi = (e.kpi_data ?? {}) as KpiData;
  const stored = Number(e.calculated_bonus ?? 0) || 0;
  const cfg = cfgFor(e.department);

  const catalog = hslCatalogBonusesFor({
    subLabel: `hsl:${e.department}`,
    employeeEmail: e.employee_email,
    assignments, bonuses,
    periodStart: e.period_start,
  });

  const base = cfg.perEmployee
    ? calcManagerBonus(e.employee_email, kpi as any, { periodStart: e.period_start })
    : calcBonus(kpi as any, cfg, !!e.is_manager, { periodStart: e.period_start });
  const derived = base + calcHslCatalogTotal(kpi as any, catalog);

  checked += 1;
  const delta = Math.round(stored) - Math.round(derived);
  if (delta === 0) continue;

  // A catalog-scored branch whose row predates the cutover: schema keys, no
  // catalog keys, and the branch now has no code rules. Re-derivation CANNOT
  // reproduce it — that is the documented reopen exposure, not drift.
  const isLegacy =
    cfg.rulesFromCatalog === true && hasSchemaKey(kpi) && !hasCatalogKey(kpi) && derived === 0;
  (isLegacy ? legacy : drift).push({ e, stored, derived, delta });
}

console.log(`Checked ${checked} hsl_bonus_entries rows`);
console.log(`  stored === derived : ${checked - drift.length - legacy.length}`);
console.log(`  DRIFT              : ${drift.length}`);
console.log(`  legacy pre-cutover : ${legacy.length} (expected — see §7d)`);

if (drift.length) {
  console.log('\n=== DRIFT — stored disagrees with its own inputs ===');
  drift.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const r of drift) {
    console.log(
      `  ${r.e.period_start} ${r.e.department.padEnd(20)} ${r.e.employee_email.padEnd(28)} ` +
      `stored=${peso(r.stored).padStart(10)} derived=${peso(r.derived).padStart(10)} ` +
      `delta=${(r.delta > 0 ? '+' : '') + peso(r.delta)}`,
    );
    console.log(`      kpi_data=${JSON.stringify(r.e.kpi_data)}`);
  }
  const net = drift.reduce((s, r) => s + r.delta, 0);
  console.log(`\n  net stored − derived across drifting rows: ${(net > 0 ? '+' : '') + peso(net)}`);
}

if (legacy.length) {
  const byDept = new Map<string, { n: number; pesos: number; weeks: Set<string> }>();
  for (const r of legacy) {
    const g = byDept.get(r.e.department) ?? { n: 0, pesos: 0, weeks: new Set<string>() };
    g.n += 1; g.pesos += r.stored; g.weeks.add(r.e.period_start);
    byDept.set(r.e.department, g);
  }
  console.log('\n=== legacy pre-cutover rows (a REOPEN reprices these to ₱0) ===');
  for (const [d, g] of byDept) {
    console.log(`  ${d.padEnd(20)} ${String(g.n).padStart(5)} rows  ${peso(g.pesos).padStart(12)}  over ${g.weeks.size} weeks`);
  }
}

process.exit(drift.length ? 1 : 0);

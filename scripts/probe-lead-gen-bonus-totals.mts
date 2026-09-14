/**
 * READ-ONLY. Why is Lead Gen's KPI Calculator showing ₱38,000 when it "usually"
 * runs ₱100k+?
 *
 * Answers it by measurement, not inference:
 *
 *   1. `bonus_catalog_applied` (THE MONEY TABLE — the wizard pays from this)
 *      per pay-week for lead_gen: total, rows, distinct people.
 *   2. `qc_kpi_submissions` (the QC FIRST PASS — the wizard never reads it)
 *      per pay-week, so the two are never confused for each other.
 *   3. Per-bonus breakdown for the live week against the last week that looked
 *      "normal", which is the only view that can say WHICH bonus fell away.
 *
 * No writes. No --apply gate because there is nothing to apply.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/probe-lead-gen-bonus-totals.mts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const DEPT = 'lead_gen';

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll<T = Record<string, unknown>>(
  table: string,
  select: string,
  eq: [string, string],
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb!
      .from(table)
      .select(select)
      .eq(eq[0], eq[1])
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;
const num = (v: unknown) => (v == null ? 0 : typeof v === 'string' ? Number(v) || 0 : Number(v) || 0);

type Applied = {
  period_start: string;
  employee_email: string;
  employee_name: string | null;
  bonus_id: string;
  bonus_name: string;
  cadence: string | null;
  amount: number | string | null;
};

type Sub = {
  period_start: string;
  employee_email: string;
  bonus_name: string | null;
  amount: number | null;
};

const applied = await pageAll<Applied>(
  'bonus_catalog_applied',
  'period_start, employee_email, employee_name, bonus_id, bonus_name, cadence, amount',
  ['department', DEPT],
);
const subs = await pageAll<Sub>(
  'qc_kpi_submissions',
  'period_start, employee_email, bonus_name, amount',
  ['department', DEPT],
);

console.log(`\nbonus_catalog_applied · ${DEPT}: ${applied.length} rows`);
console.log(`qc_kpi_submissions   · ${DEPT}: ${subs.length} rows`);

// ── 1 + 2. Per week, both tables side by side ────────────────────────────────
type Week = {
  appliedTotal: number;
  appliedRows: number;
  appliedPeople: Set<string>;
  appliedNonZero: number;
  qcTotal: number;
  qcRows: number;
  qcPeople: Set<string>;
};
const weeks = new Map<string, Week>();
const week = (k: string) => {
  let w = weeks.get(k);
  if (!w) {
    w = {
      appliedTotal: 0,
      appliedRows: 0,
      appliedPeople: new Set(),
      appliedNonZero: 0,
      qcTotal: 0,
      qcRows: 0,
      qcPeople: new Set(),
    };
    weeks.set(k, w);
  }
  return w;
};

for (const r of applied) {
  const w = week(r.period_start);
  const amt = num(r.amount);
  w.appliedTotal += amt;
  w.appliedRows += 1;
  w.appliedPeople.add((r.employee_email ?? '').toLowerCase());
  if (amt > 0) w.appliedNonZero += 1;
}
for (const r of subs) {
  const w = week(r.period_start);
  w.qcTotal += num(r.amount);
  w.qcRows += 1;
  w.qcPeople.add((r.employee_email ?? '').toLowerCase());
}

const keys = [...weeks.keys()].sort();
console.log('\n── Per pay-week ─────────────────────────────────────────────────────────');
console.log(
  'week        | APPLIED (paid from) rows  ppl  >0 | QC first pass  rows  ppl',
);
for (const k of keys) {
  const w = weeks.get(k)!;
  console.log(
    `${k}  | ${peso(w.appliedTotal).padStart(10)} ${String(w.appliedRows).padStart(5)} ${String(
      w.appliedPeople.size,
    ).padStart(4)} ${String(w.appliedNonZero).padStart(4)} | ${peso(w.qcTotal).padStart(10)} ${String(
      w.qcRows,
    ).padStart(5)} ${String(w.qcPeople.size).padStart(4)}`,
  );
}

// ── 3. Which bonus changed, live week vs the last week above ₱80k ────────────
const live = keys[keys.length - 1];
const normal = [...keys]
  .reverse()
  .find((k) => k !== live && weeks.get(k)!.appliedTotal >= 80_000);

const byBonus = (periodStart: string) => {
  const m = new Map<string, { total: number; rows: number; nonZero: number }>();
  for (const r of applied) {
    if (r.period_start !== periodStart) continue;
    const label = `${r.bonus_name}${r.cadence === 'monthly' ? ' (monthly)' : ''}`;
    const e = m.get(label) ?? { total: 0, rows: 0, nonZero: 0 };
    const amt = num(r.amount);
    e.total += amt;
    e.rows += 1;
    if (amt > 0) e.nonZero += 1;
    m.set(label, e);
  }
  return m;
};

console.log(`\n── Per bonus · live week ${live} ────────────────────────────────────────`);
const liveBonuses = byBonus(live);
for (const [name, e] of [...liveBonuses].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${peso(e.total).padStart(10)}  ${String(e.rows).padStart(4)} rows, ${e.nonZero} > 0   ${name}`);
}

if (!normal) {
  console.log('\nNo earlier week for this department reaches ₱80,000 in the APPLIED table.');
  console.log('=> "usually 100k+" is not a fact of bonus_catalog_applied for lead_gen.');
} else {
  console.log(`\n── Per bonus · comparison week ${normal} ───────────────────────────────`);
  const normalBonuses = byBonus(normal);
  for (const [name, e] of [...normalBonuses].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${peso(e.total).padStart(10)}  ${String(e.rows).padStart(4)} rows, ${e.nonZero} > 0   ${name}`);
  }
  console.log(`\n── Delta ${normal} → ${live} ──────────────────────────────────────────`);
  const names = new Set([...liveBonuses.keys(), ...normalBonuses.keys()]);
  for (const name of [...names].sort()) {
    const a = normalBonuses.get(name)?.total ?? 0;
    const b = liveBonuses.get(name)?.total ?? 0;
    if (a === b) continue;
    const sign = b - a > 0 ? '+' : '−';
    console.log(`  ${sign}${peso(Math.abs(b - a)).padStart(10)}  ${name}   (${peso(a)} → ${peso(b)})`);
  }
}

console.log('\nREAD-ONLY. Nothing was written.\n');

/**
 * READ-ONLY. Where is Lead Gen's missing week-2026-09-06 money?
 *
 * `bonus_catalog_applied` (the wizard pays from this) holds ₱38,000 / 18 non-zero
 * people. `qc_kpi_submissions` (the QC first pass, which the wizard NEVER reads)
 * holds ₱124,750 / 228 people for the same week and department. This joins them
 * per person so the gap is named rather than inferred:
 *
 *   - scored by QC > 0 but applied 0 or missing   ← the underpayment, if it is one
 *   - applied > 0 but QC 0 or missing             ← the override's own writes
 *   - both > 0 and equal / different
 *
 * Also prints who wrote the applied rows and when, because 200 rows at ₱0 are
 * either a manager's real answer or an autosave of an empty table, and those are
 * very different problems.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/probe-lead-gen-qc-vs-applied.mts
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
const WEEK = '2026-09-06';

async function pageAllWeek<T = Record<string, unknown>>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb!
      .from(table)
      .select(select)
      .eq('department', DEPT)
      .eq('period_start', WEEK)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const key = (e: unknown) => String(e ?? '').trim().toLowerCase();

const applied = await pageAllWeek<Record<string, unknown>>('bonus_catalog_applied', '*');
const subs = await pageAllWeek<Record<string, unknown>>('qc_kpi_submissions', '*');

console.log(`\nweek ${WEEK} · ${DEPT}`);
console.log(`bonus_catalog_applied: ${applied.length} rows`);
console.log(`qc_kpi_submissions:    ${subs.length} rows`);
console.log(`\napplied columns: ${Object.keys(applied[0] ?? {}).join(', ')}`);
console.log(`qc columns:      ${Object.keys(subs[0] ?? {}).join(', ')}`);

// Per person, both sides.
const appliedBy = new Map<string, { amount: number; name: string; rows: number }>();
for (const r of applied) {
  const k = key(r.employee_email);
  const e = appliedBy.get(k) ?? { amount: 0, name: String(r.employee_name ?? ''), rows: 0 };
  e.amount += num(r.amount);
  e.rows += 1;
  appliedBy.set(k, e);
}
const qcBy = new Map<string, { amount: number; name: string; rows: number; by: string }>();
for (const r of subs) {
  const k = key(r.employee_email);
  const e = qcBy.get(k) ?? {
    amount: 0,
    name: String(r.employee_name ?? ''),
    rows: 0,
    by: String(r.scored_by ?? r.submitted_by ?? r.officer_email ?? ''),
  };
  e.amount += num(r.amount);
  e.rows += 1;
  qcBy.set(k, e);
}

const everyone = new Set([...appliedBy.keys(), ...qcBy.keys()]);
let gapPeople = 0;
let gapPesos = 0;
let overrideOnly = 0;
let overrideOnlyPesos = 0;
let bothEqual = 0;
let bothDiffer = 0;
let bothDifferPesos = 0;
let bothZero = 0;
const gapSample: string[] = [];

for (const k of everyone) {
  const a = appliedBy.get(k)?.amount ?? 0;
  const q = qcBy.get(k)?.amount ?? 0;
  if (q > 0 && a === 0) {
    gapPeople += 1;
    gapPesos += q;
    if (gapSample.length < 12) {
      gapSample.push(`    ${k.padEnd(30)} QC ${peso(q).padStart(9)} → applied ₱0${appliedBy.has(k) ? '' : '  (NO applied row at all)'}`);
    }
  } else if (a > 0 && q === 0) {
    overrideOnly += 1;
    overrideOnlyPesos += a;
  } else if (a > 0 && q > 0) {
    if (a === q) bothEqual += 1;
    else {
      bothDiffer += 1;
      bothDifferPesos += a - q;
    }
  } else {
    bothZero += 1;
  }
}

console.log('\n── Per person ──────────────────────────────────────────────────────────');
console.log(`  people seen in either table:            ${everyone.size}`);
console.log(`  QC scored > 0 but APPLIED ₱0:           ${gapPeople}   worth ${peso(gapPesos)}   ← the gap`);
console.log(`  APPLIED > 0 but QC ₱0/absent:           ${overrideOnly}   worth ${peso(overrideOnlyPesos)}`);
console.log(`  both > 0, same amount:                  ${bothEqual}`);
console.log(`  both > 0, different:                    ${bothDiffer}   applied − QC = ${peso(bothDifferPesos)}`);
console.log(`  both ₱0:                                ${bothZero}`);
if (gapSample.length) {
  console.log('\n  sample of the gap:');
  console.log(gapSample.join('\n'));
}

// Who wrote the applied rows, and when — 200 rows at ₱0 are either a real
// answer or an autosave of an empty table.
const byWriter = new Map<string, { rows: number; zero: number }>();
for (const r of applied) {
  const w = String(r.applied_by ?? '(null)');
  const e = byWriter.get(w) ?? { rows: 0, zero: 0 };
  e.rows += 1;
  if (num(r.amount) === 0) e.zero += 1;
  byWriter.set(w, e);
}
console.log('\n── Who wrote the applied rows ──────────────────────────────────────────');
for (const [w, e] of [...byWriter].sort((a, b) => b[1].rows - a[1].rows)) {
  console.log(`  ${String(e.rows).padStart(4)} rows (${e.zero} at ₱0)   ${w}`);
}

const stamps = applied
  .map((r) => String(r.updated_at ?? r.created_at ?? ''))
  .filter(Boolean)
  .sort();
if (stamps.length) {
  console.log(`\n  applied row timestamps: ${stamps[0]}  →  ${stamps[stamps.length - 1]}`);
}

console.log('\nREAD-ONLY. Nothing was written.\n');

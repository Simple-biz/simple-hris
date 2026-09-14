/**
 * READ-ONLY. Do QC's first pass and the manager's applied table price the SAME
 * appointment count differently for week 2026-09-06 lead_gen?
 *
 * QC's amounts look linear (₱250 / ₱500 / ₱750 / ₱1,000 / ₱1,250 — i.e. ₱250 per
 * appointment). `src/lib/qc/compare.ts` documents the live Lead Gen department
 * bonus as `=IF(Appts_Set>=10, …)`, which pays ₱0 to everyone under 10. The
 * pasted counts on Jackie's sheet are 0–5. If both are true, the manager's
 * recomputation zeroes almost everyone QC scored, and that is the ₱124,250.
 *
 * Prints, for the same people, the QC row and the applied row side by side with
 * their `vars`, plus the catalog definition of every bonus involved and its
 * recent edit history — so "the formula changed" is either shown or ruled out.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/probe-lead-gen-formula-drift.mts
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
const PRIOR = '2026-08-30';

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const key = (e: unknown) => String(e ?? '').trim().toLowerCase();

async function pageAll<T = Record<string, unknown>>(
  table: string,
  select: string,
  filters: Array<[string, string]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb!.from(table).select(select);
    for (const [c, v] of filters) q = q.eq(c, v);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type Row = {
  employee_email: string;
  employee_name: string | null;
  bonus_id: string;
  bonus_name: string;
  kind: string;
  vars: Record<string, number> | null;
  amount: number | string | null;
};

const qc = await pageAll<Row>(
  'qc_kpi_submissions',
  'employee_email, employee_name, bonus_id, bonus_name, kind, vars, amount',
  [['department', DEPT], ['period_start', WEEK]],
);
const applied = await pageAll<Row>(
  'bonus_catalog_applied',
  'employee_email, employee_name, bonus_id, bonus_name, kind, vars, amount',
  [['department', DEPT], ['period_start', WEEK]],
);
const prior = await pageAll<Row>(
  'bonus_catalog_applied',
  'employee_email, employee_name, bonus_id, bonus_name, kind, vars, amount',
  [['department', DEPT], ['period_start', PRIOR]],
);

// ── Same person, both rows ───────────────────────────────────────────────────
const appliedBy = new Map<string, Row>();
for (const r of applied) appliedBy.set(key(r.employee_email), r);

console.log(`\n── week ${WEEK} · same person, QC row vs APPLIED row ─────────────────`);
console.log('  (first 14 where QC > 0 and applied = 0)\n');
let shown = 0;
for (const q of qc) {
  if (num(q.amount) <= 0) continue;
  const a = appliedBy.get(key(q.employee_email));
  if (!a || num(a.amount) !== 0) continue;
  if (shown++ >= 14) break;
  console.log(`  ${(q.employee_name ?? q.employee_email)?.slice(0, 26).padEnd(27)}`);
  console.log(`      QC      ${peso(num(q.amount)).padStart(8)}  ${q.bonus_name}  vars=${JSON.stringify(q.vars)}`);
  console.log(`      APPLIED ${peso(num(a.amount)).padStart(8)}  ${a.bonus_name}  vars=${JSON.stringify(a.vars)}`);
}

// ── Amount-per-var, both tables, both weeks ──────────────────────────────────
const rate = (rows: Row[], label: string) => {
  const buckets = new Map<string, { n: number; amounts: Set<number> }>();
  for (const r of rows) {
    const v = r.vars ?? {};
    const varName = Object.keys(v)[0] ?? '(no vars)';
    const count = varName === '(no vars)' ? NaN : Number(v[varName]);
    const k = `${r.bonus_name} · ${varName}=${Number.isNaN(count) ? '?' : count}`;
    const e = buckets.get(k) ?? { n: 0, amounts: new Set<number>() };
    e.n += 1;
    e.amounts.add(num(r.amount));
    buckets.set(k, e);
  }
  console.log(`\n── ${label} · what each appointment count paid ──────────────────`);
  for (const [k, e] of [...buckets].sort()) {
    console.log(`  ${String(e.n).padStart(4)}×  ${k.padEnd(44)} → ${[...e.amounts].sort((a, b) => a - b).map(peso).join(', ')}`);
  }
};
rate(qc, `QC first pass ${WEEK}`);
rate(applied, `APPLIED ${WEEK}`);
rate(prior, `APPLIED ${PRIOR} (the normal week)`);

// ── The catalog definitions behind those bonus ids ───────────────────────────
const ids = [...new Set([...qc, ...applied, ...prior].map((r) => r.bonus_id))].filter(Boolean);
const { data: defs, error: defErr } = await sb
  .from('bonus_catalog')
  .select('*')
  .in('id', ids);
if (defErr) console.log(`\nbonus_catalog: ${defErr.message}`);
else {
  console.log('\n── Catalog definitions ─────────────────────────────────────────────────');
  for (const d of defs ?? []) {
    const r = d as Record<string, unknown>;
    console.log(`  ${String(r.name)}  [${String(r.id).slice(0, 8)}]  kind=${String(r.kind)}  cadence=${String(r.cadence ?? 'weekly')}`);
    console.log(`      formula: ${String(r.formula ?? r.expression ?? r.amount ?? '(none)')}`);
    console.log(`      updated: ${String(r.updated_at ?? '(none)')}`);
  }
}

console.log('\nREAD-ONLY. Nothing was written.\n');

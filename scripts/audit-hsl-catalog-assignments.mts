/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * Do any Bonus Library assignments target the HSL family — `hogan_smith_law`,
 * `hsl:<sub>`, or a bare HSL label — and has ANY of them ever been applied?
 *
 * Why it matters: `hogan_smith_law` is not in DEPT_INPUT_CONFIG, so the manager
 * KPI calculator draws no HSL card; the HSL calculator is fed by
 * `hsl_bonus_entries`, not the catalog; and the wizard's payable set excludes the
 * HSL family on purpose (bonus-catalog.md §3.1, "must stay absent"). An
 * assignment here is made against a department no surface pays from.
 *
 *   npx tsx scripts/audit-hsl-catalog-assignments.mts [--bonus "<name substring>"]
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const bonusArg = (() => {
  const i = process.argv.indexOf('--bonus');
  return i >= 0 ? (process.argv[i + 1] ?? '').toLowerCase() : '';
})();

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function selectAllPaged(table: string, cols: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + size - 1);
    if (error) {
      console.error(table, error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

const isHslFamily = (k: unknown) => {
  const s = String(k ?? '').trim().toLowerCase();
  return s === 'hogan_smith_law' || s === 'hsl' || s === 'hogan smith law' || s.startsWith('hsl:');
};

const bonuses = await selectAllPaged('bonus_catalog_bonuses', 'id, name, kind, amount, formula, currency, cadence, created_by, created_at');
const nameById = new Map(bonuses.map((b) => [String(b.id), String(b.name)]));
const assignments = await selectAllPaged(
  'bonus_catalog_assignments',
  'id, bonus_id, scope, department_key, employee_email, created_by, created_at',
);
console.log(`bonuses: ${bonuses.length} · assignments: ${assignments.length}`);

if (bonusArg) {
  console.log(`\n--- bonuses matching "${bonusArg}" ---`);
  for (const b of bonuses.filter((b) => String(b.name).toLowerCase().includes(bonusArg))) {
    console.log(JSON.stringify(b, null, 2));
    const assigned = assignments.filter((a) => a.bonus_id === b.id);
    console.log(`assigned ${assigned.length}x:`, assigned.map((a) => `${a.scope}:${a.department_key}${a.employee_email ? '/' + a.employee_email : ''}`).join(', ') || '(nowhere)');
  }
}

console.log('\n--- distinct department_key values across ALL assignments ---');
const byKey = new Map<string, number>();
for (const a of assignments) {
  const k = String(a.department_key ?? '');
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byKey].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(`${(isHslFamily(k) ? '>>> HSL ' : '        ') + JSON.stringify(k).padEnd(32)} x${n}`);
}

const hsl = assignments.filter((a) => isHslFamily(a.department_key));
console.log(`\n--- HSL-family assignments: ${hsl.length} ---`);
for (const a of hsl) {
  console.log(`${String(a.created_at).slice(0, 10)}  ${a.scope}  ${a.department_key}  ${nameById.get(String(a.bonus_id)) ?? a.bonus_id}  by ${a.created_by ?? '?'}`);
}

// `bonus_catalog_applied` has no department_key column; its dept is `department`.
const applied = await selectAllPaged('bonus_catalog_applied', 'department, bonus_id, period_start, amount');
const appliedHsl = applied.filter((r) => isHslFamily(r.department));
console.log(`\n--- bonus_catalog_applied: ${applied.length} rows total, ${appliedHsl.length} HSL-family ---`);

console.log('\n================= VERDICT =================');
if (hsl.length === 0 && appliedHsl.length === 0) {
  console.log('No assignment targets the HSL family and nothing HSL has ever been applied from the catalog.');
  console.log('A library bonus assigned to HSL today would be DEAD: no calculator draws it, no loader pays it.');
} else {
  console.log(`${hsl.length} HSL-family assignment(s), ${appliedHsl.length} HSL-family applied row(s) — inspect which surface wrote them.`);
}

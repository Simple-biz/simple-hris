/**
 * STRICTLY READ-ONLY. How many of the 465 employee-scope `hogan_smith_law`
 * structures could actually be re-keyed to an `hsl:<sub>` today, and what
 * collides if we try?
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build(f, f + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const structures = await pageAll<any>((f, t) =>
  db
    .from('payment_catalog_pay_structures')
    .select('id, scope, department_key, employee_email, regular_rate, currency, created_at')
    .range(f, t),
);
const roster = await pageAll<any>((f, t) =>
  db.from('active_employees').select('"Work Email", "Department", "Name"').range(f, t),
);

const deptByEmail = new Map<string, string>();
for (const r of roster) {
  const e = String(r['Work Email'] ?? '').toLowerCase().trim();
  if (e) deptByEmail.set(e, String(r.Department ?? '').trim());
}

const hslEmp = structures.filter(
  (s) => s.scope === 'employee' && String(s.department_key ?? '').toLowerCase() === 'hogan_smith_law',
);

console.log(`\n=== employee-scope rows under hogan_smith_law: ${hslEmp.length} ===`);

const buckets = new Map<string, number>();
const offRoster: string[] = [];
for (const s of hslEmp) {
  const e = String(s.employee_email ?? '').toLowerCase().trim();
  const dept = deptByEmail.get(e);
  if (dept === undefined) {
    offRoster.push(e);
    buckets.set('(not on active roster)', (buckets.get('(not on active roster)') ?? 0) + 1);
    continue;
  }
  buckets.set(dept || '(blank)', (buckets.get(dept || '(blank)') ?? 0) + 1);
}
console.log('\nBy the person\'s CURRENT master-list Department label:');
for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${n}`);

const migratableNow = hslEmp.filter((s) => {
  const d = deptByEmail.get(String(s.employee_email ?? '').toLowerCase().trim()) ?? '';
  return d.toLowerCase().startsWith('hsl:');
}).length;
console.log(`\n  --> re-keyable TODAY (person is sub-labeled): ${migratableNow}`);
console.log(`  --> blocked (plain HSL / off-roster / other):  ${hslEmp.length - migratableNow}`);

// ── Duplicate-employee-row collision risk ───────────────────────────────────
// buildCatalogRateIndex keys employee rows by EMAIL only, last-wins. Two rows
// for one email under different department_keys = a coin-flip rate.
const empRowsByEmail = new Map<string, any[]>();
for (const s of structures.filter((x) => x.scope === 'employee')) {
  const e = String(s.employee_email ?? '').toLowerCase().trim();
  if (!e) continue;
  if (!empRowsByEmail.has(e)) empRowsByEmail.set(e, []);
  empRowsByEmail.get(e)!.push(s);
}
const dupes = [...empRowsByEmail.entries()].filter(([, rows]) => rows.length > 1);
console.log(`\n=== Emails with MORE THAN ONE employee-scope structure: ${dupes.length} ===`);
for (const [e, rows] of dupes.slice(0, 25)) {
  const rates = rows.map((r) => `${r.department_key}=${r.regular_rate}${r.currency}`).join(' | ');
  const conflicting = new Set(rows.map((r) => String(r.regular_rate))).size > 1;
  console.log(`  ${conflicting ? 'CONFLICT' : 'same-rate'}  ${e.padEnd(32)} ${rates}`);
}

// ── Sub-labeled people WITHOUT any individual rate (the dept base matters) ──
const empEmails = new Set(
  structures.filter((s) => s.scope === 'employee' && s.employee_email).map((s) => String(s.employee_email).toLowerCase()),
);
const subLabeled = roster.filter((r) => String(r.Department ?? '').toLowerCase().startsWith('hsl:'));
const subNoIndividual = subLabeled.filter(
  (r) => !empEmails.has(String(r['Work Email'] ?? '').toLowerCase()),
);
console.log(`\n=== Sub-labeled people with NO individual catalog rate: ${subNoIndividual.length} of ${subLabeled.length} ===`);
for (const r of subNoIndividual.slice(0, 30)) {
  console.log(`  ${String(r['Work Email']).padEnd(32)} ${r.Department}`);
}
console.log('\n(read-only: nothing was written)\n');

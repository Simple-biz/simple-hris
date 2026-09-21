/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * Generalising `<parent>:<sub>` placement beyond HSL means teaching
 * `normalizeDeptToKey` to resolve ANY namespaced Department cell, not just the
 * hard-coded `hsl:` prefix. That function drives the HSL Mon-Sun week model, the
 * +P15/h weekend premium, dept-scoped bonus matching and every payroll grouping,
 * so the question to answer BEFORE touching it is:
 *
 *   which Department cells already contain a colon, and what would change?
 *
 * Today a non-`hsl:` colon cell resolves to null (no department). After the
 * generalisation it would resolve to its parent — a real change in how that
 * person is grouped and priced. If any such cell exists on a live person, the
 * change moves money and needs Kane's explicit sign-off on those names.
 *
 *   npx tsx scripts/audit-namespaced-dept-cells.mts
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

function report(label: string, rows: Record<string, unknown>[], deptField: string, idField: string) {
  const byCell = new Map<string, string[]>();
  for (const r of rows) {
    const cell = String(r[deptField] ?? '').trim();
    if (!cell.includes(':')) continue;
    const who = String(r[idField] ?? '(no id)');
    if (!byCell.has(cell)) byCell.set(cell, []);
    byCell.get(cell)!.push(who);
  }
  console.log(`\n=== ${label} — ${rows.length} rows, ${byCell.size} distinct colon-bearing cells ===`);
  let nonHsl = 0;
  for (const [cell, who] of [...byCell].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isHsl = cell.toLowerCase().startsWith('hsl:');
    if (!isHsl) nonHsl += who.length;
    const tag = isHsl ? 'hsl:  ' : '>>>>>>';
    console.log(`${tag} ${JSON.stringify(cell).padEnd(40)} x${String(who.length).padStart(4)}`);
    if (!isHsl) console.log(`         ${who.slice(0, 20).join(', ')}${who.length > 20 ? ' …' : ''}`);
  }
  console.log(`NON-hsl colon cells in ${label}: ${nonHsl} rows`);
  return nonHsl;
}

const master = await selectAllPaged('global_master_list', 'id, "Department", "Work Email"');
const a = report('global_master_list', master, 'Department', 'Work Email');

const active = await selectAllPaged('active_employees', '*');
const deptField = Object.keys(active[0] ?? {}).find((k) => k.toLowerCase() === 'department') ?? 'Department';
const emailField =
  Object.keys(active[0] ?? {}).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'workemail') ?? 'Work Email';
const b = report('active_employees', active, deptField, emailField);

const rates = await selectAllPaged('employee_hourly_rates', '*');
const rDept = Object.keys(rates[0] ?? {}).find((k) => k.toLowerCase() === 'department') ?? 'Department';
const rEmail =
  Object.keys(rates[0] ?? {}).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'workemail') ??
  Object.keys(rates[0] ?? {}).find((k) => k.toLowerCase().includes('email')) ??
  'email';
const c = report('employee_hourly_rates', rates, rDept, rEmail);

console.log('\n================= VERDICT =================');
if (a + b + c === 0) {
  console.log('SAFE: no non-hsl colon Department cell exists anywhere.');
  console.log('Generalising normalizeDeptToKey to <parent>:<sub> changes NOBODY today.');
} else {
  console.log(`STOP: ${a + b + c} rows carry a non-hsl colon cell.`);
  console.log('Each resolves to NULL today and would resolve to a PARENT after the change.');
  console.log('That regroups and reprices those people — needs Kane on the specific names.');
}

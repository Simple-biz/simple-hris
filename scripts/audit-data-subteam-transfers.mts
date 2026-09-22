/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * A DATA sub-team was just created from Payment Catalog → Departments → Edit.
 * Where is it, and did anyone's transfer INTO it actually land?
 *
 *   - app_settings.payment_catalog.departments.builtin_subs — the sub as stored
 *   - global_master_list — rows whose Department cell IS that sub-team
 *   - department_transfer_requests — requests targeting it, with their status
 *     and Sheet outcome
 *
 *   npx tsx scripts/audit-data-subteam-transfers.mts [--match "health"]
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
const match = (() => {
  const i = process.argv.indexOf('--match');
  return i >= 0 ? (process.argv[i + 1] ?? '').toLowerCase() : 'health';
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

// 1. the stored map
const { data: setting, error: sErr } = await sb
  .from('app_settings')
  .select('value, updated_at')
  .eq('key', 'payment_catalog.departments.builtin_subs')
  .maybeSingle();
if (sErr) {
  console.error('app_settings', sErr.message);
  process.exit(1);
}
console.log('=== builtin_subs (app_settings) ===');
console.log('updated_at:', setting?.updated_at ?? '(row absent)');
const map = (setting?.value ? JSON.parse(String(setting.value)) : {}) as Record<string, Array<{ key: string; name: string }>>;
for (const [parent, subs] of Object.entries(map)) {
  console.log(`  ${parent}:`);
  for (const s of subs) console.log(`    - ${s.key}  "${s.name}"`);
}
const hits: Array<{ parent: string; key: string; name: string; label: string }> = [];
for (const [parent, subs] of Object.entries(map)) {
  for (const s of subs) {
    if (s.name.toLowerCase().includes(match) || s.key.toLowerCase().includes(match)) {
      const label = parent === 'hogan_smith_law' ? `hsl:${s.key}` : `${parent}:${s.key}`;
      hits.push({ parent, key: s.key, name: s.name, label });
    }
  }
}
console.log(`\nmatching "${match}":`, hits.length ? hits.map((h) => h.label).join(', ') : '(none)');

// 2. master rows + 3. transfer requests, for each hit
const master = await selectAllPaged('global_master_list', 'id, "Department", "Work Email", "Personal Email", off_boarded_at');
const transfers = await selectAllPaged(
  'department_transfer_requests',
  'id, employee_email, employee_work_email, from_department, to_department, status, requested_by, created_at, applied_at, sheet_synced, sheet_sync_error, approver_note',
);
console.log(`\nmaster rows: ${master.length} · transfer requests: ${transfers.length}`);

for (const h of hits) {
  const cell = h.label.toLowerCase();
  const inCell = master.filter((r) => String(r['Department'] ?? '').trim().toLowerCase() === cell);
  console.log(`\n=== ${h.label} ("${h.name}", parent ${h.parent}) ===`);
  console.log(`master rows in this cell: ${inCell.length}`);
  for (const r of inCell) console.log(`  ${r['Work Email'] ?? r['Personal Email']}  off_boarded_at=${r.off_boarded_at ?? '-'}`);

  const tr = transfers.filter((t) => String(t.to_department ?? '').trim().toLowerCase() === cell);
  console.log(`transfer requests targeting it: ${tr.length}`);
  for (const t of tr.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    console.log(
      `  ${String(t.created_at).slice(0, 16)}  ${String(t.status).padEnd(9)} ${t.employee_work_email ?? t.employee_email}  ` +
        `${t.from_department} -> ${t.to_department}  by ${t.requested_by}  applied=${t.applied_at ? String(t.applied_at).slice(0, 16) : '-'}  ` +
        `sheet=${t.sheet_synced} ${t.sheet_sync_error ? '(' + t.sheet_sync_error + ')' : ''}  note=${t.approver_note ?? ''}`,
    );
  }
}

// any transfer targeting a NAMESPACED label that is neither a code HSL team nor a stored data sub?
const known = new Set<string>();
for (const [parent, subs] of Object.entries(map)) for (const s of subs) known.add((parent === 'hogan_smith_law' ? `hsl:${s.key}` : `${parent}:${s.key}`).toLowerCase());
const recentNs = transfers
  .filter((t) => String(t.to_department ?? '').includes(':'))
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  .slice(0, 12);
console.log('\n=== newest 12 transfers to ANY namespaced target ===');
for (const t of recentNs) {
  const to = String(t.to_department).toLowerCase();
  console.log(`  ${String(t.created_at).slice(0, 16)}  ${String(t.status).padEnd(9)} ${t.employee_work_email ?? t.employee_email}  -> ${t.to_department}  sheet=${t.sheet_synced}${known.has(to) ? '  [DATA sub]' : ''}`);
}

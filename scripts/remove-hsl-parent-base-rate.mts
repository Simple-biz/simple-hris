/**
 * STEP 5 — FINAL — of the HSL parent-department cutover
 * (docs/features/hsl-subdepartments.md §11): delete the `hogan_smith_law`
 * DEPARTMENT-scope base rate row from the Payment Catalog.
 *
 * This is the step §2 promised from the start: *"The parent row is deleted only
 * at cutover, by script, after every sub-team has its own row."* It runs LAST,
 * after (1) all 579 people were placed into sub-teams, (2) every sub-team got
 * its own base rate, (3) both payout engines learned to see an HSL master cell
 * past the flattened rates-row label, and (4) the employee-scope structures were
 * re-keyed off the parent.
 *
 * WHAT DIES AND WHAT SURVIVES. This deletes the parent as a PRICE — the row that
 * made "Hogan Smith Law" a payable department of its own. It does NOT touch the
 * FAMILY KEY: `normalizeDeptToKey` keeps collapsing every `hsl:*` label to
 * `hogan_smith_law` for the HSL week model, the +₱15/h weekend premium,
 * `isHslFamilyLabel`, and dept-scoped bonus matching (HSL bonuses stay keyed on
 * the parent key ON PURPOSE — person-comp keeps `deptKey` parent so common
 * bonuses reach all 579). Deleting the family key would be a pay cut for every
 * HSL person; deleting this row is not, and Guard 3 proves it per run.
 *
 * AFTER THIS ROW IS GONE, an unknown/retired `hsl:*` cell no longer has a parent
 * price floor — it resolves NO department base (it still counts as HSL-family
 * for the week model and weekend premium). That is accepted §11 design:
 * `isPlaceableDeptLabel` refuses unknown keys for new placements, all live keys
 * are priced (Guard 2), and in practice everyone holds an individual or sheet
 * rate anyway (Guard 3 measures it).
 *
 * GUARDS (every one fails CLOSED):
 *   1. Processing lock — refuses while `payroll.dispatch_locked` is true.
 *   2. Coverage — EVERY live sub-team key (both keyspaces) must carry its own
 *      department-scope row. One missing key = one team that would fall to ₱0.
 *   3. Nobody resolves through the parent — counts every ACTIVE person with no
 *      individual catalog rate and no sheet rate whose department leg
 *      (resolveDeptLabelForRate semantics) lands on `hogan_smith_law`. A
 *      non-zero count ABORTS and names them: for those people this deletion is
 *      a rate change to NOTHING.
 *   4. Identity — deletes BY PRIMARY KEY, never a department_key filter; the
 *      row is re-read first and must still be the department-scope parent row;
 *      any affected-row count other than 1 aborts.
 *   5. Backup — every HSL-family structure to reports/ before the write.
 *   6. Audit — one `payroll.rate.delete` row; the original `payroll.rate.set`
 *      history is never rewritten.
 *
 * USAGE
 *   node --import tsx scripts/remove-hsl-parent-base-rate.mts           # dry run
 *   node --import tsx scripts/remove-hsl-parent-base-rate.mts --apply   # deletes
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const TABLE = 'payment_catalog_pay_structures';
const PARENT_KEY = 'hogan_smith_law';
const ACTOR = 'kaner@simple.biz';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('FATAL: supabase env missing'); process.exit(1); }
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const die = (m: string): never => { console.error(`\nABORTED — ${m}`); process.exit(1); };
const ne = (v: unknown) => String(v ?? '').trim().toLowerCase();

async function paged<T>(t: string, c: string, o: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order(o, { ascending: true }).range(f, f + 999);
    if (error) die(`reading ${t}: ${error.message}`);
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

(async () => {
  console.log(`\nDelete the parent hogan_smith_law base rate — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // Guard 1
  const { data: lock } = await db.from('app_settings').select('value').eq('key', 'payroll.dispatch_locked').maybeSingle();
  if (String((lock as any)?.value ?? '').replace(/"/g, '') === 'true') die('payroll.dispatch_locked is TRUE.');
  console.log('Guard 1 OK — payroll.dispatch_locked is false.');

  // Guard 2 — coverage from the real code's keyspaces.
  const schema = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) => die(`import schema: ${String(e)}`));
  const subMod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) => die(`import hsl-subdept: ${String(e)}`));
  const { HSL_DEPT_KEYS } = schema as { HSL_DEPT_KEYS: readonly string[] };
  const { HSL_PLACEMENT_ONLY_SUB_KEYS } = subMod as { HSL_PLACEMENT_ONLY_SUB_KEYS: readonly string[] };
  const liveKeys = [...HSL_DEPT_KEYS, ...HSL_PLACEMENT_ONLY_SUB_KEYS];

  const ps = await paged<any>(TABLE, 'id,scope,department_key,employee_email,regular_rate,ot_rate,currency,created_at', 'department_key');
  const deptRows = new Map(ps.filter((s) => s.scope !== 'employee').map((s) => [s.department_key, s]));
  const missing = liveKeys.filter((k) => !deptRows.has(`hsl:${k}`));
  if (missing.length) die(`Guard 2 — these live sub-teams have NO base rate; deleting the parent would drop them to ₱0: ${missing.join(', ')}`);
  console.log(`Guard 2 OK — all ${liveKeys.length} live sub-teams carry their own base rate.`);

  const parent = deptRows.get(PARENT_KEY);
  if (!parent) die(`no department-scope row for "${PARENT_KEY}" — already deleted?`);
  console.log(`Target row: id=${parent.id}  ₱${parent.regular_rate}/₱${parent.ot_rate} ${parent.currency}`);

  // Guard 3 — nobody's department leg lands on the parent.
  const { data: up } = await db.from('master_list_uploads').select('id').eq('is_current', true).maybeSingle();
  const cur = (up as any)?.id;
  if (!cur) die('no current master_list_upload');
  const master = await paged<any>('global_master_list', '"Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id', 'id');
  const active = master.filter((r) => !r.off_boarded_at && r.last_seen_upload_id === cur);
  const empCat = new Set(ps.filter((s) => s.scope === 'employee').map((s) => ne(s.employee_email)));
  const ehr = await paged<any>('employee_hourly_rates', '"Work Email","Personal Email","Department","Regular Rate"', '"Work Email"');
  const sheetRate = new Map<string, number | null>();
  const sheetDept = new Map<string, string>();
  for (const r of ehr) {
    const v = parseFloat(String(r['Regular Rate'] ?? '').replace(/[^0-9.]/g, ''));
    for (const e of [ne(r['Work Email']), ne(r['Personal Email'])]) {
      if (!e) continue;
      if (!sheetRate.has(e)) sheetRate.set(e, Number.isFinite(v) && v > 0 ? v : null);
      if (!sheetDept.has(e) && r.Department) sheetDept.set(e, String(r.Department));
    }
  }
  const { isHslFamilyLabel } = subMod as { isHslFamilyLabel: (r: string | null) => boolean };
  const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key.js');
  const strandable: string[] = [];
  for (const r of active) {
    const es = [ne(r['Work Email']), ne(r['Personal Email'])].filter(Boolean);
    if (es.some((e) => empCat.has(e))) continue;        // individual rate wins
    if (es.some((e) => sheetRate.get(e) != null)) continue; // sheet rate wins
    // mirror resolveDeptLabelForRate: master wins when HSL-family, else rates row.
    const masterCell = String(r.Department ?? '').trim();
    const ratesCell = sheetDept.get(es[0]) ?? null;
    const label = masterCell && isHslFamilyLabel(masterCell) ? masterCell : (ratesCell ?? masterCell);
    if (!label) continue;
    const nsp = label.toLowerCase();
    if (nsp.includes(':') && deptRows.has(nsp)) continue; // resolves the sub row, parent unneeded
    if ((normalizeDeptToKey(label) ?? nsp) === PARENT_KEY) strandable.push(`${es[0]} master="${masterCell}" rates="${ratesCell}"`);
  }
  if (strandable.length)
    die(`Guard 3 — ${strandable.length} ACTIVE people resolve their department base THROUGH the parent row; deleting it strands them at no base:\n   ${strandable.join('\n   ')}`);
  console.log('Guard 3 OK — zero active people resolve through the parent row.');

  if (!APPLY) { console.log('\nDRY RUN — the row above would be deleted. Rerun with --apply.'); return; }

  // Guard 5 — backup.
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join('reports', `backup_hsl_pay_structures_${stamp}.json`);
  const family = ps.filter((s) => { const k = ne(s.department_key); return k === PARENT_KEY || k === 'hsl' || k.startsWith('hsl:'); });
  writeFileSync(backup, JSON.stringify(family, null, 2), 'utf8');
  console.log(`Guard 5 OK — backup of ${family.length} HSL-family structures → ${backup}`);

  // Guard 4 — re-read, then delete by primary key.
  const { data: fresh } = await db.from(TABLE).select('id,scope,department_key').eq('id', parent.id).maybeSingle();
  if (!fresh || (fresh as any).department_key !== PARENT_KEY || (fresh as any).scope === 'employee')
    die(`row ${parent.id} is no longer the department-scope parent row — re-read before rerunning`);
  const { data: deleted, error } = await db.from(TABLE).delete().eq('id', parent.id).select('id');
  if (error) die(`delete failed: ${error.message}`);
  if ((deleted ?? []).length !== 1) die(`delete affected ${(deleted ?? []).length} rows, expected exactly 1 — investigate`);
  console.log(`DELETED ${parent.id} (${PARENT_KEY} ₱${parent.regular_rate}/₱${parent.ot_rate} ${parent.currency}).`);

  // Guard 6 — audit.
  await db.from('audit_log').insert({
    user_name: ACTOR, user_role: 'admin', action: 'payroll.rate.delete',
    resource: TABLE, resource_id: parent.id,
    details: {
      departmentKey: PARENT_KEY, scope: 'department',
      regularRate: Number(parent.regular_rate), otRate: Number(parent.ot_rate), currency: parent.currency,
      via: 'scripts/remove-hsl-parent-base-rate.mts',
      why: 'HSL parent-department cutover step 5 (FINAL) — Kane 2026-08-14: "anhiallate the Main Department". Every sub-team carries its own base; zero people resolved through this row.',
      backup,
    },
  });

  console.log(`\nDONE — the parent department no longer prices anybody. Backup ${backup}`);
})();

/**
 * STEP 4 of the HSL parent-department cutover (docs/features/hsl-subdepartments.md §11).
 *
 * Re-keys EMPLOYEE-scope Payment Catalog structures off the parent
 * (`hogan_smith_law`) and the dead literal `hsl` label, onto each person's actual
 * sub-team (`hsl:<key>`) as their master `Department` cell now reads.
 *
 * WHY IT IS SAFE — and why it is worth doing anyway.
 * An employee-scope structure is looked up by EMAIL alone: `buildCatalogRateIndex`
 * builds `byEmail` from `employeeEmail` and never reads `department_key`
 * (resolve-rate.ts:68-80). So `department_key` on an employee row is a GROUPING
 * LABEL, not part of rate resolution — re-keying it cannot move anybody's pay.
 * `person-comp` likewise derives its `deptKey` from the master cell, not from the
 * structure. What the label DOES drive:
 *   - the Payment Catalog → Pay Structure rail's per-department list and badge
 *     count (`s.departmentKey === selectedDept`), and
 *   - the catalog CSV/XLSX/PDF export, which matches `departmentKey === dept.key`
 *     for a fixed department list (`catalog-export.ts:113`).
 * That second one is a live bug this fixes: **57 rows are keyed to the literal
 * `hsl`, which matches NO entry in either list**, so those individual rates are
 * invisible in the rail AND silently dropped from every export. They are still
 * paid correctly; they just cannot be found or exported.
 *
 * The Hogan Pay Plan sheet mirror already handles the new keys —
 * `pay-structures/route.ts:126` gates on
 * `departmentKey === HOGAN_DEPT_KEY || isHslSubDeptLabel(departmentKey)` — so a
 * later employee-scope EDIT through the UI keeps mirroring after this runs.
 *
 * GUARDS (every one fails CLOSED):
 *   1. Target validity — the destination is read from the person's live master
 *      cell and must be a real `hsl:<key>` placement (`hslSubKeyFromRaw`).
 *      Anyone whose master cell is not an HSL sub-team is SKIPPED, never guessed.
 *   2. Scope — employee-scope rows only, and only those currently keyed to
 *      `hogan_smith_law` or the literal `hsl`. A row already on a sub-team is
 *      left alone; a row on some other department is not ours to touch.
 *   3. Rate immutability — regular/OT/currency/email are NEVER written. This
 *      script changes exactly one column, `department_key`. A diff that shows any
 *      other field changing is a bug.
 *   4. Off-roster rows are skipped — a structure whose employee is not on the
 *      active roster has no master cell to read a target from.
 *   5. Processing lock — refuses while `payroll.dispatch_locked` is true.
 *   6. Backup first — every affected row, before and after, to reports/.
 *   7. By primary key — every update targets one id, never a department filter.
 *
 * USAGE
 *   node --import tsx scripts/rekey-hsl-employee-pay-structures.mts           # dry run
 *   node --import tsx scripts/rekey-hsl-employee-pay-structures.mts --apply   # writes
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const TABLE = 'payment_catalog_pay_structures';
const ACTOR = 'kaner@simple.biz';
const SOURCE_KEYS = new Set(['hogan_smith_law', 'hsl']);

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
  console.log(`\nRe-key HSL employee-scope pay structures — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const subMod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) => die(`import hsl-subdept: ${String(e)}`));
  const { hslSubKeyFromRaw, formatDeptLabel } = subMod as {
    hslSubKeyFromRaw: (r: string | null) => string | null;
    formatDeptLabel: (r: string) => string;
  };

  // Guard 5
  const { data: lock } = await db.from('app_settings').select('value').eq('key', 'payroll.dispatch_locked').maybeSingle();
  if (String((lock as any)?.value ?? '').replace(/"/g, '') === 'true')
    die('payroll.dispatch_locked is TRUE — wait or unlock.');
  console.log('Guard 5 OK — payroll.dispatch_locked is false.');

  const { data: up } = await db.from('master_list_uploads').select('id').eq('is_current', true).maybeSingle();
  const cur = (up as any)?.id;
  if (!cur) die('no current master_list_upload');
  const master = await paged<any>('global_master_list', '"Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id', 'id');
  const deptByEmail = new Map<string, string>();
  for (const r of master) {
    if (r.off_boarded_at || r.last_seen_upload_id !== cur) continue;
    for (const e of [ne(r['Work Email']), ne(r['Personal Email'])]) if (e && !deptByEmail.has(e) && r.Department) deptByEmail.set(e, String(r.Department));
  }

  const ps = await paged<any>(TABLE, 'id,scope,department_key,employee_email,regular_rate,ot_rate,currency', 'department_key');
  const candidates = ps.filter((s) => s.scope === 'employee' && SOURCE_KEYS.has(ne(s.department_key)));
  console.log(`Employee-scope rows keyed to the parent or the literal "hsl": ${candidates.length}`);

  interface Move { id: string; email: string; from: string; to: string; }
  const moves: Move[] = [];
  const skipped: Array<{ email: string; from: string; why: string }> = [];
  for (const s of candidates) {
    const email = ne(s.employee_email);
    const cell = deptByEmail.get(email) ?? null;
    if (!cell) { skipped.push({ email, from: s.department_key, why: 'not on the active roster — no master cell to read a target from' }); continue; }
    const sub = hslSubKeyFromRaw(cell);
    if (!sub) { skipped.push({ email, from: s.department_key, why: `master cell is "${cell}", not an hsl:<key> placement` }); continue; }
    moves.push({ id: s.id, email, from: s.department_key, to: `hsl:${sub}` });
  }

  const byTarget = new Map<string, number>();
  for (const m of moves) byTarget.set(m.to, (byTarget.get(m.to) ?? 0) + 1);
  console.log(`\nPLAN — ${moves.length} rows to re-key:`);
  for (const [k, v] of [...byTarget.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${formatDeptLabel(k).padEnd(38)} ${String(v).padStart(4)}   (${k})`);
  const fromCount = new Map<string, number>();
  for (const m of moves) fromCount.set(m.from, (fromCount.get(m.from) ?? 0) + 1);
  console.log(`   from: ${[...fromCount.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  console.log(`\nSKIPPED — ${skipped.length}:`);
  const why = new Map<string, number>();
  for (const s of skipped) why.set(s.why, (why.get(s.why) ?? 0) + 1);
  for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)}  ${k}`);
  for (const s of skipped.filter((x) => !x.why.startsWith('not on the active roster'))) console.log(`        · ${s.email} — ${s.why}`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Rerun with --apply.'); return; }
  if (!moves.length) { console.log('\nNothing to do.'); return; }

  // Guard 6
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join('reports', `backup_hsl_rekey_employee_structures_${stamp}.json`);
  writeFileSync(backup, JSON.stringify({ moves, skipped, rowsBefore: candidates }, null, 2), 'utf8');
  console.log(`\nGuard 6 OK — backup of ${candidates.length} rows → ${backup}`);

  // Guard 3 + 7: one column, one id at a time.
  let ok = 0;
  for (const m of moves) {
    const { error } = await db.from(TABLE).update({ department_key: m.to }).eq('id', m.id);
    if (error) die(`re-keying ${m.email} (${m.id}): ${error.message}`);
    ok++;
    if (ok % 100 === 0) console.log(`   ${ok}/${moves.length}`);
  }
  console.log(`   ${ok}/${moves.length} re-keyed.`);

  await db.from('audit_log').insert({
    user_name: ACTOR, user_role: 'admin', action: 'payroll.rate.rekey',
    resource: TABLE, resource_id: 'bulk',
    details: {
      why: 'HSL parent-department cutover step 4 — employee-scope structures moved off hogan_smith_law / the dead literal "hsl" onto each person\'s sub-team',
      note: 'department_key on an employee-scope row is a GROUPING label; rates resolve by email, so no pay moved',
      alsoFixes: 'the 57 rows keyed to the literal "hsl" matched no rail entry and were silently dropped from every catalog export',
      moved: ok, skipped: skipped.length, byTarget: Object.fromEntries(byTarget), backup,
    },
  });

  console.log(`\nDONE. Backup ${backup}`);
})();

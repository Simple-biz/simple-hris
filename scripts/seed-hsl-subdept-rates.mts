/**
 * STEP 2 of the HSL parent-department cutover (docs/features/hsl-subdepartments.md §11).
 * The `seed-hsl-subdept-rates.mts` §8 has listed as missing since 2026-08-10.
 *
 * Seeds a department-scope Payment Catalog base rate for every HSL sub-team, so
 * the parent `hogan_smith_law` base row can be deleted (step 5) without leaving
 * anyone resolving ₱0. §2's "the parent fallback is permanent … the parent row is
 * deleted only at cutover, by script, AFTER every sub-team has its own row" is
 * exactly this precondition.
 *
 * THE FIGURES ARE THE MODAL EFFECTIVE RATE of each team's current members —
 * proposed to Kane 2026-08-14 with the per-team evidence and approved with
 * "lets go and migrate". They are a BASE, not anybody's pay: the base applies
 * only to someone with neither an individual catalog rate nor a sheet rate.
 * Measured at seed time: **zero of the 579 HSL people resolve the department
 * base**, so this seed reprices nobody. It is the floor for future hires and for
 * anyone whose rates-sheet row goes missing in a given week.
 *
 * TWO FIGURES WORTH A SECOND LOOK (flagged to Kane, seeded as the data reads):
 *   - `medical_records` ₱175 — all 10 members sit there, but ₱175 is the old Lead
 *     Gen rate and is BELOW the HSL parent ₱225. They arrived by transfer from
 *     Lead Gen on 2026-08-14 and may simply not have been repriced yet.
 *   - `hsl_managers` ₱500 — n=1 (Gyd). A base of ₱500 would apply to any future
 *     manager placed there.
 *
 * OT is `regular × 1.5`, matching the parent ₱225/₱337.50. For HSL the stored OT
 * rate never moves money — pay is the Hogan sheet's column AN and OT is a derived
 * differential (docs/features/hsl-weekend-ot-pay.md) — so this is the audit figure
 * the amber `ot_ratio` check expects.
 *
 * WHAT THIS MIRRORS: exactly what Accounting → Payment Catalog → Pay Structure
 * writes for a DEPARTMENT-scope save (`upsertPayStructure`). Department-scope
 * saves deliberately do NOT touch `employee_rate_history`, the rates sheet, the
 * Hogan Pay Plan sheet, or notifications — those are employee-scope side effects
 * only (pay-structures/route.ts:205). This does none of them. It DOES write one
 * audit row per key, which the UI omits for dept saves.
 *
 * GUARDS (every one fails CLOSED):
 *   1. Key validity — every target imported from HSL_DEPT_KEYS +
 *      HSL_PLACEMENT_ONLY_SUB_KEYS, and must pass `isPlaceableDeptLabel`.
 *   2. Coverage — refuses to run unless EVERY live sub-team key is either being
 *      seeded or already priced. A partial seed is what makes step 5 unsafe.
 *   3. Occupied slot — refuses to overwrite an existing department-scope row.
 *      Changing an existing base is a rate CHANGE for whoever rides it.
 *   4. Nobody repriced — for each target key, counts the people who ACTUALLY
 *      resolve the department base today (no individual catalog rate, no sheet
 *      rate). Any such person would move from the parent ₱225 to the new figure,
 *      so a non-zero count ABORTS and names them.
 *   5. Processing lock — refuses while `payroll.dispatch_locked` is true.
 *   6. Backup first — every HSL-family structure to reports/ before any write.
 *
 * USAGE
 *   node --import tsx scripts/seed-hsl-subdept-rates.mts           # dry run
 *   node --import tsx scripts/seed-hsl-subdept-rates.mts --apply   # writes
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const TABLE = 'payment_catalog_pay_structures';
const ACTOR = 'kaner@simple.biz';
const PARENT_KEY = 'hogan_smith_law';
const CURRENCY = 'PHP';

/** sub-team key → regular base. Modal effective rate of the team's members. */
const SEED: Record<string, number> = {
  intake_specialist: 225,
  filing_specialist: 235,
  case_managers: 305,
  ssd_medical_records: 265,
  attestation: 235,
  executive_guest_services: 355,
  callback_team: 225,
  collections: 265,
  post_hearing_prep: 265,
  medical_records: 175,
  hearing_prep_mail_sorting: 265,
  care_team: 265,
  executive_assistants: 265,
  healthcare_team_lead: 355,
  hsl_managers: 500,
  // simple_texting already carries ₱225/₱337.50 (Kane, 2026-08-12) — Guard 3
  // skips it rather than re-writing it.
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('FATAL: need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const die = (msg: string): never => { console.error(`\nABORTED — ${msg}`); process.exit(1); };
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
  console.log(`\nHSL sub-department base rates — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // ── Guard 1 + 2: keys ──────────────────────────────────────────────────────
  const schema = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) => die(`import schema: ${String(e)}`));
  const subMod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) => die(`import hsl-subdept: ${String(e)}`));
  const { HSL_DEPT_KEYS } = schema as { HSL_DEPT_KEYS: readonly string[] };
  const { HSL_PLACEMENT_ONLY_SUB_KEYS, isPlaceableDeptLabel, formatDeptLabel } = subMod as {
    HSL_PLACEMENT_ONLY_SUB_KEYS: readonly string[];
    isPlaceableDeptLabel: (r: string) => boolean;
    formatDeptLabel: (r: string) => string;
  };
  const liveKeys = [...HSL_DEPT_KEYS, ...HSL_PLACEMENT_ONLY_SUB_KEYS];
  for (const k of Object.keys(SEED)) {
    if (!liveKeys.includes(k)) die(`"${k}" is not a live HSL sub-team key — add it to the code first`);
    if (!isPlaceableDeptLabel(`hsl:${k}`)) die(`"hsl:${k}" is not placeable`);
  }
  console.log(`Guard 1 OK — ${Object.keys(SEED).length} target keys, all live + placeable.`);

  // ── Guard 5: processing lock ───────────────────────────────────────────────
  const { data: lock } = await db.from('app_settings').select('value').eq('key', 'payroll.dispatch_locked').maybeSingle();
  const locked = String((lock as any)?.value ?? '').replace(/"/g, '') === 'true';
  if (locked) die('payroll.dispatch_locked is TRUE — a catalog edit mid-run can desync staged amounts. Unlock or wait.');
  console.log('Guard 5 OK — payroll.dispatch_locked is false.');

  // ── read catalog ───────────────────────────────────────────────────────────
  const ps = await paged<any>(TABLE, 'id,scope,department_key,employee_email,regular_rate,ot_rate,currency', 'department_key');
  const deptRows = new Map(ps.filter((s) => s.scope !== 'employee').map((s) => [s.department_key, s]));
  const parent = deptRows.get(PARENT_KEY);
  if (!parent) die(`no department-scope row for "${PARENT_KEY}" — this script runs BEFORE the parent is deleted`);
  console.log(`Parent base: ₱${parent.regular_rate} / ₱${parent.ot_rate} ${parent.currency}`);

  // Guard 2 — coverage: every live key must end up priced.
  const uncovered = liveKeys.filter((k) => SEED[k] == null && !deptRows.has(`hsl:${k}`));
  if (uncovered.length)
    die(`Guard 2 — these live sub-teams would still have NO base rate, which makes deleting the parent unsafe: ${uncovered.join(', ')}`);
  console.log(`Guard 2 OK — all ${liveKeys.length} live sub-teams will be priced.`);

  // Guard 3 — occupied slots are skipped, never overwritten.
  const todo = Object.entries(SEED).filter(([k]) => {
    if (deptRows.has(`hsl:${k}`)) { console.log(`   SKIP hsl:${k} — already priced ₱${deptRows.get(`hsl:${k}`).regular_rate}`); return false; }
    return true;
  });
  console.log(`Guard 3 OK — ${todo.length} to seed, ${Object.keys(SEED).length - todo.length} already priced.`);

  // ── Guard 4: nobody repriced ───────────────────────────────────────────────
  const { data: up } = await db.from('master_list_uploads').select('id').eq('is_current', true).maybeSingle();
  const cur = (up as any)?.id;
  const master = await paged<any>('global_master_list', '"Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id', 'id');
  const active = master.filter((r) => !r.off_boarded_at && r.last_seen_upload_id === cur);
  const empCat = new Set(ps.filter((s) => s.scope === 'employee').map((s) => ne(s.employee_email)));
  const ehr = await paged<any>('employee_hourly_rates', '"Work Email","Personal Email","Regular Rate"', '"Work Email"');
  const sheetRate = new Map<string, number | null>();
  for (const r of ehr) {
    const v = parseFloat(String(r['Regular Rate'] ?? '').replace(/[^0-9.]/g, ''));
    for (const e of [ne(r['Work Email']), ne(r['Personal Email'])]) if (e && !sheetRate.has(e)) sheetRate.set(e, Number.isFinite(v) && v > 0 ? v : null);
  }
  const repriced: string[] = [];
  for (const r of active) {
    const dept = String(r.Department ?? '').trim().toLowerCase();
    if (!dept.startsWith('hsl:')) continue;
    const key = dept.slice(4);
    if (SEED[key] == null) continue;
    const es = [ne(r['Work Email']), ne(r['Personal Email'])].filter(Boolean);
    if (es.some((e) => empCat.has(e))) continue;
    if (es.some((e) => sheetRate.get(e) != null)) continue;
    repriced.push(`${es[0]} (${dept}) ₱${parent.regular_rate} → ₱${SEED[key]}`);
  }
  if (repriced.length)
    die(`Guard 4 — ${repriced.length} people ACTUALLY resolve the department base and would be repriced by this seed:\n   ${repriced.join('\n   ')}\n   That is a rate CHANGE. Decide it explicitly before seeding.`);
  console.log('Guard 4 OK — zero people currently resolve the department base; this seed reprices nobody.');

  console.log(`\nPLAN:`);
  for (const [k, reg] of todo) console.log(`   ${formatDeptLabel(`hsl:${k}`).padEnd(38)} ₱${String(reg).padStart(5)} / ₱${(reg * 1.5).toFixed(2).padStart(7)} ${CURRENCY}`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Rerun with --apply.'); return; }
  if (!todo.length) { console.log('\nNothing to seed.'); return; }

  // ── Guard 6: backup, then write ────────────────────────────────────────────
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join('reports', `backup_hsl_pay_structures_${stamp}.json`);
  const hslFamily = ps.filter((s) => {
    const k = ne(s.department_key);
    return k === PARENT_KEY || k === 'hsl' || k.startsWith('hsl:');
  });
  writeFileSync(backup, JSON.stringify(hslFamily, null, 2), 'utf8');
  console.log(`\nGuard 6 OK — backup of ${hslFamily.length} HSL-family structures → ${backup}`);

  for (const [k, reg] of todo) {
    const id = randomUUID();
    const row = {
      id, scope: 'department', department_key: `hsl:${k}`, employee_email: null,
      regular_rate: reg, ot_rate: Number((reg * 1.5).toFixed(2)), currency: CURRENCY,
      created_by: ACTOR, updated_by: ACTOR,
    };
    const { error } = await db.from(TABLE).insert(row);
    if (error) die(`inserting hsl:${k}: ${error.message}`);
    await db.from('audit_log').insert({
      user_name: ACTOR, user_role: 'admin', action: 'payroll.rate.set',
      resource: TABLE, resource_id: id,
      details: {
        departmentKey: `hsl:${k}`, scope: 'department', regularRate: reg, otRate: Number((reg * 1.5).toFixed(2)),
        currency: CURRENCY, via: 'scripts/seed-hsl-subdept-rates.mts',
        why: 'HSL parent-department cutover step 2 — base per sub-team so the parent row can be deleted without anyone resolving ₱0',
        basis: 'modal effective rate of the team members, approved by Kane 2026-08-14', repricedNobody: true,
      },
    });
    console.log(`   seeded hsl:${k}  ₱${reg} / ₱${(reg * 1.5).toFixed(2)} ${CURRENCY}`);
  }
  console.log(`\nDONE. ${todo.length} seeded. Backup ${backup}`);
})();

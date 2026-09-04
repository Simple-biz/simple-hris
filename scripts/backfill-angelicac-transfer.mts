/**
 * Backfill the HRIS department transfer that was never filed for
 * Concepcion, Angelica "Angel" — angelicac@simple.biz — Lead Gen → hsl:collections.
 *
 * WHY (probed read-only 2026-09-04): her master-list row AND the master Google Sheet
 * both read "Lead Gen", `department_transfer_requests` holds nothing for her, and the
 * audit log shows no department change. Meanwhile the Hogan roster sheet has carried
 * her as Collections ("Lila", ₱265) since 2026-05-06, the rates sheet as Hogan Smith
 * Law since 2026-04-07, the Payment Catalog (carla@, 2026-06-15) keyed her row to
 * hogan_smith_law, and Carla/Alissa have scored her under Collections since July.
 * The Payroll Wizard stamps the paystub department from the master list, so every
 * stub says Lead Gen. Under Kane's 2026-08-21 ruling the HRIS is the department
 * source of truth, so the fix is an HRIS transfer — this script files and applies
 * one through the SAME helpers the Release / "Apply now" path uses
 * (`applyDepartmentTransfer` → `updateMasterSheetDepartment` → `markTransferApplied`),
 * so the master list, the Sheet cell and the transfer record move together.
 *
 * SAFE BY DEFAULT: dry run prints the plan and writes a JSON backup of every row it
 * would touch to references/backups/. Re-run with --apply to write. Idempotent: if
 * the row already reads hsl:collections and an applied transfer exists, it reports
 * "converged" and exits 0.
 *
 *   npx tsx scripts/backfill-angelicac-transfer.mts                        # dry run
 *   npx tsx scripts/backfill-angelicac-transfer.mts --apply                # write
 *     --effective YYYY-MM-DD   effective/proposed date on the record (default 2026-06-22,
 *                              the date Accounting's ₱265 Payment Catalog rate took effect)
 *     --notify                 also insert the transfer.applied notifications the UI path
 *                              sends (to the employee and to kaner@). Off by default.
 *
 * GUARDS (all fail closed):
 *   G1 target is a placeable HSL sub-team and `collections` owns a calculator
 *   G2 exactly ONE active master row for her, reading exactly "Lead Gen"
 *   G3 zero existing transfer requests for her under any email
 *   G4 the live master Google Sheet has exactly one row for her, reading "Lead Gen"
 *      (a DB write the Sheet disagrees with is a pending clobber — hsl-subdepartments.md §9 Guard 8)
 *   G5 the Hogan KPI roster (hsl_team_members) already places her on `collections`
 *      (the target is read from evidence, never guessed)
 *
 * OUT OF SCOPE (reported, not written): her Payment Catalog employee row stays keyed
 * to the deleted parent `hogan_smith_law` (re-key = separate decision). Paid stubs stay
 * frozen; a locked-but-unsent stub only re-stages on an unlock + re-lock, and the first
 * stub to carry the new department is the first cycle LOCKED after this applies.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const NOTIFY = process.argv.includes('--notify');
const effIdx = process.argv.indexOf('--effective');
const EFFECTIVE = effIdx >= 0 ? (process.argv[effIdx + 1] ?? '') : '2026-06-22';
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE)) {
  console.error(`--effective must be YYYY-MM-DD, got "${EFFECTIVE}"`);
  process.exit(1);
}

const WORK = 'angelicac@simple.biz';
const FROM = 'Lead Gen';
const TO = 'hsl:collections';
const TO_SUBKEY = 'collections';
const ACTOR = 'kaner@simple.biz';
const REASON =
  `Backfill filed ${new Date().toISOString().slice(0, 10)} by ${ACTOR}: the move to HSL — Collections was made on the Hogan roster sheet, ` +
  `the rates sheet and the Payment Catalog but never in the HRIS, so every paystub still read Lead Gen. ` +
  `Effective date ${EFFECTIVE} = the date Accounting's ₱265 Payment Catalog rate took effect.`;

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { applyDepartmentTransfer, markTransferApplied } = await import('../src/lib/supabase/department-transfer-requests');
const { updateMasterSheetDepartment } = await import('../src/lib/google-sheets/update-master-sheet-department');
const { fetchMasterSheetAsCsv } = await import('../src/lib/google-sheets/fetch-master-sheet');
const { parseCsv } = await import('../src/lib/csv/parse-csv');
const { isPlaceableDeptLabel, formatDeptLabel } = await import('../src/lib/departments/hsl-subdept');
const { HSL_DEPT_KEYS } = await import('../src/lib/hsl-bonus/schema');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase service-role client unavailable — check .env.local');
  process.exit(1);
}
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const die = (msg: string): never => {
  console.error(`\nABORT — ${msg}`);
  process.exit(2);
};

type MasterRow = {
  id: string;
  Name: string | null;
  Department: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  off_boarded_at: string | null;
  last_seen_upload_id: string | null;
};

console.log(
  `${APPLY ? 'APPLY MODE' : 'DRY RUN (re-run with --apply to write)'} — ${WORK}: "${FROM}" → "${TO}" (${formatDeptLabel(TO)}), effective ${EFFECTIVE}, notify=${NOTIFY}\n`,
);

// G1 — target validity
if (!isPlaceableDeptLabel(TO)) die(`G1: "${TO}" is not a placeable department label`);
if (!(HSL_DEPT_KEYS as readonly string[]).includes(TO_SUBKEY)) die(`G1: "${TO_SUBKEY}" is not in HSL_DEPT_KEYS`);
console.log('G1 ok — target placeable, owns a calculator');

// G2 — master rows
const { data: masterData, error: mErr } = await sb
  .from('global_master_list')
  .select('id, "Name", "Department", "Work Email", "Personal Email", off_boarded_at, last_seen_upload_id')
  .ilike('Work Email', WORK.replace(/([%_\\])/g, '\\$1'));
if (mErr) die(`G2: master read failed: ${mErr.message}`);
const masterRows = ((masterData ?? []) as MasterRow[]).filter((r) => norm(r['Work Email']) === WORK);
const active = masterRows.filter((r) => !r.off_boarded_at);
console.log(
  `G2 master rows: ${masterRows.length} total, ${active.length} active →`,
  active.map((r) => `${r.id} "${r.Department}"`).join(' | '),
);
if (active.length !== 1) die(`G2: expected exactly 1 active master row, found ${active.length}`);
const master = active[0];
const personal = norm(master['Personal Email']) || null;

// G3 — no existing transfer request
const ors = [`employee_email.ilike.${WORK}`, `employee_work_email.ilike.${WORK}`];
if (personal) ors.push(`employee_email.ilike.${personal}`, `employee_personal_email.ilike.${personal}`);
const { data: trData, error: tErr } = await sb
  .from('department_transfer_requests')
  .select('id, status, from_department, to_department, applied_at, created_at')
  .or(ors.join(','));
if (tErr) die(`G3: transfer read failed: ${tErr.message}`);
const transfers = trData ?? [];
console.log(`G3 existing transfer requests: ${transfers.length}`);

if (master.Department === TO && transfers.some((t) => t.status === 'applied' && t.to_department === TO)) {
  console.log('\nCONVERGED — master already reads the target and an applied transfer exists. Nothing to do.');
  process.exit(0);
}
if (master.Department !== FROM) die(`G2: active master row reads "${master.Department}", expected "${FROM}"`);
if (transfers.length !== 0) {
  die(`G3: ${transfers.length} transfer request(s) already exist — resolve those first: ${JSON.stringify(transfers)}`);
}

// G4 — live Sheet cell
const sheet = await fetchMasterSheetAsCsv();
const rows = parseCsv(sheet.csvText) as string[][];
const hdrIdx = rows.findIndex((r) => {
  const l = r.map(norm);
  return l.includes('department') && l.includes('name');
});
if (hdrIdx < 0) die('G4: could not locate the MASTERLIST header row');
const hdr = rows[hdrIdx].map(norm);
const col = (name: string) => hdr.indexOf(name);
const iDept = col('department');
const iName = col('name');
const iWork = col('work email');
const iPers = col('personal email');
if (iDept < 0 || iWork < 0) die('G4: header lacks Department / Work Email');
const sheetHits = rows
  .slice(hdrIdx + 1)
  .map((r, i) => ({
    rowNumber: hdrIdx + 2 + i,
    name: r[iName],
    dept: r[iDept],
    work: r[iWork],
    personal: iPers >= 0 ? r[iPers] : '',
  }))
  .filter((r) => norm(r.work) === WORK || (personal && norm(r.personal) === personal));
console.log(`G4 sheet rows for her: ${sheetHits.length} →`, JSON.stringify(sheetHits));
if (sheetHits.length !== 1) die(`G4: expected exactly 1 Sheet row, found ${sheetHits.length}`);
if (norm(sheetHits[0].dept) !== norm(FROM)) {
  die(`G4: Sheet cell reads "${sheetHits[0].dept}", expected "${FROM}" — the Sheet disagrees with the DB; a DB write now is a pending clobber`);
}

// G5 — Hogan roster evidence for the target
const { data: roster } = await sb
  .from('hsl_team_members')
  .select('email, hsl_name, role_raw, dept_key, hourly_rate, updated_at')
  .ilike('email', WORK)
  .maybeSingle();
console.log('G5 hsl_team_members:', JSON.stringify(roster));
if (!roster || roster.dept_key !== TO_SUBKEY) {
  die(`G5: roster dept_key is "${roster?.dept_key ?? 'none'}", expected "${TO_SUBKEY}" — the target would be a guess`);
}

// Informational context
const { data: lock } = await sb.from('app_settings').select('value, updated_at').eq('key', 'payroll.dispatch_locked').maybeSingle();
const { data: catalog } = await sb
  .from('payment_catalog_pay_structures')
  .select('id, scope, department_key, regular_rate, ot_rate, currency')
  .ilike('employee_email', WORK);
const { data: unsent } = await sb
  .from('paystub_dispatch_queue')
  .select('cycle_source_file, department_key, locked_at, sent_at')
  .ilike('recipient_email', WORK)
  .is('sent_at', null)
  .not('locked_at', 'is', null)
  .gte('created_at', new Date(Date.now() - 45 * 86400_000).toISOString());
console.log(`\nINFO payroll.dispatch_locked = ${lock?.value ?? '(unset)'} (as of ${lock?.updated_at ?? '—'})`);
console.log('INFO catalog rows (NOT touched):', JSON.stringify(catalog));
console.log('INFO locked-but-unsent stubs, last 45 days (frozen until unlock + re-lock):', JSON.stringify(unsent));

// Backup before any write
mkdirSync('references/backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `references/backups/angelicac_transfer_backfill_${stamp}.json`;
writeFileSync(
  backupPath,
  JSON.stringify(
    { takenAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', effective: EFFECTIVE, masterRows, transfers, sheetRow: sheetHits[0], roster, catalog, lock },
    null,
    2,
  ),
);
console.log(`\nBackup written: ${backupPath}`);

const nowIso = new Date().toISOString();
const insertRow = {
  employee_email: WORK,
  employee_name: master.Name,
  employee_work_email: WORK,
  employee_personal_email: personal,
  from_department: FROM,
  to_department: TO,
  reason: REASON,
  requested_by: ACTOR,
  approver_email: ACTOR,
  approver_note: 'Backfill — released by the admin filing the record; the source-manager Release step never happened in the HRIS.',
  decided_at: nowIso,
  proposed_effective_date: EFFECTIVE,
  effective_date: EFFECTIVE,
  status: 'approved' as const,
};

console.log('\nPLAN');
console.log(`  1. INSERT department_transfer_requests (status approved):\n     ${JSON.stringify(insertRow)}`);
console.log(`  2. applyDepartmentTransfer → master row ${master.id} "${FROM}" → "${TO}"`);
console.log(`  3. updateMasterSheetDepartment → Sheet row ${sheetHits[0].rowNumber} "${FROM}" → "${TO}"`);
console.log('  4. markTransferApplied (status applied, applied_at now, sheet_synced per outcome)');
console.log(`  5. ${NOTIFY ? 'INSERT transfer.applied notifications → ' + [ACTOR, WORK].join(', ') : 'no notifications (--notify to send)'}`);
console.log('  6. INSERT audit_log transfer.backfilled');

if (!APPLY) {
  console.log('\nDRY RUN complete — 0 writes.');
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────────
const { data: ins, error: iErr } = await sb.from('department_transfer_requests').insert(insertRow).select('id').single();
if (iErr || !ins) die(`step 1 insert failed: ${iErr?.message}`);
const requestId = (ins as { id: string }).id;
console.log(`\n1. inserted request ${requestId}`);

const applied = await applyDepartmentTransfer({ personalEmail: personal, workEmail: WORK, fromDepartment: FROM, toDepartment: TO });
console.log('2. master apply:', JSON.stringify(applied));
if (applied.error || applied.resolution !== 'moved' || applied.updated !== 1) {
  die(
    `step 2 did not move exactly one row (${JSON.stringify(applied)}). Request ${requestId} is left "approved" — push it through Manager → Transfers → "Apply now" or investigate.`,
  );
}

let sheetSynced = false;
let sheetError: string | null = null;
try {
  const res = await updateMasterSheetDepartment({ personalEmail: personal, workEmail: WORK, fromDepartment: FROM, toDepartment: TO });
  sheetSynced = res.updated > 0 || res.alreadyTarget === true;
  if (!sheetSynced) sheetError = res.reason ?? 'no matching sheet row updated';
  console.log('3. sheet write-back:', JSON.stringify(res));
} catch (e) {
  sheetError = e instanceof Error ? e.message : String(e);
  console.log('3. sheet write-back THREW:', sheetError);
}

const marked = await markTransferApplied({ id: requestId, sheet_synced: sheetSynced, sheet_sync_error: sheetError });
console.log('4. markTransferApplied:', JSON.stringify(marked));

if (NOTIFY) {
  const who = master.Name ?? WORK;
  const { error: nErr } = await sb.from('employee_notifications').insert(
    [ACTOR, WORK].map((to) => ({
      recipient_email: to,
      type: 'transfer.applied',
      tone: 'positive',
      title: 'Transfer Applied',
      message: `${who} has moved from ${formatDeptLabel(FROM)} to ${formatDeptLabel(TO)} (effective ${EFFECTIVE}).`,
      details: {
        request_id: requestId,
        employee_email: WORK,
        from_department: FROM,
        to_department: TO,
        effective_date: EFFECTIVE,
        sheet_synced: sheetSynced,
        backfill: true,
      },
    })),
  );
  console.log('5. notifications:', nErr ? `FAILED ${nErr.message}` : 'sent');
} else {
  console.log('5. notifications skipped');
}

const { error: aErr } = await sb.from('audit_log').insert({
  user_name: ACTOR,
  user_role: 'admin',
  action: 'transfer.backfilled',
  resource: 'department_transfer_requests',
  resource_id: requestId,
  details: {
    employee_email: WORK,
    from_department: FROM,
    to_department: TO,
    effective_date: EFFECTIVE,
    master_row_id: master.id,
    sheet_row: sheetHits[0].rowNumber,
    sheet_synced: sheetSynced,
    sheet_sync_error: sheetError,
    backup: backupPath,
    script: 'scripts/backfill-angelicac-transfer.mts',
  },
});
console.log('6. audit_log:', aErr ? `FAILED ${aErr.message}` : 'written');

// Verify by re-read
const { data: after } = await sb.from('global_master_list').select('id, "Department", off_boarded_at').eq('id', master.id).maybeSingle();
const { data: req } = await sb
  .from('department_transfer_requests')
  .select('status, applied_at, sheet_synced, sheet_sync_error')
  .eq('id', requestId)
  .maybeSingle();
const sheet2 = await fetchMasterSheetAsCsv();
const rows2 = parseCsv(sheet2.csvText) as string[][];
const cell2 = rows2.slice(hdrIdx + 1).find((r) => norm(r[iWork]) === WORK)?.[iDept];
console.log('\nVERIFY master:', JSON.stringify(after), '| request:', JSON.stringify(req), `| sheet cell: "${cell2}"`);
const ok = after?.Department === TO && req?.status === 'applied' && norm(cell2) === norm(TO);
console.log(
  ok
    ? '\nDONE — master, transfer record and Sheet all read the target.'
    : '\nDONE WITH WARNINGS — see VERIFY line; a Sheet miss shows as "Retry" on Accounting → Transfers.',
);
process.exit(ok ? 0 : 3);

/**
 * Hard-transfer the CEO's Executive Assistants into the in-app department
 * "Executive Assistants" (created 2026-07-24 from Payment Catalog -> Department)
 * ON THE GLOBAL MASTER LIST -- the registry membership already exists; this
 * makes the roster agree ("this should also appear in the global master list").
 *
 *   cjm@simple.biz, ellyt@simple.biz, jamec@simple.biz
 *
 * Per person:
 *   1. UPDATE their active "Executive Assistant to the CEO" master row's
 *      Department -> the registry department's exact name, re-stamping
 *      last_seen_upload_id to the current upload when stale so the row is
 *      visible in active_employees. Rows in OTHER departments (each of the
 *      three also holds a duplicate "HR" row) are left untouched and reported.
 *   2. Flip the matching master Google Sheet "Department" cell (the shipped
 *      updateMasterSheetDepartment helper) so the next Sheet -> Supabase sync
 *      doesn't resurrect the old label. Best-effort; failures are reported.
 * Plus: ensure the department's registry manager (jamec) holds an active
 * department_managers grant for the new department name.
 *
 * SAFE BY DEFAULT: dry-run prints the exact plan and writes a JSON backup of
 * every row it would touch to references/backups/. Re-run with --apply to
 * perform the writes. Idempotent: rows already in the target department are
 * skipped.
 *
 *   npx tsx scripts/transfer-eas-to-executive-assistants.mts           # dry run
 *   npx tsx scripts/transfer-eas-to-executive-assistants.mts --apply   # write
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
// Pure fetch/crypto helper chain (no Next-flavored imports) -- safe under tsx.
// The repo's .ts modules surface as CJS under tsx, so named exports live on
// the default-imported namespace.
import sheetModule from '../src/lib/google-sheets/update-master-sheet-department';
const { updateMasterSheetDepartment } = sheetModule as unknown as typeof import('../src/lib/google-sheets/update-master-sheet-department');

dotenv.config({ path: '.env.local' });

const APPLY = process.argv.includes('--apply');
const REGISTRY_KEY = 'payment_catalog.departments.registry';
const TARGET_ENTRY_KEY = 'executive_assistants';
const FROM_DEPT = 'Executive Assistant to the CEO';
const EMAILS = ['cjm@simple.biz', 'ellyt@simple.biz', 'jamec@simple.biz'];
const ACTOR = 'kaner@simple.biz (transfer-eas script)';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();
const likeEscape = (v: string) => v.replace(/([%_\\])/g, '\\$1');

type MasterRow = {
  id: string;
  Name: string | null;
  Department: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  off_boarded_at: string | null;
  last_seen_upload_id: string | null;
};

async function main() {
  // -- Target department name comes from the registry (exact label). ---------
  const { data: regRow, error: regErr } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', REGISTRY_KEY)
    .maybeSingle();
  if (regErr) throw new Error(`registry read failed: ${regErr.message}`);
  const registry = regRow ? (JSON.parse((regRow as { value: string }).value) as Array<{ key: string; name: string; members?: Array<{ workEmail: string; isManager: boolean }> }>) : [];
  const entry = registry.find((e) => e.key === TARGET_ENTRY_KEY);
  if (!entry) throw new Error(`Registry has no "${TARGET_ENTRY_KEY}" department -- create it first in Payment Catalog -> Department.`);
  const TO_DEPT = entry.name.trim();
  console.log(`Target department (from registry): "${TO_DEPT}"`);

  const { data: uploadRow } = await supabase
    .from('master_list_uploads')
    .select('id')
    .eq('is_current', true)
    .limit(1)
    .maybeSingle();
  const currentUploadId = (uploadRow as { id?: string } | null)?.id ?? null;
  console.log(`Current master-list upload: ${currentUploadId ?? '(none found)'}\n`);

  // -- Gather every master row for the three. ---------------------------------
  const rowsByEmail = new Map<string, MasterRow[]>();
  for (const email of EMAILS) {
    const { data, error } = await supabase
      .from('global_master_list')
      .select('id, "Name", "Department", "Work Email", "Personal Email", off_boarded_at, last_seen_upload_id')
      .ilike('Work Email', likeEscape(email));
    if (error) throw new Error(`${email}: master lookup failed: ${error.message}`);
    rowsByEmail.set(
      email,
      ((data ?? []) as MasterRow[]).filter((r) => lower(r['Work Email']) === email),
    );
  }

  const { data: mgrRows, error: mgrErr } = await supabase
    .from('department_managers')
    .select('id, manager_email, department, revoked_at')
    .in('manager_email', EMAILS);
  if (mgrErr) throw new Error(`department_managers read failed: ${mgrErr.message}`);

  // -- Backup before anything else. -------------------------------------------
  const backupPath = `references/backups/2026-07-24_ea-hard-transfer-backup.json`;
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        registryValue: regRow ? (regRow as { value: string }).value : null,
        masterRows: Object.fromEntries(rowsByEmail),
        departmentManagers: mgrRows ?? [],
      },
      null,
      2,
    ),
  );
  console.log(`Backup written: ${backupPath}\n`);

  // -- Plan + (maybe) apply per person. ----------------------------------------
  let updates = 0;
  let sheetFlips = 0;
  const warnings: string[] = [];

  for (const email of EMAILS) {
    const rows = (rowsByEmail.get(email) ?? []).filter((r) => !r.off_boarded_at);
    const inTarget = rows.filter((r) => lower(r.Department) === lower(TO_DEPT));
    const inFrom = rows.filter((r) => lower(r.Department) === lower(FROM_DEPT));
    const elsewhere = rows.filter(
      (r) => lower(r.Department) !== lower(TO_DEPT) && lower(r.Department) !== lower(FROM_DEPT),
    );
    const who = rows[0]?.Name ?? email;
    console.log(`== ${who} <${email}>`);

    for (const r of elsewhere) {
      console.log(`   leaving untouched: row ${r.id} in "${r.Department}" (duplicate identity -- flag for cleanup if unwanted)`);
    }

    if (inTarget.length > 0) {
      console.log(`   already in "${TO_DEPT}" (row ${inTarget[0].id}) -- nothing to move`);
      if (inFrom.length > 0) {
        warnings.push(`${email}: still holds a "${FROM_DEPT}" row (${inFrom.map((r) => r.id).join(', ')}) alongside the target row -- redundant dupe, left in place.`);
      }
      continue;
    }
    if (inFrom.length === 0) {
      warnings.push(`${email}: no active "${FROM_DEPT}" row found -- nothing moved. Re-check manually.`);
      console.log(`   !! no "${FROM_DEPT}" row -- skipped`);
      continue;
    }

    // Move the first source row; any extra same-dept dupes would collide on the
    // (work email, dept) unique index, so they are reported, not moved.
    const [move, ...extras] = inFrom;
    for (const r of extras) {
      warnings.push(`${email}: extra duplicate "${FROM_DEPT}" row ${r.id} left in place (would collide with the moved row).`);
    }
    const stampUpload = currentUploadId && move.last_seen_upload_id !== currentUploadId;
    console.log(
      `   ${APPLY ? 'MOVING' : 'would move'}: row ${move.id} "${FROM_DEPT}" -> "${TO_DEPT}"${stampUpload ? ' (+ re-stamp last_seen_upload_id to current)' : ''}`,
    );

    if (APPLY) {
      const patch: Record<string, unknown> = { Department: TO_DEPT };
      if (stampUpload) patch.last_seen_upload_id = currentUploadId;
      const { error: updErr } = await supabase.from('global_master_list').update(patch).eq('id', move.id);
      if (updErr) throw new Error(`${email}: master update failed: ${updErr.message}`);
      updates += 1;
    }

    // Google Sheet write-back (best-effort) -- keeps the next sync honest.
    if (APPLY) {
      try {
        const sheet = await updateMasterSheetDepartment({
          personalEmail: move['Personal Email'],
          workEmail: email,
          fromDepartment: FROM_DEPT,
          toDepartment: TO_DEPT,
        });
        if (sheet.updated > 0) {
          sheetFlips += 1;
          console.log(`   sheet: Department cell updated`);
        } else {
          warnings.push(`${email}: Google Sheet cell NOT updated (${sheet.reason ?? 'no matching row'}) -- fix the Sheet manually or the next sync resurrects "${FROM_DEPT}".`);
          console.log(`   sheet: !! not updated (${sheet.reason ?? 'no matching row'})`);
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`${email}: Google Sheet write failed (${reason}) -- fix the Sheet manually.`);
        console.log(`   sheet: !! write failed (${reason})`);
      }
    } else {
      console.log(`   would flip the master Sheet "Department" cell to "${TO_DEPT}"`);
    }
  }

  // -- Manager grant for the registry-designated manager(s). ------------------
  const registryManagers = (entry.members ?? []).filter((m) => m.isManager).map((m) => lower(m.workEmail));
  for (const mgrEmail of registryManagers) {
    const existing = (mgrRows ?? []).find(
      (r) => lower(r.manager_email) === mgrEmail && lower(r.department) === lower(TO_DEPT),
    );
    if (existing && existing.revoked_at === null) {
      console.log(`\nmanager grant: ${mgrEmail} already active for "${TO_DEPT}"`);
      continue;
    }
    console.log(`\nmanager grant: ${APPLY ? 'ensuring' : 'would ensure'} ${mgrEmail} -> "${TO_DEPT}"${existing ? ' (un-revoke)' : ' (insert)'}`);
    if (APPLY) {
      if (existing) {
        const { error } = await supabase
          .from('department_managers')
          .update({ revoked_at: null, assigned_at: new Date().toISOString(), assigned_by: ACTOR })
          .eq('id', existing.id);
        if (error) warnings.push(`manager grant un-revoke failed for ${mgrEmail}: ${error.message}`);
      } else {
        const { error } = await supabase
          .from('department_managers')
          .insert({ manager_email: mgrEmail, department: TO_DEPT, assigned_by: ACTOR });
        if (error) warnings.push(`manager grant insert failed for ${mgrEmail}: ${error.message}`);
      }
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN (re-run with --apply to write)'}: ${updates} master row(s) updated, ${sheetFlips} sheet cell(s) flipped.`);
  if (warnings.length > 0) {
    console.log('\nWarnings / follow-ups:');
    for (const w of warnings) console.log(` - ${w}`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});

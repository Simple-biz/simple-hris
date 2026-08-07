/**
 * 2026-08-07 dept-assignment repair for six people Kane flagged (transfer
 * fallout — applied transfers left invisible by stale upload stamps, plus two
 * sheet-re-add dupe mints and one transfer that went the wrong direction).
 *
 * Per person (derived live, not hardcoded to row ids):
 *   ralphl@simple.biz    — transfer HSL→Lead Gen applied 08-04; master row already
 *                          "Lead Gen" but STALE → invisible, wizard falls back to the
 *                          rates-row "Hogan Smith Law". RE-STAMP last_seen_upload_id
 *                          + best-effort Sheet cell HSL→Lead Gen.
 *   johnca@simple.biz    — transfer Lead Gen→HSL applied 08-04; master row already
 *                          "HSL" but STALE. RE-STAMP + best-effort Sheet cell
 *                          Lead Gen→HSL.
 *   laurenc@simple.biz   — transfer HSL→Lead Gen applied 07-28 was WRONG per Kane
 *                          (she is HSL; final pay pending). FLIP Department→"HSL"
 *                          on her current row + best-effort Sheet cell.
 *   zent@simple.biz      — no transfer record; stale "Lead Gen" dupe alongside the
 *                          current "HSL" row (sheet re-add clobber). DELETE the
 *                          stale Lead Gen dupe.
 *   lykac@simple.biz     — same as zent. DELETE the stale Lead Gen dupe.
 *   zigfredoa@simple.biz — VERIFY ONLY: row already hsl:intake_specialist + current;
 *                          the wizard leaver overlay (2020a74) re-derives from it.
 *
 * SAFE BY DEFAULT: dry-run prints the plan and writes a JSON backup of every
 * row it would touch to references/backups/. Re-run with --apply to write.
 * Idempotent: already-converged people are reported and skipped.
 *
 *   npx tsx scripts/fix-dept-transfers-2026-08-07.mts           # dry run
 *   npx tsx scripts/fix-dept-transfers-2026-08-07.mts --apply   # write
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import sheetModule from '../src/lib/google-sheets/update-master-sheet-department';
const { updateMasterSheetDepartment } = sheetModule as unknown as typeof import('../src/lib/google-sheets/update-master-sheet-department');

dotenv.config({ path: '.env.local' });

const APPLY = process.argv.includes('--apply');

type Action =
  | { kind: 'restamp'; email: string; expectDept: string; sheetFrom: string; sheetTo: string }
  | { kind: 'flip'; email: string; fromDept: string; toDept: string; sheetFrom: string; sheetTo: string }
  | { kind: 'delete-stale-dupe'; email: string; staleDept: string; keepDept: string }
  | { kind: 'verify'; email: string; expectDeptPrefix: string };

const PLAN: Action[] = [
  { kind: 'restamp', email: 'ralphl@simple.biz', expectDept: 'Lead Gen', sheetFrom: 'HSL', sheetTo: 'Lead Gen' },
  { kind: 'restamp', email: 'johnca@simple.biz', expectDept: 'HSL', sheetFrom: 'Lead Gen', sheetTo: 'HSL' },
  { kind: 'flip', email: 'laurenc@simple.biz', fromDept: 'Lead Gen', toDept: 'HSL', sheetFrom: 'Lead Gen', sheetTo: 'HSL' },
  { kind: 'delete-stale-dupe', email: 'zent@simple.biz', staleDept: 'Lead Gen', keepDept: 'HSL' },
  { kind: 'delete-stale-dupe', email: 'lykac@simple.biz', staleDept: 'Lead Gen', keepDept: 'HSL' },
  { kind: 'verify', email: 'zigfredoa@simple.biz', expectDeptPrefix: 'hsl' },
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

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

async function masterRows(email: string): Promise<MasterRow[]> {
  const { data, error } = await supabase
    .from('global_master_list')
    .select('id, "Name", "Department", "Work Email", "Personal Email", off_boarded_at, last_seen_upload_id')
    .ilike('Work Email', likeEscape(email));
  if (error) throw new Error(`${email}: master lookup failed: ${error.message}`);
  return ((data ?? []) as MasterRow[]).filter((r) => lower(r['Work Email']) === lower(email));
}

async function flipSheet(row: MasterRow, email: string, from: string, to: string, warnings: string[]) {
  try {
    const sheet = await updateMasterSheetDepartment({
      personalEmail: row['Personal Email'],
      workEmail: email,
      fromDepartment: from,
      toDepartment: to,
    });
    if (sheet.updated > 0) {
      console.log(`   sheet: Department cell "${from}" -> "${to}" updated`);
      return true;
    }
    warnings.push(`${email}: Sheet cell NOT updated (${sheet.reason ?? 'no matching row'}) — if they're missing from the Sheet, re-add with Department "${to}" or the row goes stale again on the next sync.`);
    console.log(`   sheet: !! not updated (${sheet.reason ?? 'no matching row'})`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    warnings.push(`${email}: Sheet write failed (${reason}) — fix the Sheet cell to "${to}" manually.`);
    console.log(`   sheet: !! write failed (${reason})`);
  }
  return false;
}

async function main() {
  const { data: uploadRow } = await supabase
    .from('master_list_uploads').select('id').eq('is_current', true).limit(1).maybeSingle();
  const currentUploadId = (uploadRow as { id?: string } | null)?.id ?? null;
  if (!currentUploadId) throw new Error('No is_current master_list_uploads row — aborting (re-stamps would be meaningless).');
  console.log(`Current master-list upload: ${currentUploadId}`);
  console.log(`${APPLY ? 'APPLY MODE' : 'DRY RUN (re-run with --apply to write)'}\n`);

  // -- Backup every row for all six before anything else. ----------------------
  const allRows: Record<string, MasterRow[]> = {};
  for (const a of PLAN) allRows[a.email] = await masterRows(a.email);
  const backupPath = 'references/backups/2026-08-07_dept-transfer-fixes-backup.json';
  writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), currentUploadId, masterRows: allRows }, null, 2));
  console.log(`Backup written: ${backupPath}\n`);

  const warnings: string[] = [];
  let writes = 0;

  for (const a of PLAN) {
    const rows = allRows[a.email];
    const who = rows[0]?.Name ?? a.email;
    console.log(`== ${who} <${a.email}> — ${a.kind}`);
    if (rows.length === 0) { warnings.push(`${a.email}: no master rows at all — nothing done.`); continue; }

    if (a.kind === 'verify') {
      for (const r of rows) {
        const ok = lower(r.Department).startsWith(a.expectDeptPrefix) && r.last_seen_upload_id === currentUploadId;
        console.log(`   row ${r.id} dept="${r.Department}" upload=${r.last_seen_upload_id === currentUploadId ? 'current' : 'STALE'} → ${ok ? 'OK, nothing to do' : 'UNEXPECTED'}`);
        if (!ok) warnings.push(`${a.email}: expected an hsl* current row; found dept="${r.Department}" (stale=${r.last_seen_upload_id !== currentUploadId}). Investigate before touching.`);
      }
      continue;
    }

    if (a.kind === 'restamp') {
      const target = rows.filter((r) => lower(r.Department) === lower(a.expectDept));
      if (target.length !== 1) {
        warnings.push(`${a.email}: expected exactly one "${a.expectDept}" row, found ${target.length} — skipped.`);
        continue;
      }
      const r = target[0];
      if (r.last_seen_upload_id === currentUploadId) {
        console.log(`   row ${r.id} already stamped current — nothing to do`);
      } else {
        console.log(`   ${APPLY ? 'RE-STAMPING' : 'would re-stamp'} row ${r.id} ("${r.Department}") last_seen_upload_id -> current`);
        if (APPLY) {
          const { error } = await supabase.from('global_master_list')
            .update({ last_seen_upload_id: currentUploadId }).eq('id', r.id);
          if (error) throw new Error(`${a.email}: re-stamp failed: ${error.message}`);
          writes += 1;
        }
      }
      if (APPLY) await flipSheet(r, a.email, a.sheetFrom, a.sheetTo, warnings);
      else console.log(`   would flip Sheet Department cell "${a.sheetFrom}" -> "${a.sheetTo}" (best-effort)`);
      continue;
    }

    if (a.kind === 'flip') {
      const already = rows.filter((r) => lower(r.Department) === lower(a.toDept));
      if (already.length > 0) {
        console.log(`   already has a "${a.toDept}" row (${already[0].id}) — nothing to flip`);
        continue;
      }
      const src = rows.filter((r) => lower(r.Department) === lower(a.fromDept));
      if (src.length !== 1) {
        warnings.push(`${a.email}: expected exactly one "${a.fromDept}" row, found ${src.length} — skipped.`);
        continue;
      }
      const r = src[0];
      const patch: Record<string, unknown> = { Department: a.toDept };
      if (r.last_seen_upload_id !== currentUploadId) patch.last_seen_upload_id = currentUploadId;
      console.log(`   ${APPLY ? 'FLIPPING' : 'would flip'} row ${r.id} "${a.fromDept}" -> "${a.toDept}"${patch.last_seen_upload_id ? ' (+ re-stamp)' : ''}`);
      if (APPLY) {
        const { error } = await supabase.from('global_master_list').update(patch).eq('id', r.id);
        if (error) throw new Error(`${a.email}: flip failed: ${error.message}`);
        writes += 1;
        await flipSheet(r, a.email, a.sheetFrom, a.sheetTo, warnings);
      } else {
        console.log(`   would flip Sheet Department cell "${a.sheetFrom}" -> "${a.sheetTo}" (best-effort)`);
      }
      continue;
    }

    // delete-stale-dupe
    const keep = rows.filter((r) => lower(r.Department) === lower(a.keepDept) && r.last_seen_upload_id === currentUploadId);
    const stale = rows.filter((r) => lower(r.Department) === lower(a.staleDept) && r.last_seen_upload_id !== currentUploadId);
    if (keep.length === 0) {
      warnings.push(`${a.email}: no CURRENT "${a.keepDept}" row to keep — dupe delete skipped (would orphan them).`);
      continue;
    }
    if (stale.length === 0) {
      console.log(`   no stale "${a.staleDept}" dupe found — already converged`);
      continue;
    }
    for (const r of stale) {
      console.log(`   ${APPLY ? 'DELETING' : 'would delete'} stale dupe row ${r.id} ("${r.Department}", upload STALE) — keeping ${keep[0].id} ("${keep[0].Department}")`);
      if (APPLY) {
        const { error } = await supabase.from('global_master_list').delete().eq('id', r.id);
        if (error) throw new Error(`${a.email}: dupe delete failed: ${error.message}`);
        writes += 1;
      }
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${writes} write(s).`);
  if (warnings.length > 0) {
    console.log('\nWarnings / follow-ups:');
    for (const w of warnings) console.log(` - ${w}`);
  }
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });

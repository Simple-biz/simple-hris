/**
 * Repair master-Sheet Department drift that makes working people invisible.
 *
 * THE FAILURE THIS REPAIRS (measured live 2026-08-25)
 * --------------------------------------------------
 * `applyApprovedTransfer` used to skip the Google-Sheet write-back whenever the
 * master-list apply resolved 'satisfied' (the DB row already held the target
 * dept) and record `sheet_synced = true` anyway — a fact about the DATABASE used
 * to assert something about the SHEET. The Sheet kept the PRE-TRANSFER
 * department forever. Because the master sync keys identity on
 * `(LOWER("Personal Email"), LOWER("Department"))`, a drifted dept means the
 * person's row is never matched and never re-stamped, so they fall out of
 * `active_employees` and go invisible on every roster surface — while still
 * being paid off their Hubstaff hours.
 *
 * The code cause is fixed (`update-master-sheet-department.ts` now distinguishes
 * flipped / already-correct / drifted, and `apply-transfer.ts` always attempts
 * the write). This script repairs the rows that already drifted.
 *
 * DIRECTION OF REPAIR — HRIS WINS
 * -------------------------------
 * Kane, 2026-08-21: "The HRIS will be the source of truth so if he was
 * transferred already that should be his last known Department as we are
 * departing from the Sheet." So this pushes the DB department INTO the Sheet.
 * It never edits a Department in the DB.
 *
 * ORDER MATTERS (docs/features/department-transfers.md §6)
 * -------------------------------------------------------
 *   1. flip the Sheet cell to the DB department
 *   2. re-stamp the DB row onto the current upload (immediate visibility)
 * Doing (2) alone leaves the drift, so the NEXT sync mints a duplicate row in
 * the stale department. Running a plain sync INSTEAD of this script is actively
 * harmful for the same reason — it re-imports the stale Sheet dept.
 *
 * WHAT IT REFUSES TO TOUCH
 * ------------------------
 *   · anyone with an `off_boarded_at` stamp on any of their rows — active vs.
 *     off-boarded is a business call (the "Medilo Hanna Grace" case, §6)
 *   · anyone whose DB rows disagree with EACH OTHER about the department —
 *     there is no single authoritative value to push
 * Both are reported for escalation rather than guessed at.
 *
 * SAFE BY DEFAULT: dry-run. Prints every intended change and writes a backup
 * JSON of every affected master row BEFORE any write.
 *
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/fix-sheet-dept-drift.mts            # dry run
 *   node --import tsx scripts/fix-sheet-dept-drift.mts --apply    # perform writes
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { fetchMasterSheetAsCsv } = await import('../src/lib/google-sheets/fetch-master-sheet');
const { updateMasterSheetDepartment } = await import('../src/lib/google-sheets/update-master-sheet-department');
const { parseCsv } = await import('../src/lib/csv/parse-csv');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const { isPlaceableDeptLabel } = await import('../src/lib/departments/hsl-subdept');

const sb = createSupabaseServiceRoleClient();
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

interface MasterRow {
  id: string;
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  Department: string | null;
  off_boarded_at: string | null;
  last_seen_upload_id: string | null;
}

// ---------------------------------------------------------------- current upload
const { data: cur, error: curErr } = await sb
  .from('master_list_uploads')
  .select('id, uploaded_at, source_file, row_count')
  .eq('is_current', true)
  .limit(1);
if (curErr) throw new Error(`could not read master_list_uploads: ${curErr.message}`);
const current = cur?.[0];
if (!current) throw new Error('no is_current master_list_upload — refusing to run');
console.log(`current upload: ${current.id} (${current.uploaded_at}, ${current.row_count} rows)`);

// ---------------------------------------------------------------- the two sides
const fetched = await fetchMasterSheetAsCsv();
const rows = parseCsv(fetched.csvText) as string[][];
let hi = -1;
for (let i = 0; i < Math.min(rows.length, 10); i++) {
  const c = (rows[i] ?? []).map(norm);
  if (c.includes('department') && (c.includes('name') || c.includes('personal email'))) { hi = i; break; }
}
if (hi < 0) throw new Error('sheet header row not found — refusing to run');
const hdr = (rows[hi] ?? []).map(norm);
const col = (want: string[]) => hdr.findIndex((h) => want.includes(h));
const cW = col(['work email', 'workemail']);
const cP = col(['personal email', 'personalemail']);
const cD = col(['department']);
const cN = col(['name']);
if (cD < 0 || (cW < 0 && cP < 0)) throw new Error('sheet is missing Department/email columns — refusing to run');
const sheetRows = rows.slice(hi + 1).filter((r) => norm(r[cW]) || norm(r[cP]));
console.log(`sheet data rows: ${sheetRows.length}`);

const gmlRes = (await selectAllPaged<MasterRow>((from, to) =>
  sb
    .from('global_master_list')
    .select('id,"Name","Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id')
    .range(from, to) as never,
)) as unknown as { rows?: MasterRow[] } | MasterRow[];
const gml: MasterRow[] = Array.isArray(gmlRes) ? gmlRes : (gmlRes.rows ?? []);
console.log(`global_master_list rows: ${gml.length}`);

// A negative control: an empty side means a failed read, never "nothing to do".
if (sheetRows.length === 0 || gml.length === 0) throw new Error('one side read empty — refusing to run');

const byEmail = new Map<string, MasterRow[]>();
for (const r of gml) {
  for (const k of ['Work Email', 'Personal Email'] as const) {
    const e = norm(r[k]);
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e)!.push(r);
  }
}

// ---------------------------------------------------------------- classify drift
interface Drift {
  email: string;
  name: string;
  sheetDept: string;
  dbDepts: string[];
  rows: MasterRow[];
  visible: boolean;
}
const repairable: Drift[] = [];
const escalate: (Drift & { why: string })[] = [];

for (const r of sheetRows) {
  const we = norm(r[cW]);
  const pe = norm(r[cP]);
  const sheetDept = String(r[cD] ?? '').trim();
  const cand = [...new Set([...(byEmail.get(we) ?? []), ...(byEmail.get(pe) ?? [])])];
  if (cand.length === 0) continue; // new hire — a sync will INSERT them, not our business
  const dbDepts = [...new Set(cand.map((c) => norm(c.Department)))];
  if (dbDepts.includes(norm(sheetDept))) continue; // agrees — nothing to do

  const d: Drift = {
    email: we || pe,
    name: String(r[cN] ?? '').trim(),
    sheetDept,
    dbDepts,
    rows: cand,
    visible: cand.some((c) => c.last_seen_upload_id === current.id),
  };
  if (cand.some((c) => c.off_boarded_at)) {
    escalate.push({ ...d, why: 'carries an off_boarded_at stamp — active-vs-offboarded is a business call' });
  } else if (dbDepts.length > 1) {
    escalate.push({ ...d, why: `DB rows disagree with each other (${dbDepts.join(' | ')}) — no single authoritative dept` });
  } else if (!isPlaceableDeptLabel(String(cand[0].Department ?? ''))) {
    // A bare `HSL` (or any retired/unplaceable key) is HRIS-truthful but resolves
    // NO department base rate and is not a valid placement — pushing it into the
    // Sheet would launder a degraded value into the roster's source doc. The
    // person needs a sub-team first. See docs/features/hsl-subdepartments.md §1.1.
    escalate.push({
      ...d,
      why: `DB dept "${String(cand[0].Department ?? '').trim()}" is not a placeable label (no department base rate) — needs a sub-team assignment first`,
    });
  } else {
    repairable.push(d);
  }
}

console.log(`\n=== DRIFT: ${repairable.length + escalate.length} rows (${repairable.length} repairable, ${escalate.length} to escalate) ===`);
for (const d of repairable) {
  console.log(
    `  REPAIR  ${d.email}  ${d.name}\n` +
      `            sheet="${d.sheetDept}"  ->  db="${d.dbDepts[0]}"   (visible now: ${d.visible})`,
  );
}
for (const d of escalate) {
  console.log(`  SKIP    ${d.email}  ${d.name}  sheet="${d.sheetDept}" db="${d.dbDepts.join(' | ')}"\n            ${d.why}`);
}

if (repairable.length === 0) {
  console.log('\nnothing repairable — done.');
  process.exit(0);
}

// ---------------------------------------------------------------- backup, always
mkdirSync('scripts/backups', { recursive: true });
const backupPath = `scripts/backups/global_master_list-pre-sheet-dept-drift-fix.json`;
writeFileSync(
  backupPath,
  JSON.stringify(
    {
      takenFor: 'fix-sheet-dept-drift',
      currentUploadId: current.id,
      repairable: repairable.map((d) => ({ email: d.email, sheetDept: d.sheetDept, dbDepts: d.dbDepts, rows: d.rows })),
      escalated: escalate.map((d) => ({ email: d.email, why: d.why, sheetDept: d.sheetDept, dbDepts: d.dbDepts, rows: d.rows })),
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\nbackup written: ${backupPath}`);

if (!APPLY) {
  console.log('\nDRY RUN — no writes performed. Re-run with --apply to perform them.');
  process.exit(0);
}

// ---------------------------------------------------------------- apply
let sheetOk = 0;
let sheetFail = 0;
let restamped = 0;

for (const d of repairable) {
  const target = d.rows[0];
  const dbDept = (target.Department ?? '').trim();

  // 1. Sheet cell -> DB department.
  try {
    const res = await updateMasterSheetDepartment({
      personalEmail: target['Personal Email'],
      workEmail: target['Work Email'],
      fromDepartment: d.sheetDept,
      toDepartment: dbDept,
    });
    if (res.updated > 0 || res.alreadyTarget) {
      sheetOk++;
      console.log(`  sheet OK   ${d.email}  "${d.sheetDept}" -> "${dbDept}"${res.alreadyTarget ? ' (already target)' : ''}`);
    } else {
      sheetFail++;
      console.log(`  sheet FAIL ${d.email}  ${res.reason ?? 'no rows updated'}`);
      // Do NOT re-stamp on a failed Sheet write: visibility without a Sheet fix
      // just means the next sync mints a duplicate in the stale department.
      continue;
    }
  } catch (e) {
    sheetFail++;
    console.log(`  sheet ERR  ${d.email}  ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }

  // 2. Re-stamp every non-offboarded row for this person onto the current upload.
  for (const r of d.rows) {
    if (r.off_boarded_at) continue;
    if (r.last_seen_upload_id === current.id) continue;
    const { error } = await sb
      .from('global_master_list')
      .update({ last_seen_upload_id: current.id })
      .eq('id', r.id)
      .is('off_boarded_at', null);
    if (error) console.log(`  restamp ERR ${d.email} row ${r.id}: ${error.message}`);
    else {
      restamped++;
      console.log(`  restamped  ${d.email} row ${r.id}`);
    }
  }
}

console.log(
  `\n=== APPLIED === sheet cells fixed: ${sheetOk}, sheet failures: ${sheetFail}, rows re-stamped: ${restamped}`,
);
console.log('Re-run WITHOUT --apply to confirm the drift count is now 0.');

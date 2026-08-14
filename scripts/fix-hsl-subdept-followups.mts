/**
 * Two follow-ups from the 2026-08-14 bulk HSL sub-department assignment
 * (docs/features/hsl-subdepartments.md §9). Both are Kane's rulings, both are
 * DB-and-Sheet, because the Sheet is the roster's source of truth and a DB-only
 * fix is re-minted on the next sync (department-transfers.md §6).
 *
 * 1. valeriec@simple.biz — Kane: *"valeriec@ is HSL she is pre hearing litigation
 *    in the CSV File I referenced for you."* Guard 8 skipped her during the bulk
 *    run because her SHEET row read "Lead Gen" while her DB cell read "HSL"; the
 *    Sheet had drifted two weeks past the 2026-07-30 sync. Kane's ruling settles
 *    which side is right: she is HSL, role "Pre-Hearing Litigation", which maps
 *    to hsl:ssd_medical_records exactly as it does for the other 55. So the
 *    SHEET is the side that is wrong and gets corrected.
 *
 * 2. chariso@simple.biz (Orbiso, Charisma "Charis") — Kane: *"chariso@simple.biz
 *    - is clientVA please."* She holds TWO active master rows, "Client VA" and
 *    "Lead Gen", because the master SHEET carries two rows for her (483 Lead Gen,
 *    490 Client VA). Deleting the DB row alone would be undone by the next sync.
 *
 *    The Sheet fix here is deliberately a CELL EDIT, not a row deletion: both of
 *    her rows are set to "Client VA" so the sync's (Personal Email, Department)
 *    identity collapses to one, and no wrong department can be minted from either
 *    row. Removing the now-redundant sheet row is HR's tidy-up, not a script's —
 *    deleting a row shifts every row beneath it in a live shared document.
 *    The redundant DB row is deleted, per the playbook in
 *    department-transfers.md §6 ("delete any sync-minted duplicate, leaving
 *    exactly one active row").
 *
 * NOT A TRANSFER, same as the bulk run: zero `department_transfer_requests` rows.
 * Neither person has ever had a transfer record (checked), so nothing is being
 * contradicted. CJ's 14 Transfers-tab moves of 2026-08-14 are untouched — the
 * overlap with the bulk write set was verified as zero.
 *
 * RATE IMPACT: none. valeriec@ rides a sheet rate (₱175) and HSL→hsl:* keeps her
 * on the same parent fallback; chariso@ is not HSL at all and only loses a
 * duplicate row.
 *
 * GUARDS: every target is addressed BY PRIMARY KEY (never a department filter,
 * which deletes whatever matches at execution time rather than the row proved);
 * every row is re-read and must match its expected state before the write; a
 * disk backup of every affected DB row AND sheet cell precedes any write.
 *
 * USAGE
 *   node --import tsx scripts/fix-hsl-subdept-followups.mts           # dry run
 *   node --import tsx scripts/fix-hsl-subdept-followups.mts --apply   # writes
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ACTOR = 'kaner@simple.biz';

/** Master rows to UPDATE, by primary key, with the state each must currently be in. */
const UPDATES = [
  {
    id: '3929e0d2-95c7-4a8a-ad60-7d979e2db400',
    who: 'valeriec@simple.biz',
    expect: 'HSL',
    to: 'hsl:ssd_medical_records',
    why: 'Kane 2026-08-14: HSL, Pre-Hearing Litigation (→ ssd_medical_records, as for the other 55)',
  },
] as const;

/** Master rows to DELETE, by primary key, with the state each must currently be in. */
const DELETES = [
  {
    id: 'c1bdae8f-6da0-43ce-868e-c09f9ef4fda1',
    who: 'chariso@simple.biz',
    expect: 'Lead Gen',
    why: 'Kane 2026-08-14: "chariso@simple.biz - is clientVA please" — redundant duplicate; the Client VA row survives',
  },
] as const;

/** Sheet Department cells to rewrite. Row numbers are 1-based and re-verified
 *  against the live sheet by email + expected value before any write. */
const SHEET_CELLS = [
  { row: 888, email: 'valeriec@simple.biz', expect: 'Lead Gen', to: 'hsl:ssd_medical_records' },
  { row: 483, email: 'chariso@simple.biz', expect: 'Lead Gen', to: 'Client VA' },
] as const;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('FATAL: need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const die = (msg: string): never => {
  console.error(`\nABORTED — ${msg}`);
  process.exit(1);
};
const n = (v: unknown) => String(v ?? '').trim().toLowerCase();

function columnToLetter(column: number): string {
  let temp: number, letter = '';
  while (column > 0) { temp = (column - 1) % 26; letter = String.fromCharCode(temp + 65) + letter; column = (column - temp - 1) / 26; }
  return letter;
}

(async () => {
  console.log(`\nHSL sub-department follow-ups — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // ── verify DB state ────────────────────────────────────────────────────────
  const ids = [...UPDATES.map((u) => u.id), ...DELETES.map((d) => d.id)];
  const { data: rows, error } = await db
    .from('global_master_list')
    .select('id,"Name","Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id')
    .in('id', ids);
  if (error) die(`reading global_master_list: ${error.message}`);
  const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));

  for (const u of [...UPDATES, ...DELETES]) {
    const r = byId.get(u.id);
    if (!r) die(`row ${u.id} (${u.who}) not found — refusing to guess`);
    if (String(r.Department).trim() !== u.expect)
      die(`row ${u.id} (${u.who}) is "${r.Department}", expected "${u.expect}" — someone else changed it; re-read before rerunning`);
  }
  console.log('DB state verified — every target row is in its expected state.');

  // Deleting must leave exactly one active row for that person.
  for (const d of DELETES) {
    const { data: all } = await db
      .from('global_master_list')
      .select('id,"Department",off_boarded_at,last_seen_upload_id')
      .ilike('"Work Email"', d.who);
    const { data: up } = await db.from('master_list_uploads').select('id').eq('is_current', true).maybeSingle();
    const cur = (up as any)?.id;
    const active = (all ?? []).filter((r: any) => !r.off_boarded_at && r.last_seen_upload_id === cur);
    const survivors = active.filter((r: any) => r.id !== d.id);
    console.log(`  ${d.who}: ${active.length} active rows [${active.map((r: any) => `"${r.Department}"`).join(', ')}]`);
    if (survivors.length !== 1)
      die(`deleting ${d.id} would leave ${survivors.length} active rows for ${d.who}, not exactly 1`);
    console.log(`    → deleting the "${d.expect}" row leaves exactly one: "${survivors[0].Department}"`);
  }

  // ── verify sheet state ─────────────────────────────────────────────────────
  const { getServiceAccountAccessToken } = await import('../src/lib/google-sheets/auth.js').catch(
    (e: unknown) => die(`could not import google-sheets/auth: ${String(e)}`),
  );
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) die('GOOGLE_SHEETS_MASTER_SHEET_ID / _TAB_NAME not configured');
  const scope = APPLY
    ? 'https://www.googleapis.com/auth/spreadsheets'
    : 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const token = await getServiceAccountAccessToken(scope);
  const quotedTab = `'${tabName!.replace(/'/g, "''")}'`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(quotedTab)}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  const j = (await res.json()) as { values?: unknown[][]; error?: { message?: string } };
  if (!res.ok) die(`Sheets read failed (${res.status}): ${j.error?.message ?? res.statusText}`);
  const values = j.values ?? [];
  let headerIdx = -1;
  for (let i = 0; i < values.length; i++) {
    const r = (values[i] ?? []).map(n);
    if (r.includes('department') && (r.includes('name') || r.includes('personal email'))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) die('header row not found in the master sheet');
  const H = (values[headerIdx] ?? []).map(n);
  const dc = H.indexOf('department');
  const wc = H.findIndex((x) => x === 'work email' || x === 'workemail');
  if (dc < 0 || wc < 0) die('sheet is missing a Department or Work Email column');
  const deptLetter = columnToLetter(dc + 1);

  const sheetBackup: Array<{ cell: string; email: string; before: string; after: string }> = [];
  for (const c of SHEET_CELLS) {
    const row = values[c.row - 1] ?? [];
    const gotEmail = n(row[wc]);
    const gotDept = String(row[dc] ?? '').trim();
    if (gotEmail !== c.email)
      die(`sheet row ${c.row} holds "${gotEmail}", expected "${c.email}" — the sheet shifted; re-locate before rerunning`);
    if (gotDept !== c.expect)
      die(`sheet ${deptLetter}${c.row} (${c.email}) is "${gotDept}", expected "${c.expect}" — someone else changed it`);
    sheetBackup.push({ cell: `${deptLetter}${c.row}`, email: c.email, before: gotDept, after: c.to });
    console.log(`  sheet ${deptLetter}${c.row} ${c.email}: "${gotDept}" → "${c.to}"`);
  }
  console.log('Sheet state verified — every target cell is in its expected state.');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Rerun with --apply.');
    return;
  }

  // ── backup, then write ─────────────────────────────────────────────────────
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('reports', `backup_hsl_subdept_followups_${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({ masterRows: rows, sheetCells: sheetBackup, updates: UPDATES, deletes: DELETES }, null, 2),
    'utf8',
  );
  console.log(`\nBackup → ${backupPath}`);

  // Sheet first: a DB-half failure then resolves toward the corrected value.
  const batch = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: SHEET_CELLS.map((c) => ({ range: `${quotedTab}!${deptLetter}${c.row}`, values: [[c.to]] })),
    }),
    cache: 'no-store',
  });
  if (!batch.ok) die(`Sheets batchUpdate failed (${batch.status}): ${(await batch.text().catch(() => '')).slice(0, 300)}`);
  console.log(`Sheet: ${SHEET_CELLS.length} cells written.`);

  for (const u of UPDATES) {
    const { error: e } = await db.from('global_master_list').update({ Department: u.to }).eq('id', u.id);
    if (e) die(`updating ${u.id} (${u.who}): ${e.message}`);
    console.log(`DB: ${u.who} "${u.expect}" → "${u.to}"`);
    await db.from('audit_log').insert({
      user_name: ACTOR, user_role: 'admin', action: 'hsl.subdept.followup_fix',
      resource: 'global_master_list', resource_id: u.id,
      details: { who: u.who, from: u.expect, to: u.to, why: u.why, sheetAlsoUpdated: true },
    });
  }

  for (const d of DELETES) {
    const { error: e } = await db.from('global_master_list').delete().eq('id', d.id);
    if (e) die(`deleting ${d.id} (${d.who}): ${e.message}`);
    console.log(`DB: deleted ${d.who} duplicate row (${d.expect})`);
    await db.from('audit_log').insert({
      user_name: ACTOR, user_role: 'admin', action: 'hsl.subdept.followup_delete_duplicate',
      resource: 'global_master_list', resource_id: d.id,
      details: { who: d.who, deletedDepartment: d.expect, why: d.why, backup: backupPath, sheetAlsoUpdated: true },
    });
  }

  console.log(`\nDONE. Backup ${backupPath}`);
})();

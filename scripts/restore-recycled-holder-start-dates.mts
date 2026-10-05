/**
 * Put back the Start Date of the five PREVIOUS holders of a recycled work email
 * that marking a new hire's orientation overwrote with 2026-09-28 (audit item 344).
 *
 * READ-ONLY WITHOUT `--apply`. With `--apply` it writes to PRODUCTION —
 * `global_master_list` and the master Google Sheet — and refuses to start until
 * it has written a backup of every row and cell it intends to touch to
 * `docs/audits/backups/` (gitignored: the rows carry personal emails).
 *
 * ## What happened
 *
 * `syncStartDateToMaster` found "the hire's" master row by (Work Email,
 * Department). On 2026-09-28 Jackie marked orientation for five Lead Gen hires
 * who were minted a recycled address. None was promoted (promote refuses another
 * person's off-boarded row), so each pair was the previous holder's row: all five
 * were re-dated 2026-09-28, and `updateMasterSheetStartDate` re-dated the three
 * of them that are on the Sheet. The code now targets only the hire's own linked
 * row (`src/lib/hr/start-date-sync.ts`). This repairs the rows it already broke.
 *
 * ## What each row is restored TO
 *
 * The row OWNER's own start date: the person whose name and Personal Email the
 * row carries. Derived live from that person's own `hr_pending_employees` row
 * (linked to this master row AND carrying the same Personal Email; its
 * orientation date, in Manila, is what promote stamped) and required to equal
 * the value below, which two or three records agreed on when measured
 * 2026-10-05. `johnt@` held a THIRD person's date (Tamala's 08-31, the pre-fix
 * reuse) before 09-28; it is restored to Torculas's own 07-27, not to 08-31.
 *
 * ## What stops it writing the wrong thing
 *
 *   1. the master row is found by id, and its Work Email and Personal Email must
 *      still be the expected ones;
 *   2. its Start Date must still be exactly 2026-09-28 — a row anyone has
 *      touched since is skipped, never overwritten (the UPDATE is a CAS on it);
 *   3. the derived owner date must equal the expected date, or the row is skipped;
 *   4. a Sheet cell is written only on a row whose Work Email AND Personal Email
 *      are the owner's and whose Start Date still reads 09/28/26.
 *
 * Usage:
 *   node --import tsx scripts/restore-recycled-holder-start-dates.mts           # plan only
 *   node --import tsx scripts/restore-recycled-holder-start-dates.mts --apply   # writes
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const APPLY = process.argv.includes('--apply');
const CLOBBERED_ISO = '2026-09-28';

const { getServiceAccountAccessToken } = await import('../src/lib/google-sheets/auth');
const { toSheetDate } = await import('../src/lib/google-sheets/sheet-date');
const { formatCellsAsShortDate } = await import('../src/lib/google-sheets/format-date-cells');
const { normEmail } = await import('../src/lib/email/norm-email');

type Target = { masterId: string; workEmail: string; ownerPersonal: string; restoreTo: string };

// Owner personal emails are not repeated here: they are read from the row and
// must match the owner's own pending row (guard 1 + 3), so nothing in this file
// identifies a person beyond the work address the Open items row already names.
const TARGETS: Array<Omit<Target, 'ownerPersonal'>> = [
  { masterId: '8746791a-e594-431b-8e6e-5cc093aea9ed', workEmail: 'johnt@simple.biz', restoreTo: '2026-07-27' },
  { masterId: '5af3ae71-7238-41f8-9ec7-b71f116e40f4', workEmail: 'justinem@simple.biz', restoreTo: '2026-09-08' },
  { masterId: '6e24b138-2e46-419d-88bd-9401b6eee02b', workEmail: 'maryt@simple.biz', restoreTo: '2026-08-10' },
  { masterId: '6d379c65-745a-4dd4-86fb-b889d9166746', workEmail: 'marial@simple.biz', restoreTo: '2026-07-06' },
  { masterId: 'ce7c6ed7-ebe5-4dc4-846b-1c6c83d52c4c', workEmail: 'marief@simple.biz', restoreTo: '2026-07-06' },
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** Manila calendar date of an ISO timestamp (fixed UTC+8, as promote renders it). */
function manilaDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

// ── 1. Database plan ──────────────────────────────────────────────────────────
const plan: Target[] = [];
const masterBackup: Record<string, unknown>[] = [];
for (const t of TARGETS) {
  const { data: row, error } = await sb.from('global_master_list').select('*').eq('id', t.masterId).maybeSingle();
  if (error) throw new Error(`read ${t.masterId}: ${error.message}`);
  const r = row as Record<string, unknown> | null;
  if (!r) { console.log(`SKIP ${t.workEmail}: master row ${t.masterId} not found`); continue; }
  const work = normEmail(r['Work Email'] as string | null);
  const personal = normEmail(r['Personal Email'] as string | null);
  const start = String(r['Start Date'] ?? '');
  if (work !== t.workEmail) { console.log(`SKIP ${t.workEmail}: row now carries Work Email ${work}`); continue; }
  if (!personal) { console.log(`SKIP ${t.workEmail}: row has no Personal Email`); continue; }
  if (start !== CLOBBERED_ISO) { console.log(`SKIP ${t.workEmail}: Start Date is ${start}, not ${CLOBBERED_ISO} — changed since, leaving it`); continue; }

  const { data: own, error: ownErr } = await sb
    .from('hr_pending_employees')
    .select('id, personal_email, orientation_attended_at, promoted_to_master_id')
    .eq('promoted_to_master_id', t.masterId)
    .ilike('personal_email', personal);
  if (ownErr) throw new Error(`pending lookup ${t.workEmail}: ${ownErr.message}`);
  const owned = (own ?? []) as Array<{ id: number; orientation_attended_at: string | null }>;
  if (owned.length !== 1) { console.log(`SKIP ${t.workEmail}: ${owned.length} owner pending rows (need exactly 1)`); continue; }
  const derived = manilaDate(owned[0].orientation_attended_at);
  if (derived !== t.restoreTo) {
    console.log(`SKIP ${t.workEmail}: owner pending #${owned[0].id} gives ${derived}, expected ${t.restoreTo}`);
    continue;
  }
  plan.push({ ...t, ownerPersonal: personal });
  masterBackup.push(r);
  console.log(`PLAN db    ${t.workEmail.padEnd(20)} ${t.masterId.slice(0, 8)}  ${start} → ${t.restoreTo}  (owner pending #${owned[0].id})`);
}

// ── 2. Sheet plan ─────────────────────────────────────────────────────────────
const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
if (!sheetId || !tabName) throw new Error('GOOGLE_SHEETS_MASTER_SHEET_ID / GOOGLE_SHEETS_MASTER_TAB_NAME missing');
const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/spreadsheets');
const auth = { Authorization: `Bearer ${token}` };
const getRes = await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(quotedTab)}` +
    '?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING',
  { headers: auth, cache: 'no-store' },
);
const getJson = (await getRes.json()) as { values?: unknown[][]; error?: { message?: string } };
if (!getRes.ok) throw new Error(`Sheets read failed (${getRes.status}): ${getJson.error?.message}`);
const values = getJson.values ?? [];
const n = (v: unknown) => String(v ?? '').trim().toLowerCase();
const headerIdx = values.findIndex((r) => (r ?? []).some((c) => n(c) === 'department') && (r ?? []).some((c) => n(c) === 'personal email'));
if (headerIdx < 0) throw new Error('Sheet header row not found');
const headers = (values[headerIdx] ?? []).map((c) => n(c).replace(/\s+/g, ' '));
const W = headers.indexOf('work email');
const P = headers.indexOf('personal email');
const S = headers.indexOf('start date');
if (W < 0 || P < 0 || S < 0) throw new Error('Sheet is missing Work Email / Personal Email / Start Date');
const colLetter = (i: number) => { let s = ''; let k = i; do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0); return s; };

const clobberedSheet = toSheetDate(CLOBBERED_ISO);
const cellPlan: Array<{ workEmail: string; rowIdx: number; range: string; before: string; after: string }> = [];
for (const t of plan) {
  for (let i = headerIdx + 1; i < values.length; i++) {
    const r = values[i] ?? [];
    if (n(r[W]) !== t.workEmail || n(r[P]) !== t.ownerPersonal) continue;
    const before = String(r[S] ?? '').trim();
    if (before !== clobberedSheet) { console.log(`SKIP sheet ${t.workEmail} row ${i + 1}: reads ${before || '(blank)'}, not ${clobberedSheet}`); continue; }
    const after = toSheetDate(t.restoreTo);
    cellPlan.push({ workEmail: t.workEmail, rowIdx: i, range: `${quotedTab}!${colLetter(S)}${i + 1}`, before, after });
    console.log(`PLAN sheet ${t.workEmail.padEnd(20)} row ${i + 1}  ${before} → ${after}`);
  }
}

// ── 3. Backup, always ─────────────────────────────────────────────────────────
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const backupPath = join(dir, `restore-recycled-holder-start-dates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), apply: APPLY, plan, masterRows: masterBackup, sheetCells: cellPlan }, null, 2), 'utf8');
console.log(`\nBackup written: ${backupPath}`);

if (!APPLY) {
  console.log(`\nPLAN ONLY — nothing written. ${plan.length} db row(s), ${cellPlan.length} sheet cell(s). Re-run with --apply.`);
  process.exit(0);
}

// ── 4. Apply ──────────────────────────────────────────────────────────────────
let dbOk = 0;
for (const t of plan) {
  const { data, error } = await sb
    .from('global_master_list')
    .update({ 'Start Date': t.restoreTo })
    .eq('id', t.masterId)
    .eq('Start Date', CLOBBERED_ISO)
    .select('id, "Start Date"');
  if (error) { console.log(`FAIL db ${t.workEmail}: ${error.message}`); continue; }
  if ((data ?? []).length !== 1) { console.log(`SKIP db ${t.workEmail}: CAS matched ${(data ?? []).length} rows (changed under us)`); continue; }
  dbOk++;
}

let sheetOk = 0;
if (cellPlan.length) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: cellPlan.map((c) => ({ range: c.range, values: [[c.after]] })) }),
    cache: 'no-store',
  });
  if (!res.ok) console.log(`FAIL sheet batch (${res.status}): ${(await res.text()).slice(0, 200)}`);
  else {
    sheetOk = cellPlan.length;
    await formatCellsAsShortDate(cellPlan.map((c) => ({ row: c.rowIdx, col: S }))).catch(() => {});
  }
}

// ── 5. Read back ──────────────────────────────────────────────────────────────
console.log(`\nAPPLIED: ${dbOk}/${plan.length} db row(s), ${sheetOk}/${cellPlan.length} sheet cell(s). Read-back:`);
for (const t of plan) {
  const { data } = await sb.from('global_master_list').select('"Start Date"').eq('id', t.masterId).maybeSingle();
  const got = (data as { 'Start Date'?: string } | null)?.['Start Date'];
  console.log(`  db    ${t.workEmail.padEnd(20)} ${got} ${got === t.restoreTo ? 'OK' : 'MISMATCH'}`);
}
if (cellPlan.length) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?` +
      cellPlan.map((c) => `ranges=${encodeURIComponent(c.range)}`).join('&') + '&valueRenderOption=FORMATTED_VALUE',
    { headers: auth, cache: 'no-store' },
  );
  const j = (await res.json()) as { valueRanges?: Array<{ values?: unknown[][] }> };
  cellPlan.forEach((c, i) => {
    const got = String(j.valueRanges?.[i]?.values?.[0]?.[0] ?? '');
    console.log(`  sheet ${c.workEmail.padEnd(20)} row ${c.rowIdx + 1} ${got} ${got === c.after ? 'OK' : 'MISMATCH'}`);
  });
}

/**
 * Bulk-assign HSL sub-departments — the tool docs/features/hsl-subdepartments.md
 * §8 lists as missing ("No bulk sub-department assignment tool: 528 of 598 active
 * HSL people are still plain `HSL` and ride the parent rate").
 *
 * WHAT IT DOES. Relabels the master `Department` cell of active, plain-"HSL"
 * people to `hsl:<sub-team>` — in `global_master_list` AND the master Google
 * Sheet, because the sync keys identity on (Personal Email, Department) and a
 * DB-only move is reverted or duplicated on the next sync
 * (docs/features/department-transfers.md §6, the 2026-07-30 incident).
 *
 * WHAT IT IS NOT. It is NOT a transfer. Per hsl-subdepartments.md:243-246 a bulk
 * relabel must never write `department_transfer_requests` rows: those rows feed
 * `buildHslTransferEffectiveMap`, and an entry dated today would re-scope the
 * +₱15/h Sat/Sun weekend premium for everyone in it. So this writes none, sends
 * no `transfer.applied` notification, and does not appear in the Transfers tabs.
 *
 * THE SOURCE OF TRUTH IS THE KPI ROLE COLUMN. Kane, 2026-08-14: *"We will be
 * using the KPI Role Column as their Sub Departments"* and *"Please make sure
 * people under EGS is under EGS use the KPI Role Column as the sub department"*.
 * That is a deliberate override of the CSV's own "Proposed Sub-department"
 * column, which was derived from `hsl_team_members.dept_key` and predates the
 * 2026-08-14 Executive Guest Services + Hearing Prep Mail Sorting work.
 * ROLE_TO_SUBKEY below is the whole decision, and it is DECLARED, never inferred:
 * a role string that is not in the table is SKIPPED and reported, never guessed
 * (hsl-subdepartments.md:271-278 — "rules are never guessed, because they change
 * pay").
 *
 * RATE NEUTRALITY — the thing Kane actually asked for ("we will take their
 * current rates from the Hogan Smith Law Department which was individually
 * set"). Proven three ways, and Guard 6 refuses to run if the proof breaks:
 *   - An INDIVIDUAL catalog rate is keyed by EMAIL alone (`buildCatalogRateIndex`
 *     → `byEmail`, resolve-rate.ts:68-80). The department cell is never read on
 *     that leg, so a relabel cannot move it.
 *   - The SHEET leg (`employee_hourly_rates` / `employee_rate_history`) is also
 *     email-keyed.
 *   - The DEPARTMENT leg is the only one that reads a department, and it resolves
 *     sub-first with the parent as a PERMANENT fallback (hsl-subdepartments.md
 *     §2). With no `hsl:<key>` structure — or one whose figures equal the parent
 *     base — resolution is numerically identical. Guard 6 proves that per target.
 *   Additionally both payout engines prefer `employee_hourly_rates."Department"`,
 *   which the HSL mirror flattens to "Hogan Smith Law" for every HSL row
 *   (current-pay.ts:1047-1051, disbursement-reports.ts:1255) — the HARD HOLD at
 *   hsl-subdepartments.md:412-416 is still in force, so the department leg does
 *   not even see the new cell for anyone with a rates row.
 *
 * GUARDS (every one fails CLOSED):
 *   1. Key validity — every target is validated by IMPORTING both keyspaces from
 *      src/lib/departments/hsl-subdept.ts, so this cannot write a key the app
 *      does not recognise, and `isPlaceableDeptLabel` must accept it.
 *   2. Complete mapping — an unmapped KPI Role skips that person and is reported.
 *   3. Source state — only ACTIVE people whose cell is currently plain "HSL".
 *      Anyone already sub-labeled, offboarded, off the current upload, or in
 *      another department is skipped and reported. A relabel is not a rescue.
 *   4. One row per person — refuses to touch anybody holding more than one active
 *      master row (planDepartmentApply's rule-3 fallback moves ALL rows of a
 *      multi-row person; a dual-role collapse is not this script's call).
 *   5. Backup first — every affected master row is written to reports/ before any
 *      write (CLAUDE.md: a SELECT backup on disk precedes every bulk UPDATE).
 *   6. Rate neutrality — aborts if any target `hsl:<key>` department-scope pay
 *      structure exists whose figures differ from the parent `hogan_smith_law`
 *      base. A differing figure means the relabel would REPRICE whoever rides the
 *      department base, which is a rate change, not a placement.
 *   7. No transfer rows — asserted structurally: this script never opens
 *      `department_transfer_requests`.
 *
 * THE GOOGLE SHEET. Written in ONE read + ONE batchUpdate (486 per-person calls
 * would rate-limit). Matching mirrors update-master-sheet-department.ts exactly:
 * same header detection, same email match, same "row must currently sit in the
 * source department" requirement. A Sheet failure is FATAL here, unlike the
 * best-effort per-transfer path — a half-written bulk relabel is precisely what
 * the 2026-07-30 clobber incident looked like.
 *
 * USAGE
 *   node --import tsx scripts/bulk-assign-hsl-subdepartments.mts            # dry run + plan CSV
 *   node --import tsx scripts/bulk-assign-hsl-subdepartments.mts --apply    # writes DB + Sheet
 *   …--db-only     # skip the Sheet write (leaves the clobber risk open — say why)
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const DB_ONLY = process.argv.includes('--db-only');
const CSV_PATH = 'references/docs/HSL - Subdepartments.csv';
const MASTER_TABLE = 'global_master_list';
const AUDIT_TABLE = 'audit_log';
const ACTOR = 'kaner@simple.biz';
const PARENT_KEY = 'hogan_smith_law';
const SOURCE_LABEL = 'HSL';

/**
 * KPI Role (role_raw) → HSL sub-team key. THE decision in this script.
 *
 * Keys are the normalized role string (lowercased, whitespace collapsed).
 * Every value is validated against the live keyspaces by Guard 1.
 *
 * Deliberately NOT mapped. These role strings name no team, so they were put to
 * Kane rather than guessed, and he ruled on 2026-08-14 that all three STAY on
 * the plain "HSL" cell:
 *     "Dan Smith EA"          (vanessad@)
 *     "Dan Smith EA- Med Rec" (angelicai@)
 *     "Rick's Assistant"      (amiea@)
 * Leaving them unmapped is what enacts that ruling — Guard 2 skips and reports
 * them. Do NOT add a mapping for these without asking again; a bare "HSL" cell
 * is not placeable for a NEW placement (isPlaceableDeptLabel) but is perfectly
 * legal to leave standing, and all three ride the parent ₱225 fallback exactly
 * as they do today.
 */
export const ROLE_TO_SUBKEY: Record<string, string> = {
  // ── Intake Specialist ──────────────────────────────────────────────────────
  'intake specialist': 'intake_specialist',
  'intake specialist asst tl': 'intake_specialist',
  'intake specialist asst tl-trainer': 'intake_specialist',
  'intake specialist team captain': 'intake_specialist',
  'intake specialist manager': 'intake_specialist',
  // Intake QC names no team of its own; it is an Intake function, and the KPI
  // roster already scores the one assigned QC (danmp@) under intake_specialist.
  'intake qc-1st shift': 'intake_specialist',
  'intake qc-2nd shift': 'intake_specialist',
  'intake qc-3rd shift': 'intake_specialist',

  // ── Callback Team ──────────────────────────────────────────────────────────
  // "Intake Callback" is the Callback Team. NOTE this is the one place the role
  // column and the KPI roster disagree: the roster has these people on
  // intake_specialist (callback_team has zero roster rows). Kane's instruction
  // is the role column, and callback_team is a real, placeable, priceable key.
  'intake callback': 'callback_team',
  'intake callback asst tl': 'callback_team',

  // ── Filing Specialist ──────────────────────────────────────────────────────
  'filing specialist': 'filing_specialist',
  'filing assistant team leader': 'filing_specialist',
  'filing team supervisor': 'filing_specialist',
  'filing specialist manager': 'filing_specialist',

  // ── Attestation ────────────────────────────────────────────────────────────
  'attestation': 'attestation',
  'attestation assistant team leader': 'attestation',
  'attestation team supervisor': 'attestation',

  // ── Case Managers ──────────────────────────────────────────────────────────
  'case manager': 'case_managers',
  'case mangr': 'case_managers',
  'case management assistant team leader': 'case_managers',
  'case management manager': 'case_managers',

  // ── Collections ────────────────────────────────────────────────────────────
  'collection': 'collections',
  'collections manager': 'collections',

  // ── SSD Medical Records (the "Pre-Hearing Litigation" family) ──────────────
  // The role string names no key, but this IS that team: all 55 live
  // hsl_team_members rows for these roles sit on ssd_medical_records, and the
  // CSV's own 49 derived assignments agree with zero disagreements.
  'pre-hearing litigation': 'ssd_medical_records',
  'pre-hearing litigation-team captain': 'ssd_medical_records',
  'pre-hearing litigation-poc': 'ssd_medical_records',
  'pre-hearing litigation- vicky’s asst tl': 'ssd_medical_records',
  "pre-hearing litigation- vicky's asst tl": 'ssd_medical_records',
  "pre-hearing litigation / vicky's asst tl (accounting)": 'ssd_medical_records',
  "pre-hearing litigation- chelzy's asst": 'ssd_medical_records',
  'ssd medical records manager': 'ssd_medical_records',
  // Claudia's Asst (rochelled@) — role names no team, but the KPI roster has her
  // on ssd_medical_records and her CSV row already proposed it.
  "claudia's asst": 'ssd_medical_records',

  // ── Pre-/Post-Hearing Prep ─────────────────────────────────────────────────
  'pre-hearing prep team': 'post_hearing_prep',
  'pre-hearing prep team asst tl': 'post_hearing_prep',
  'pre-hearing manager': 'post_hearing_prep',
  'post-hearing prep team': 'post_hearing_prep',
  'post-hearing asst tl': 'post_hearing_prep',
  'post-hearing manager': 'post_hearing_prep',

  // ── Hearing Prep Team – Mail Sorting (placement-only, added 2026-08-14) ────
  'hearing prep team-mail sorting': 'hearing_prep_mail_sorting',
  'mail-sorting': 'hearing_prep_mail_sorting',
  'mail-sorting team leader': 'hearing_prep_mail_sorting',

  // ── Executive Guest Services (§7a noKpi roster-only, added 2026-08-14) ─────
  // Kane 2026-08-14: "Please make sure people under EGS is under EGS".
  'executive guest services': 'executive_guest_services',
  'executive guest services team capt': 'executive_guest_services',
  'executive guest services team captain': 'executive_guest_services',
  'guest services manager': 'executive_guest_services',

  // ── Simple Texting (placement-only) ────────────────────────────────────────
  'simple texting': 'simple_texting',

  // ── Managers Weekly ────────────────────────────────────────────────────────
  // Kane, 2026-08-14, ruling on gyd@ (the only "Operations Manager"). Every OTHER
  // manager/TL goes to the team their role names (e.g. "Intake Specialist
  // Manager" → intake_specialist); this key is for leadership whose role names no
  // team. Placement does not touch the manager bonus either way: calcManagerBonus
  // looks up HSL_MANAGERS_BY_EMAIL by EMAIL alone (schema.ts), never a department.
  'operations manager': 'hsl_managers',

  // ── Care / Healthcare ──────────────────────────────────────────────────────
  'care team': 'care_team',
  'healhcare team': 'care_team', // sic — the roster's spelling
  'healthcare team': 'care_team',
  'healhcare team-team leader': 'healthcare_team_lead',
  'healthcare team-team leader': 'healthcare_team_lead',
};

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

const normRole = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
const normEmail = (s: unknown): string => String(s ?? '').trim().toLowerCase();

interface MasterRow {
  id: string;
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  Department: string | null;
  off_boarded_at: string | null;
  last_seen_upload_id: string | null;
}

/** PostgREST caps every read at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(table: string, cols: string, orderCol = 'id'): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await db
      .from(table)
      .select(cols)
      .order(orderCol, { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) die(`reading ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let f = '', r: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); f = ''; rows.push(r); r = []; }
    else if (c !== '\r') f += c;
  }
  if (f.length || r.length) { r.push(f); rows.push(r); }
  return rows;
}

const csvCell = (v: string): string =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

// ── Google Sheet: one read, one batchUpdate ──────────────────────────────────
// Mirrors update-master-sheet-department.ts (header detection, email match, and
// the "row must currently sit in the source department" requirement) but batched,
// because 486 per-person round-trips would rate-limit.

const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const sheetNorm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map(sheetNorm);
    const hasDept = row.some((c) => c === 'department');
    const hasName = row.some((c) => c === 'name');
    const hasPersonal = row.some((c) => c === 'personal email' || c === 'personalemail');
    if (hasDept && (hasName || hasPersonal)) return i;
  }
  return -1;
}

function columnToLetter(column: number): string {
  let temp: number;
  let letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

interface SheetPlan {
  quotedTab: string;
  updates: Array<{ range: string; to: string; who: string }>;
  /** Master-row ids whose Sheet cell was found sitting in the source department.
   *  Guard 8 writes the DB for THESE ONLY — see the comment at its call site. */
  matchedIds: Set<string>;
  unmatched: Array<{ id: string; who: string; sheetDept: string | null }>;
  token: string;
  sheetId: string;
}

async function planSheetWrites(
  targets: Array<{ id: string; workEmail: string; personalEmail: string; to: string; who: string }>,
): Promise<SheetPlan> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) die('GOOGLE_SHEETS_MASTER_SHEET_ID / _TAB_NAME not configured');

  const { getServiceAccountAccessToken } = await import('../src/lib/google-sheets/auth.js').catch(
    (e: unknown) => die(`could not import google-sheets/auth: ${String(e)}`),
  );
  const token = await getServiceAccountAccessToken(SHEETS_WRITE_SCOPE);
  const quotedTab = `'${tabName!.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
      `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  const json = (await res.json()) as { values?: unknown[][]; error?: { message?: string } };
  if (!res.ok) die(`Sheets read failed (${res.status}): ${json.error?.message ?? res.statusText}`);

  const values = Array.isArray(json.values) ? json.values : [];
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) die('header row not found in the master sheet');
  const headers = (values[headerIdx] ?? []).map(sheetNorm);
  const deptCol = headers.findIndex((h) => h === 'department');
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex((h) => h === 'personal email' || h === 'personalemail');
  if (deptCol < 0) die('no Department column in the master sheet');

  const deptLetter = columnToLetter(deptCol + 1);
  const updates: SheetPlan['updates'] = [];
  const unmatched: SheetPlan['unmatched'] = [];
  const matchedIds = new Set<string>();
  const from = SOURCE_LABEL.toLowerCase();

  for (const t of targets) {
    let hit = false;
    // What the Sheet says this person's department is, regardless of whether it
    // matches the source — reported on a miss so a DRIFTED sheet row is legible
    // (valeriec@ on 2026-08-14: DB "HSL", Sheet "Lead Gen").
    let sheetDept: string | null = null;
    for (let i = headerIdx + 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const rowWork = workCol >= 0 ? sheetNorm(row[workCol]) : '';
      const rowPersonal = personalCol >= 0 ? sheetNorm(row[personalCol]) : '';
      const matchEmail =
        (t.workEmail && rowWork === t.workEmail) || (t.personalEmail && rowPersonal === t.personalEmail);
      if (!matchEmail) continue;
      if (sheetDept == null) sheetDept = String(row[deptCol] ?? '').trim();
      if (sheetNorm(row[deptCol]) !== from) continue;
      updates.push({ range: `${quotedTab}!${deptLetter}${i + 1}`, to: t.to, who: t.who });
      matchedIds.add(t.id);
      hit = true;
    }
    if (!hit) unmatched.push({ id: t.id, who: `${t.who} (${t.workEmail || t.personalEmail})`, sheetDept });
  }
  return { quotedTab, updates, matchedIds, unmatched, token, sheetId: sheetId! };
}

async function commitSheetWrites(plan: SheetPlan): Promise<number> {
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < plan.updates.length; i += CHUNK) {
    const slice = plan.updates.slice(i, i + CHUNK);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${plan.sheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${plan.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: slice.map((u) => ({ range: u.range, values: [[u.to]] })),
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      die(
        `Sheets batchUpdate failed (${res.status}) after ${written} cells: ${txt.slice(0, 300)}\n` +
          `  The DB has NOT been written yet — rerun once the Sheet accepts writes.`,
      );
    }
    written += slice.length;
    console.log(`   sheet: ${written}/${plan.updates.length} cells written`);
  }
  return written;
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nBulk HSL sub-department assignment — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source of truth for the sub-team: the CSV's "KPI Role (role_raw)" column.\n`);

  // Guard 1 — key validity, straight from the app's own keyspaces.
  const subMod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) =>
    die(`could not import src/lib/departments/hsl-subdept: ${String(e)}`),
  );
  const { HSL_PLACEMENT_ONLY_SUB_KEYS, isPlaceableDeptLabel, hslSubDeptLabel, formatDeptLabel } =
    subMod as {
      HSL_PLACEMENT_ONLY_SUB_KEYS: readonly string[];
      isPlaceableDeptLabel: (r: string) => boolean;
      hslSubDeptLabel: (k: string) => string;
      formatDeptLabel: (r: string) => string;
    };
  const schemaMod = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) =>
    die(`could not import src/lib/hsl-bonus/schema: ${String(e)}`),
  );
  const { HSL_DEPT_KEYS } = schemaMod as { HSL_DEPT_KEYS: readonly string[] };
  const validKeys = new Set([...HSL_DEPT_KEYS, ...HSL_PLACEMENT_ONLY_SUB_KEYS]);
  if (validKeys.size < 2) die('imported keyspaces are empty — refusing to guess');

  for (const [role, key] of Object.entries(ROLE_TO_SUBKEY)) {
    if (!validKeys.has(key))
      die(`ROLE_TO_SUBKEY["${role}"] = "${key}" is not a live sub-team key (${[...validKeys].join(', ')})`);
    const label = hslSubDeptLabel(key);
    if (!isPlaceableDeptLabel(label))
      die(`"${label}" is not placeable — isPlaceableDeptLabel rejected it`);
  }
  console.log(`Guard 1 OK — ${Object.keys(ROLE_TO_SUBKEY).length} role mappings, all targets live + placeable.`);

  // ── read live state ────────────────────────────────────────────────────────
  const { data: up, error: upErr } = await db
    .from('master_list_uploads')
    .select('id,source_file,uploaded_at')
    .eq('is_current', true)
    .maybeSingle();
  if (upErr) die(`reading master_list_uploads: ${upErr.message}`);
  const currentUpload = (up as { id?: string } | null)?.id ?? null;
  if (!currentUpload) die('no current master_list_upload — refusing to judge who is active');
  console.log(`Current master upload: ${currentUpload}`);

  const master = await selectAllPaged<MasterRow>(
    MASTER_TABLE,
    'id,"Name","Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id',
  );
  const isActive = (r: MasterRow) => !r.off_boarded_at && r.last_seen_upload_id === currentUpload;
  console.log(`Master rows: ${master.length} (${master.filter(isActive).length} active)`);

  const activeByEmail = new Map<string, MasterRow[]>();
  for (const r of master) {
    if (!isActive(r)) continue;
    for (const e of [normEmail(r['Work Email']), normEmail(r['Personal Email'])]) {
      if (e) activeByEmail.set(e, [...(activeByEmail.get(e) ?? []), r]);
    }
  }

  // Guard 6 — rate neutrality per target key.
  const structures = await selectAllPaged<{
    id: string; scope: string; department_key: string; regular_rate: unknown; ot_rate: unknown; currency: string;
  }>('payment_catalog_pay_structures', 'id,scope,department_key,regular_rate,ot_rate,currency', 'created_at');
  const deptStructs = new Map(
    structures.filter((s) => s.scope === 'department').map((s) => [s.department_key, s]),
  );
  const parent = deptStructs.get(PARENT_KEY);
  if (!parent) die(`no department-scope structure for "${PARENT_KEY}" — cannot prove rate neutrality`);
  const num = (v: unknown) => (v == null ? null : Number(v));
  console.log(
    `Parent base: ₱${num(parent.regular_rate)} / ₱${num(parent.ot_rate)} ${parent.currency}`,
  );

  // ── build the plan ─────────────────────────────────────────────────────────
  const csv = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const header = csv[0].map((h) => h.trim());
  const iEmail = header.indexOf('Work Email');
  const iName = header.indexOf('Name');
  const iRole = header.indexOf('KPI Role (role_raw)');
  const iProposed = header.indexOf('Proposed Sub-department');
  const iRateSrc = header.indexOf('Rate Source');
  const iRate = header.indexOf('Current Regular Rate');
  if (iEmail < 0 || iRole < 0) die(`CSV is missing "Work Email" / "KPI Role (role_raw)": ${header.join(', ')}`);

  interface Planned {
    email: string; name: string; role: string; key: string; to: string;
    row: MasterRow; csvProposed: string; rateSrc: string; rate: string;
  }
  const planned: Planned[] = [];
  const skipped: Array<{ email: string; name: string; role: string; why: string }> = [];

  for (const r of csv.slice(1)) {
    if (r.length <= iRole || !r[iEmail]?.trim()) continue;
    const email = normEmail(r[iEmail]);
    const name = (r[iName] ?? '').trim();
    const roleRaw = (r[iRole] ?? '').replace(/\s*\n\s*/g, ' / ').trim();
    const key = ROLE_TO_SUBKEY[normRole(roleRaw)];

    // Guard 2 — unmapped role.
    if (!key) {
      skipped.push({ email, name, role: roleRaw, why: `NO MAPPING for KPI Role "${roleRaw}"` });
      continue;
    }

    const rows = activeByEmail.get(email) ?? [];
    // Guard 3 — must be active.
    if (rows.length === 0) {
      skipped.push({ email, name, role: roleRaw, why: 'no ACTIVE master row (offboarded or off the current upload)' });
      continue;
    }
    // Guard 4 — exactly one active row.
    if (new Set(rows.map((x) => x.id)).size > 1) {
      skipped.push({
        email, name, role: roleRaw,
        why: `${rows.length} active master rows [${rows.map((x) => x.Department).join(' | ')}] — a dual-role collapse is not this script's call`,
      });
      continue;
    }
    const row = rows[0];
    // Guard 3 — must currently be plain "HSL".
    const cell = (row.Department ?? '').trim();
    if (cell.toLowerCase() !== SOURCE_LABEL.toLowerCase()) {
      skipped.push({ email, name, role: roleRaw, why: `not plain "HSL" — currently "${cell}"` });
      continue;
    }

    planned.push({
      email, name, role: roleRaw, key, to: hslSubDeptLabel(key), row,
      csvProposed: (r[iProposed] ?? '').trim(),
      rateSrc: (r[iRateSrc] ?? '').trim(),
      rate: (r[iRate] ?? '').trim(),
    });
  }

  // Guard 6 (cont.) — every target key must be rate-neutral.
  const targetKeys = [...new Set(planned.map((p) => p.key))].sort();
  const violations: string[] = [];
  for (const k of targetKeys) {
    const s = deptStructs.get(`hsl:${k}`);
    if (!s) continue; // no row → parent fallback → numerically identical
    const same =
      num(s.regular_rate) === num(parent.regular_rate) &&
      num(s.ot_rate) === num(parent.ot_rate) &&
      s.currency === parent.currency;
    if (!same) {
      violations.push(
        `hsl:${k} = ₱${num(s.regular_rate)}/₱${num(s.ot_rate)} ${s.currency} ≠ parent ` +
          `₱${num(parent.regular_rate)}/₱${num(parent.ot_rate)} ${parent.currency}`,
      );
    }
  }
  if (violations.length) {
    die(
      `Guard 6 (rate neutrality) FAILED — a target sub-team is priced differently from the parent, ` +
        `so this relabel would REPRICE anyone riding the department base:\n   ` +
        violations.join('\n   ') +
        `\n   That is a rate change, not a placement. Decide it in Payment Catalog → Pay Structure.`,
    );
  }
  console.log(
    `Guard 6 OK — ${targetKeys.length} target sub-teams, ` +
      `${targetKeys.filter((k) => deptStructs.has(`hsl:${k}`)).length} priced (all equal to the parent), ` +
      `rest ride the parent fallback. No resolved rate can move.`,
  );

  // ── report ─────────────────────────────────────────────────────────────────
  const byKey = new Map<string, number>();
  for (const p of planned) byKey.set(p.key, (byKey.get(p.key) ?? 0) + 1);
  console.log(`\nPLAN — ${planned.length} people to relabel:`);
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${formatDeptLabel(`hsl:${k}`).padEnd(38)} ${String(v).padStart(3)}   (hsl:${k})`);
  }
  const changedVsCsv = planned.filter((p) => p.csvProposed && p.csvProposed !== p.to);
  console.log(`\n   of which DIFFER from the CSV's own "Proposed Sub-department": ${changedVsCsv.length}`);
  const cvcByPair = new Map<string, number>();
  for (const p of changedVsCsv) {
    const k = `${p.csvProposed} → ${p.to}`;
    cvcByPair.set(k, (cvcByPair.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...cvcByPair.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(60)} ${v}`);
  }

  console.log(`\nSKIPPED — ${skipped.length}:`);
  const skipByWhy = new Map<string, number>();
  for (const s of skipped) {
    const bucket = s.why.startsWith('NO MAPPING') ? `NO MAPPING: "${s.role}"` : s.why.split(' — ')[0];
    skipByWhy.set(bucket, (skipByWhy.get(bucket) ?? 0) + 1);
  }
  for (const [k, v] of [...skipByWhy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(v).padStart(3)}  ${k}`);
  }
  for (const s of skipped) console.log(`        · ${s.email.padEnd(30)} ${s.why}`);

  // Plan CSV, always written — this is the review artifact.
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const planPath = path.join('reports', `hsl-subdept-plan-${stamp}.csv`);
  writeFileSync(
    planPath,
    [
      'Action,Name,Work Email,KPI Role,From,To,Display,CSV Proposed,Differs From CSV,Rate Source,Current Rate,Reason',
      ...planned.map((p) =>
        [
          'RELABEL', p.name, p.email, p.role, SOURCE_LABEL, p.to, formatDeptLabel(p.to),
          p.csvProposed || '(blank)', p.csvProposed && p.csvProposed !== p.to ? 'YES' : '',
          p.rateSrc, p.rate, '',
        ].map(csvCell).join(','),
      ),
      ...skipped.map((s) =>
        ['SKIP', s.name, s.email, s.role, '', '', '', '', '', '', '', s.why].map(csvCell).join(','),
      ),
    ].join('\n'),
    'utf8',
  );
  console.log(`\nPlan CSV → ${planPath}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Review the plan CSV, then rerun with --apply.`);
    return;
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  if (planned.length === 0) die('nothing to do');

  // Guard 5 — backup BEFORE any write.
  const backupPath = path.join('reports', `backup_hsl_master_dept_${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      planned.map((p) => ({
        id: p.row.id, name: p.row.Name, work_email: p.row['Work Email'],
        personal_email: p.row['Personal Email'], department_before: p.row.Department,
        department_after: p.to,
      })),
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Guard 5 OK — backup of ${planned.length} rows → ${backupPath}`);

  // Sheet FIRST. The sync's identity key is (Personal Email, Department): if the
  // Sheet keeps saying "HSL" while the DB says hsl:<key>, the next sync mints a
  // duplicate HSL row and the sub-labeled row goes not-last-seen — invisible.
  // Writing the Sheet first means a failure here leaves BOTH stores consistent.
  // Guard 8 — the DB write set is the SHEET-MATCHED set, never the planned set.
  //
  // Learned the hard way on the 2026-08-14 run: valeriec@ had DB "HSL" but a
  // Sheet row reading "Lead Gen" (the Sheet had drifted two weeks past the last
  // sync). The Sheet matcher correctly declined to touch her row, but the DB
  // write ran for every planned person regardless — so the DB briefly asserted
  // an HSL sub-team placement the Sheet contradicted. Reverted by hand.
  //
  // The Sheet is the roster's source of truth: a DB row the Sheet disagrees with
  // is not a placement, it is a pending clobber. So a person whose Sheet cell is
  // not sitting in the source department is dropped from the DB write and
  // reported for a human to reconcile — never quietly relabeled.
  let writeSet = planned;
  if (DB_ONLY) {
    console.log('\n--db-only — SKIPPING the Google Sheet. The next master sync can clobber this.');
  } else {
    console.log(`\nPlanning Google Sheet writes…`);
    const sheetPlan = await planSheetWrites(
      planned.map((p) => ({
        id: p.row.id,
        workEmail: normEmail(p.row['Work Email']),
        personalEmail: normEmail(p.row['Personal Email']),
        to: p.to,
        who: p.name || p.email,
      })),
    );
    console.log(`   ${sheetPlan.updates.length} sheet cells matched; ${sheetPlan.unmatched.length} unmatched`);
    for (const u of sheetPlan.unmatched) {
      console.log(
        `      UNMATCHED (DB write SKIPPED): ${u.who} — sheet says ` +
          `${u.sheetDept == null ? 'NO ROW FOUND' : `"${u.sheetDept}"`}, not "${SOURCE_LABEL}"`,
      );
    }
    if (sheetPlan.updates.length === 0) die('no sheet cells matched — refusing to write the DB alone');
    await commitSheetWrites(sheetPlan);
    writeSet = planned.filter((p) => sheetPlan.matchedIds.has(p.row.id));
  }

  // DB. One UPDATE per row, by primary key — never a Department filter, which
  // would hit whatever matches at execution time rather than the rows proved.
  console.log(`\nWriting ${writeSet.length} master rows…`);
  let ok = 0;
  const failures: string[] = [];
  for (const p of writeSet) {
    const { error } = await db.from(MASTER_TABLE).update({ Department: p.to }).eq('id', p.row.id);
    if (error) failures.push(`${p.email}: ${error.message}`);
    else ok++;
    if (ok % 50 === 0) console.log(`   ${ok}/${writeSet.length}`);
  }
  console.log(`   ${ok}/${writeSet.length} written; ${failures.length} failed`);
  for (const f of failures) console.log(`      FAIL ${f}`);

  // audit_log column names come from src/lib/supabase/audit-log.ts:120 —
  // user_name / user_role / action / resource / resource_id / details.
  // (`actor_email` / `resource_type` / `metadata` do not exist and 400.)
  const { error: auditErr } = await db.from(AUDIT_TABLE).insert({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'hsl.subdept.bulk_assign',
    resource: 'global_master_list',
    resource_id: 'bulk',
    details: {
      source: CSV_PATH,
      derivedFrom: 'KPI Role (role_raw) column',
      planned: planned.length,
      written: ok,
      failed: failures.length,
      skipped: skipped.length,
      sheetWritten: !DB_ONLY,
      sheetSkippedDbWrites: planned.length - writeSet.length,
      byKey: Object.fromEntries(byKey),
      backup: backupPath,
      plan: planPath,
    },
  });
  if (auditErr) console.log(`   NOTE: audit row failed (${auditErr.message}) — the writes stand.`);

  console.log(`\nDONE. Backup ${backupPath} · plan ${planPath}`);
})();

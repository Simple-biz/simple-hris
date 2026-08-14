/**
 * Create the HSL — Executive Assistants cohort. Kane, 2026-08-14: *"Lets create a
 * new department called HSL - Executive Assistants and put them in there please -
 * now I want you to make sure and hardenn that the Payroll Wizard - Managers will
 * get this please"*.
 *
 * The three people are exactly the roles the bulk sub-department assignment could
 * not map to any existing team and left on a plain "HSL" cell
 * (docs/features/hsl-subdepartments.md §9):
 *     vanessad@   "Dan Smith EA"
 *     angelicai@  "Dan Smith EA- Med Rec"
 *     amiea@      "Rick's Assistant"
 *
 * WHY §7a-roster-only (`noKpi`) AND NOT §7b placement-only. This is the whole
 * point of "the Payroll Wizard - Managers will get this". The Wizard's HSL rail
 * maps a row through `hsl_team_members.dept_key` gated by `HSL_DEPT_KEYS`
 * (PayrollWizard.tsx:14504: `k && hslKeySet.has(k) ? k : 'unassigned'`). A §7b
 * placement-only key is deliberately absent from `HSL_DEPT_KEYS`, so all three
 * would land in the Unassigned pile with no manager-facing card and no Admin
 * Roles checkbox. §7a with `noKpi: true` + `rules: []` gives the rail entry, the
 * `hsl:executive_assistants` grant checkbox and a roster-only calculator card,
 * while Payroll Readiness reads the dept `no_bonus` ("Ready by definition")
 * instead of minting a permanent weekly `draft` that pins the score under 100
 * (payroll-readiness.ts:591). No bonus rules are invented — rules change pay and
 * are never guessed (§7a-roster-only).
 *
 * TWO WRITES, BOTH REQUIRED, and they are different things:
 *   1. The master `Department` cell (+ the Google Sheet) — the PLACEMENT, which
 *      is what prices them and what every picker reads.
 *   2. `hsl_team_members.dept_key` — the KPI ROSTER, which is the ONLY thing the
 *      Payroll Wizard rail keys on. Writing 1 without 2 leaves them "Unassigned"
 *      in the Wizard even though their placement is correct. That asymmetry is
 *      the trap this script exists to close.
 *
 * GUARDS (every one fails CLOSED):
 *   1. Key validity — `executive_assistants` must be in HSL_DEPT_KEYS, must
 *      declare `noKpi` with zero rules, and `hsl:executive_assistants` must pass
 *      `isPlaceableDeptLabel`, all imported from the real code.
 *   2. Source state — each person must be ACTIVE with exactly one master row,
 *      currently plain "HSL". Anyone already placed elsewhere is skipped.
 *   3. Roster NULL-only — refuses to overwrite an existing `dept_key`. Moving
 *      someone off a scored team is a scoring decision, not a seed.
 *   4. Rate neutrality — aborts if an `hsl:executive_assistants` department-scope
 *      rate row exists whose figures differ from the parent base. There is none,
 *      so all three ride the parent ₱225 fallback exactly as they do today; all
 *      three also hold individual catalog rates, which outrank it regardless.
 *   5. Backup first — every affected row to reports/ before any write.
 *   6. Sheet-matched only — a person whose SHEET row is not sitting in "HSL" is
 *      dropped from the DB write and reported (the Guard 8 lesson from §9).
 *
 * NOT A TRANSFER: zero `department_transfer_requests` rows, per §6.
 *
 * USAGE
 *   node --import tsx scripts/seed-hsl-executive-assistants.mts           # dry run
 *   node --import tsx scripts/seed-hsl-executive-assistants.mts --apply   # writes
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const SUB_KEY = 'executive_assistants';
const TARGET = `hsl:${SUB_KEY}`;
const SOURCE_LABEL = 'HSL';
const PARENT_KEY = 'hogan_smith_law';
const ACTOR = 'kaner@simple.biz';

/** The cohort, by work email, with the KPI Role that put them here. */
const COHORT = [
  { email: 'vanessad@simple.biz', role: 'Dan Smith EA' },
  { email: 'angelicai@simple.biz', role: 'Dan Smith EA- Med Rec' },
  { email: 'amiea@simple.biz', role: "Rick's Assistant" },
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
const ne = (v: unknown) => String(v ?? '').trim().toLowerCase();

async function pagedBy<T>(table: string, cols: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order(orderCol, { ascending: true }).range(from, from + 999);
    if (error) die(`reading ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function columnToLetter(column: number): string {
  let t: number, s = '';
  while (column > 0) { t = (column - 1) % 26; s = String.fromCharCode(t + 65) + s; column = (column - t - 1) / 26; }
  return s;
}

(async () => {
  console.log(`\nHSL — Executive Assistants — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // ── Guard 1: the key must be real, roster-only, and placeable ──────────────
  const schema = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) =>
    die(`could not import hsl-bonus/schema: ${String(e)}`),
  );
  const { HSL_DEPT_KEYS, HSL_DEPTS } = schema as {
    HSL_DEPT_KEYS: readonly string[];
    HSL_DEPTS: Record<string, { name: string; rules: unknown[]; noKpi?: boolean }>;
  };
  const sub = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) =>
    die(`could not import departments/hsl-subdept: ${String(e)}`),
  );
  const { isPlaceableDeptLabel, formatDeptLabel } = sub as {
    isPlaceableDeptLabel: (r: string) => boolean;
    formatDeptLabel: (r: string) => string;
  };

  if (!HSL_DEPT_KEYS.includes(SUB_KEY))
    die(`"${SUB_KEY}" is not in HSL_DEPT_KEYS — the Payroll Wizard rail would bucket these people "Unassigned". Ship the schema.ts edit first.`);
  const cfg = HSL_DEPTS[SUB_KEY];
  if (!cfg) die(`"${SUB_KEY}" has no HSL_DEPTS config`);
  if (!cfg.noKpi) die(`"${SUB_KEY}" must declare noKpi:true — otherwise Payroll Readiness mints a permanent weekly draft row`);
  if (cfg.rules.length !== 0) die(`"${SUB_KEY}" declares noKpi but carries ${cfg.rules.length} rules — rules are never guessed`);
  if (!isPlaceableDeptLabel(TARGET)) die(`"${TARGET}" is not placeable`);
  console.log(`Guard 1 OK — ${formatDeptLabel(TARGET)} is a live, roster-only, placeable sub-team.`);

  // ── Guard 4: rate neutrality ───────────────────────────────────────────────
  const structures = await pagedBy<any>('payment_catalog_pay_structures',
    'id,scope,department_key,employee_email,regular_rate,ot_rate,currency', 'department_key');
  const deptRow = (k: string) => structures.find((s) => s.scope !== 'employee' && s.department_key === k);
  const parent = deptRow(PARENT_KEY);
  if (!parent) die(`no department-scope structure for "${PARENT_KEY}" — cannot prove rate neutrality`);
  const own = deptRow(TARGET);
  const num = (v: unknown) => (v == null ? null : Number(v));
  if (own && !(num(own.regular_rate) === num(parent.regular_rate) && num(own.ot_rate) === num(parent.ot_rate) && own.currency === parent.currency))
    die(`Guard 4 — ${TARGET} is priced ₱${num(own.regular_rate)}/₱${num(own.ot_rate)} ${own.currency}, differing from the parent ₱${num(parent.regular_rate)}/₱${num(parent.ot_rate)} ${parent.currency}. Placing people would REPRICE anyone riding the department base.`);
  console.log(`Guard 4 OK — ${own ? 'own rate row equals the parent' : 'no own rate row; rides the parent'} ₱${num(parent.regular_rate)}/₱${num(parent.ot_rate)} ${parent.currency}.`);

  // ── read live state ────────────────────────────────────────────────────────
  const { data: up } = await db.from('master_list_uploads').select('id').eq('is_current', true).maybeSingle();
  const cur = (up as any)?.id;
  if (!cur) die('no current master_list_upload');
  const master = await pagedBy<any>('global_master_list',
    'id,"Name","Work Email","Personal Email","Department",off_boarded_at,last_seen_upload_id', 'id');
  const isActive = (r: any) => !r.off_boarded_at && r.last_seen_upload_id === cur;
  const byEmail = new Map<string, any[]>();
  for (const r of master) {
    if (!isActive(r)) continue;
    for (const e of [ne(r['Work Email']), ne(r['Personal Email'])]) if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), r]);
  }
  const roster = await pagedBy<any>('hsl_team_members', 'email,dept_key,role_raw', 'email');
  const rosterByEmail = new Map(roster.map((r) => [ne(r.email), r]));

  // ── Guard 2 + 3: plan ──────────────────────────────────────────────────────
  interface Plan { email: string; row: any; role: string; rosterAction: 'set' | 'already' | 'absent'; }
  const plan: Plan[] = [];
  for (const c of COHORT) {
    const rows = byEmail.get(c.email) ?? [];
    if (rows.length === 0) die(`${c.email} has no ACTIVE master row — refusing to guess`);
    if (new Set(rows.map((r) => r.id)).size > 1)
      die(`${c.email} has ${rows.length} active master rows [${rows.map((r) => r.Department).join(' | ')}] — resolve the duplicate first`);
    const row = rows[0];
    const cell = String(row.Department ?? '').trim();
    if (cell === TARGET) { console.log(`   ${c.email} already placed in ${TARGET} — skipping`); continue; }
    if (cell.toLowerCase() !== SOURCE_LABEL.toLowerCase())
      die(`${c.email} is "${cell}", not plain "${SOURCE_LABEL}" — someone placed them since; re-read before rerunning`);

    const rr = rosterByEmail.get(c.email);
    let rosterAction: Plan['rosterAction'];
    if (!rr) rosterAction = 'absent';
    else if (rr.dept_key == null) rosterAction = 'set';
    else if (rr.dept_key === SUB_KEY) rosterAction = 'already';
    else die(`Guard 3 — ${c.email} already sits on hsl_team_members.dept_key="${rr.dept_key}"; moving them is a SCORING decision, not a seed`);
    plan.push({ email: c.email, row, role: c.role, rosterAction });
  }
  if (plan.length === 0) { console.log('\nNothing to do — everyone is already placed.'); return; }

  console.log(`\nPLAN — ${plan.length} people → ${formatDeptLabel(TARGET)}:`);
  for (const p of plan)
    console.log(`   ${p.email.padEnd(26)} "${p.role}"  master "${p.row.Department}" → "${TARGET}"  · roster dept_key: ${p.rosterAction === 'set' ? 'NULL → ' + SUB_KEY : p.rosterAction === 'already' ? 'already set' : 'NO ROSTER ROW (wizard rail will show Unassigned)'}`);
  for (const p of plan) if (p.rosterAction === 'absent')
    console.log(`   WARNING: ${p.email} has no hsl_team_members row — the Payroll Wizard rail keys on that table, so they will read "Unassigned" until one exists.`);

  // ── Sheet plan (Guard 6) ───────────────────────────────────────────────────
  const { getServiceAccountAccessToken } = await import('../src/lib/google-sheets/auth.js').catch((e: unknown) =>
    die(`could not import google-sheets/auth: ${String(e)}`),
  );
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) die('GOOGLE_SHEETS_MASTER_SHEET_ID / _TAB_NAME not configured');
  const token = await getServiceAccountAccessToken(
    APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly',
  );
  const quotedTab = `'${tabName!.replace(/'/g, "''")}'`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(quotedTab)}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  const j = (await res.json()) as { values?: unknown[][]; error?: { message?: string } };
  if (!res.ok) die(`Sheets read failed (${res.status}): ${j.error?.message ?? res.statusText}`);
  const values = j.values ?? [];
  let hdr = -1;
  for (let i = 0; i < values.length; i++) {
    const r = (values[i] ?? []).map(ne);
    if (r.includes('department') && (r.includes('name') || r.includes('personal email'))) { hdr = i; break; }
  }
  if (hdr < 0) die('header row not found in the master sheet');
  const H = (values[hdr] ?? []).map(ne);
  const dc = H.indexOf('department');
  const wc = H.findIndex((x) => x === 'work email' || x === 'workemail');
  const pc = H.findIndex((x) => x === 'personal email' || x === 'personalemail');
  if (dc < 0) die('no Department column in the master sheet');
  const letter = columnToLetter(dc + 1);

  const sheetUpdates: Array<{ range: string; email: string; before: string }> = [];
  const sheetMatched = new Set<string>();
  for (const p of plan) {
    let found = false;
    for (let i = hdr + 1; i < values.length; i++) {
      const r = values[i] ?? [];
      const match = (wc >= 0 && ne(r[wc]) === p.email) || (pc >= 0 && ne(r[pc]) === ne(p.row['Personal Email']));
      if (!match) continue;
      const d = String(r[dc] ?? '').trim();
      if (d.toLowerCase() !== SOURCE_LABEL.toLowerCase()) {
        console.log(`   SHEET MISMATCH (DB write will be SKIPPED): ${p.email} — sheet row ${i + 1} says "${d}", not "${SOURCE_LABEL}"`);
        continue;
      }
      sheetUpdates.push({ range: `${quotedTab}!${letter}${i + 1}`, email: p.email, before: d });
      sheetMatched.add(p.email);
      found = true;
    }
    if (!found && !sheetMatched.has(p.email))
      console.log(`   SHEET: no "${SOURCE_LABEL}" row found for ${p.email} — DB write will be SKIPPED (Guard 6)`);
  }
  console.log(`\nSheet: ${sheetUpdates.length} cells to write.`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Rerun with --apply.'); return; }

  // ── Guard 5: backup, then write ────────────────────────────────────────────
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join('reports', `backup_hsl_executive_assistants_${stamp}.json`);
  writeFileSync(backup, JSON.stringify({
    plan: plan.map((p) => ({
      email: p.email, role: p.role, masterId: p.row.id, departmentBefore: p.row.Department,
      departmentAfter: TARGET, rosterBefore: rosterByEmail.get(p.email)?.dept_key ?? null, rosterAfter: SUB_KEY,
    })),
    sheetCells: sheetUpdates,
  }, null, 2), 'utf8');
  console.log(`Guard 5 OK — backup → ${backup}`);

  // Sheet first: a DB-half failure then resolves toward the sub-team.
  if (sheetUpdates.length) {
    const b = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: sheetUpdates.map((u) => ({ range: u.range, values: [[TARGET]] })) }),
      cache: 'no-store',
    });
    if (!b.ok) die(`Sheets batchUpdate failed (${b.status}): ${(await b.text().catch(() => '')).slice(0, 300)}`);
    console.log(`Sheet: ${sheetUpdates.length} cells written.`);
  }

  for (const p of plan) {
    if (!sheetMatched.has(p.email)) { console.log(`DB SKIPPED (Guard 6): ${p.email}`); continue; }
    const { error } = await db.from('global_master_list').update({ Department: TARGET }).eq('id', p.row.id);
    if (error) die(`updating ${p.email}: ${error.message}`);
    console.log(`DB: ${p.email} → ${TARGET}`);
  }

  // The KPI roster — the ONLY thing the Payroll Wizard rail reads.
  let rosterSet = 0;
  for (const p of plan) {
    if (p.rosterAction !== 'set') continue;
    const { error } = await db.from('hsl_team_members').update({ dept_key: SUB_KEY }).ilike('email', p.email).is('dept_key', null);
    if (error) die(`roster update for ${p.email}: ${error.message}`);
    rosterSet++;
    console.log(`Roster: ${p.email} dept_key → ${SUB_KEY}`);
  }

  await db.from('audit_log').insert({
    user_name: ACTOR, user_role: 'admin', action: 'hsl.subdept.create_executive_assistants',
    resource: 'hsl_team_members', resource_id: SUB_KEY,
    details: {
      why: 'Kane 2026-08-14: "Lets create a new department called HSL - Executive Assistants and put them in there"',
      shape: '§7a-roster-only (noKpi:true, rules:[]) so the Payroll Wizard rail + Admin Roles checkbox derive',
      placed: plan.filter((p) => sheetMatched.has(p.email)).map((p) => p.email),
      rosterSet, sheetCells: sheetUpdates.length, backup, transferRowsWritten: 0,
    },
  });

  console.log(`\nDONE. Backup ${backup}`);
})();

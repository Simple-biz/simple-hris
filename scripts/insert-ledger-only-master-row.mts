/**
 * ONE-OFF: give a leaver who exists ONLY on the `offboarded_sheet` ledger a
 * `global_master_list` row, pre-stamped off-boarded, so Accounting → Documents →
 * Termination Letters stops refusing them with `no_master`.
 *
 * READ-ONLY WITHOUT `--apply`. With `--apply` it INSERTs one row into
 * PRODUCTION, after writing a backup of everything it read to decide.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/insert-ledger-only-master-row.mts --work-email raphs@simple.biz
 *   node --import tsx scripts/insert-ledger-only-master-row.mts --work-email raphs@simple.biz --apply
 *   optional:  --department "<exact master-list Department>"   --start-date MM/DD/YY
 *
 * ## Why these people have no master row
 *
 * The master list's first row is 2026-04-21. Anyone who left before that was
 * never on it: their only record is the ledger (backfilled from the sheet's
 * Offboarded tab, `origin='google_sheet'`). The Termination tab IDENTIFIES on a
 * master row (termination-arbitration.ts:410-413), so they are unissuable, and
 * nothing in the app can fix it — the app never inserts master rows; only the
 * sheet sync does. Putting them back on the SHEET would be wrong: the sync would
 * insert them ACTIVE and unstamped.
 *
 * Approved 2026-09-23 for ONE person (Raph Sepnio). Every run names one work
 * email. Do not loop this over the ~2,500 ledger-only addresses — that is a
 * different decision with its own dedupe (by personal email) and review.
 *
 * ## What stops it creating the wrong person
 *
 *   1. NO master row may carry the work OR personal email in ANY of the four
 *      email columns. Work emails are recycled across humans (markg@ has held at
 *      least four); a live holder would be stamped by association.
 *   2. The ledger rows for this work email must name exactly ONE personal email,
 *      and that personal email must not appear on the ledger under a different
 *      work email. Otherwise which human this is cannot be known.
 *   3. The latest ledger date must be an explicit, real, non-future day
 *      (`explicitMasterDay` — the tab's own date rule), and its reason must be on
 *      the tab's departure allowlist. The stored reason is VERBATIM.
 *   4. `--department` must be a Department value some master row already
 *      carries: a typo would become a department of one.
 *      `--start-date` must parse the same way and fall BEFORE the departure, or
 *      the tab refuses it as a re-hire.
 *   5. The proposed row is fed through the tab's own pure
 *      `arbitrateTerminationFacts`. Unless the verdict is FACTS, nothing is
 *      written. The timesheet signal is passed as `unavailable` (this script
 *      does not read Hubstaff); the live tab still runs T4 on its own.
 *
 * ## The row it writes
 *
 * Name / emails copied from the ledger. `off_boarded_at` + reason from the
 * LATEST ledger entry. `last_seen_upload_id` / `first_seen_upload_id` NULL: a
 * NULL never equals the current upload, so the row is never counted active and
 * never outranks a real sheet row; `source_file` names this script, the way
 * `seed_us_global_master_list.sql` tags its hand-seeded rows. "Start Date" NULL
 * unless given — the tab's blank-only write-back lets the rep fill it. The
 * master sync never deletes a row missing from the sheet and never un-stamps
 * one (global-master-list-db.ts:1007-1025), so it survives; the sync's
 * employee_id backfill may later assign an id, which is harmless.
 *
 * Revert: delete the one row by the id this prints. Nothing else is touched.
 */
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { normEmail } = await import('../src/lib/email/norm-email');
const { arbitrateTerminationFacts, explicitMasterDay } = await import(
  '../src/lib/documents/termination/termination-arbitration'
);
const { reasonKey, TERMINATION_DEPARTURE_REASON_SET } = await import(
  '../src/lib/documents/termination/reason-key'
);

const APPLY = process.argv.includes('--apply');
const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v.trim() : null;
};

const TABLE = 'global_master_list';
const EMAIL_COLS = ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2'] as const;
const BACKUP_DIR = 'references/backups';
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

const workEmail = normEmail(arg('--work-email'));
const departmentArg = arg('--department');
const startDateArg = arg('--start-date');
if (!workEmail) {
  console.error('--work-email <address> is required.');
  process.exit(1);
}

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/** PostgREST truncates at 1000 rows even with .range(), so page. */
async function selectAllPaged(table: string, columns: string): Promise<Row[]> {
  const PAGE = 1000;
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb!.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

const refusals: string[] = [];
const warnings: string[] = [];

console.log(`${APPLY ? 'APPLY — this will WRITE one row.' : 'DRY RUN — nothing will be written.'}`);
console.log(`Target work email: ${workEmail}\n`);

// ── Ledger ───────────────────────────────────────────────────────────────────
const ledger = await selectAllPaged(
  'offboarded_sheet',
  'id,personal_email,work_email,name,department,start_date,off_boarded_at,off_boarded_reason,origin',
);
const mine = ledger.filter((r) => normEmail(str(r.work_email)) === workEmail);
console.log(`Ledger rows for ${workEmail}: ${mine.length}`);
for (const r of mine) {
  console.log(`  id ${r.id}  ${str(r.off_boarded_at)?.slice(0, 10) ?? '(no date)'}  ${str(r.off_boarded_reason) ?? '(no reason)'}  · ${str(r.personal_email) ?? '(no personal)'} · ${str(r.name) ?? '(no name)'}`);
}
if (mine.length === 0) refusals.push('No offboarded_sheet row carries this work email — there is no departure to copy.');

const personals = [...new Set(mine.map((r) => normEmail(str(r.personal_email))).filter((e): e is string => !!e))];
const names = [...new Set(mine.map((r) => str(r.name)).filter((n): n is string => !!n))];
const personalEmail = personals.length === 1 ? personals[0] : null;
if (mine.length && personals.length !== 1) {
  refusals.push(`The ledger rows name ${personals.length} personal emails (${personals.join(', ') || 'none'}) — which person this is cannot be known.`);
}
if (names.length !== 1 && mine.length) {
  refusals.push(`The ledger rows name ${names.length} different names (${names.join(' / ') || 'none'}).`);
}
if (personalEmail) {
  const otherWork = ledger.filter(
    (r) => normEmail(str(r.personal_email)) === personalEmail && normEmail(str(r.work_email)) !== workEmail,
  );
  if (otherWork.length) {
    refusals.push(
      `${personalEmail} is on the ledger under another work email too (${[...new Set(otherWork.map((r) => str(r.work_email) ?? '(none)'))].join(', ')}) — one inbox, several identities.`,
    );
  }
}

// Latest DATED ledger entry wins, the same rule the tab applies (arbitration T2).
const dated = mine
  .map((r) => ({ r, day: explicitMasterDay(str(r.off_boarded_at), NOW) }))
  .filter((x): x is { r: Row; day: string } => !!x.day)
  .sort((a, z) => z.day.localeCompare(a.day));
if (mine.length && dated.length !== mine.length) {
  warnings.push(`${mine.length - dated.length} ledger row(s) have a date the tab would not accept; only dated rows are used.`);
}
const latest = dated[0] ?? null;
const departureDay = latest?.day ?? null;
const departureReason = latest ? str(latest.r.off_boarded_reason) : null;
if (mine.length && !latest) refusals.push('No ledger row carries a date the tab accepts (explicit, real, not in the future).');
if (latest) {
  const k = reasonKey(departureReason);
  if (!k || k === 'temporary_pause' || !TERMINATION_DEPARTURE_REASON_SET.has(k)) {
    refusals.push(`The latest ledger reason "${departureReason ?? ''}" is not one of the tab's departure reasons.`);
  }
}
const earlier = dated.slice(1);

// ── Master list: nobody may already carry either address ─────────────────────
const gml = await selectAllPaged(TABLE, `id,"Name","Department",${EMAIL_COLS.map((c) => `"${c}"`).join(',')}`);
console.log(`\nMaster list: ${gml.length} rows scanned across ${EMAIL_COLS.length} email columns`);
const wanted = new Set([workEmail, personalEmail].filter((e): e is string => !!e));
const collisions = gml.filter((r) => EMAIL_COLS.some((c) => {
  const e = normEmail(str(r[c]));
  return !!e && wanted.has(e);
}));
for (const c of collisions) {
  refusals.push(`Master row ${c.id} (${str(c['Name']) ?? '(no name)'}) already carries ${[...wanted].join(' or ')} — this is not a ledger-only person.`);
}
if (!collisions.length) console.log(`  no master row carries ${[...wanted].join(' or ')}`);

// ── Optional inputs ──────────────────────────────────────────────────────────
let department: string | null = null;
if (departmentArg) {
  const known = new Set(gml.map((r) => str(r['Department'])).filter((d): d is string => !!d));
  if (known.has(departmentArg)) department = departmentArg;
  else refusals.push(`--department "${departmentArg}" is not a Department any master row carries. Use the exact label.`);
} else {
  warnings.push('No --department: "Department at departure" will be BLANK on the letter (the rep can type it; it is never written back).');
}

let startDate: string | null = null;
if (startDateArg) {
  const day = explicitMasterDay(startDateArg, NOW);
  if (!day) refusals.push(`--start-date "${startDateArg}" is not a date the tab accepts (MM/DD/YY).`);
  else if (departureDay && day >= departureDay) refusals.push(`--start-date ${day} is on/after the ${departureDay} departure — the tab refuses that as a re-hire.`);
  else {
    startDate = startDateArg;
    const prior = earlier.find((e) => e.day >= day);
    if (prior) warnings.push(`--start-date ${day} is on/before the earlier ${prior.day} departure — the letter's start date then covers a previous stint.`);
  }
} else {
  warnings.push('No --start-date: "Start date" stays BLANK for the rep to fill on the tab (blank-only write-back).');
}

// ── The row ──────────────────────────────────────────────────────────────────
const ledgerIds = mine.map((r) => r.id).join(', ');
const row = {
  Name: names[0] ?? null,
  'Work Email': workEmail,
  'Personal Email': personalEmail,
  Department: department,
  'Start Date': startDate,
  off_boarded_at: departureDay ? `${departureDay}T00:00:00+00:00` : null,
  off_boarded_reason: departureReason,
  off_boarded_by: 'system:ledger-only-master-row',
  off_boarded_note: `inserted ${TODAY} from offboarded_sheet id(s) ${ledgerIds}: left before the master list began, so no master row existed and Termination Letters refused no_master`,
  source_file: `manual_ledger_only_${TODAY}`,
  first_seen_upload_id: null,
  last_seen_upload_id: null,
};
console.log('\nProposed row:');
console.log(JSON.stringify(row, null, 2));

// ── The tab's own verdict on that row ────────────────────────────────────────
if (!refusals.length) {
  const verdict = arbitrateTerminationFacts({
    workEmail,
    masterRows: [{
      id: 'proposed',
      name: row.Name,
      workEmail,
      personalEmail,
      alternateWorkEmail: null,
      alternateWorkEmail2: null,
      departmentRaw: department,
      startDateRaw: startDate,
      offBoardedAtRaw: row.off_boarded_at,
      offBoardedReason: departureReason,
      uploadId: null,
      uploadSeq: 0,
    }],
    currentUploadId: null,
    gmlActive: false,
    gmlStatusError: null,
    masterReadError: null,
    evidenceReadError: null,
    cycleHours: { state: 'unavailable' },
    evidence: departureDay ? { offDate: departureDay, reason: departureReason } : null,
    sheetRows: mine.map((r) => ({ offBoardedAtRaw: str(r.off_boarded_at), offBoardedReason: str(r.off_boarded_reason) })),
    readsDegraded: false,
    degraded: [],
    now: NOW,
  });
  if (verdict.blocked) {
    refusals.push(`The Termination tab would still refuse this row: ${verdict.blocked.code} — ${verdict.blocked.message}`);
  } else {
    const f = verdict.facts as unknown as Record<string, unknown>;
    console.log('\nTermination tab verdict on the proposed row: FACTS');
    for (const k of ['workerName', 'terminationDateLabel', 'reasonLabel', 'startDateLabel', 'endingDepartmentLabel']) {
      console.log(`  ${k.padEnd(22)} ${f[k] == null ? '(BLANK — rep fills)' : JSON.stringify(f[k])}`);
    }
    console.log('  (timesheet signal passed as UNAVAILABLE — the live tab still checks hours itself)');
  }
}

for (const w of warnings) console.log(`\n! ${w}`);

if (refusals.length) {
  console.error('\nREFUSED — nothing written:');
  for (const r of refusals) console.error(`  ✗ ${r}`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDry run clean — re-run with --apply to insert this one row.');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = NOW.toISOString().replace(/[:.]/g, '-');
const backupPath = join(BACKUP_DIR, `gml_ledger_only_insert_${workEmail.replace(/[^a-z0-9]+/gi, '_')}_${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify({ workEmail, personalEmail, masterCollisions: collisions, ledgerRows: mine, proposedRow: row, masterRowCount: gml.length }, null, 2),
  'utf8',
);
console.log(`\nBackup written: ${backupPath}`);

const { data: inserted, error: insErr } = await sb.from(TABLE).insert(row).select('id');
if (insErr || !inserted?.length) {
  console.error(`INSERT failed: ${insErr?.message ?? 'no row returned'} — nothing was written.`);
  process.exit(1);
}
const newId = String((inserted[0] as Row).id);
console.log(`Inserted master row ${newId}`);

// Read back rather than trusting the write: by id, and by email across all rows.
const { data: back, error: backErr } = await sb
  .from(TABLE)
  .select('id,"Name","Work Email","Personal Email",off_boarded_at,off_boarded_reason,last_seen_upload_id')
  .eq('id', newId);
if (backErr || back?.length !== 1) {
  console.error(`Read-back by id failed: ${backErr?.message ?? `${back?.length ?? 0} rows`} — check row ${newId} by hand.`);
  process.exit(1);
}
const after = await selectAllPaged(TABLE, EMAIL_COLS.map((c) => `"${c}"`).join(','));
const carrying = after.filter((r) => EMAIL_COLS.some((c) => normEmail(str(r[c])) === workEmail)).length;
console.log(JSON.stringify(back[0], null, 2));
console.log(`Master rows carrying ${workEmail} now: ${carrying} (expected 1)   total rows: ${after.length} (was ${gml.length})`);
if (carrying !== 1 || after.length !== gml.length + 1) {
  console.error('Counts do not match the expectation — investigate before trusting the tab.');
  process.exit(1);
}
console.log(`\nDone. Revert: delete global_master_list id ${newId}.`);

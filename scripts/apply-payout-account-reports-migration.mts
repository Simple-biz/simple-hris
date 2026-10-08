/**
 * [PAYOUT-ACCOUNT-REPORTS]
 * Applies references/sql/create/2026-10-08_payout_account_reports.sql — the table
 * where an employee's "this account is closed / deactivated / frozen" report lives
 * (docs/features/payout-account-reports.md) — then verifies the table, RLS with NO
 * policies, the one-open-report index, and that every CHECK actually bites.
 *
 *   node --import tsx scripts/apply-payout-account-reports-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-payout-account-reports-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-payout-account-reports-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-payout-account-reports-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled
 * back. Needs DATABASE_URL (session pooler, user postgres.<ref>, `@` as %40;
 * memory/migration-apply-needs-database-url).
 *
 * Until this runs, every route that reads the table answers "unavailable" and the
 * Report button is disabled; nothing else breaks.
 *
 * Reverse: DROP TABLE public.payout_account_reports; (discards every report — not without Kane).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const SQL_RELATIVE = 'references/sql/create/2026-10-08_payout_account_reports.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.payout_account_reports';

const wantVerify = process.argv.includes('--verify');
const wantApply = process.argv.includes('--apply');
const wantDry = process.argv.includes('--dry');
if ([wantVerify, wantApply, wantDry].filter(Boolean).length > 1) {
  console.error('Pass exactly one of --dry / --apply / --verify (the default is --dry).');
  process.exit(1);
}
const dryRun = wantDry || (!wantVerify && !wantApply);

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set (session pooler URI in .env.local).');
  process.exit(1);
}

const CONSTRAINTS = [
  'payout_account_reports_email_lower',
  'payout_account_reports_kind_check',
  'payout_account_reports_fingerprint_hex',
  'payout_account_reports_status_check',
  'payout_account_reports_note_len',
  'payout_account_reports_other_needs_note',
  'payout_account_reports_via_check',
  'payout_account_reports_withdrawn_pair',
  'payout_account_reports_withdrawn_via_check',
];

const CHECKS: Array<[string, string]> = [
  ['table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  ['row level security is ENABLED', `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${TABLE}')), false) AS ok`],
  ['NO policies (anon/authenticated read nothing)', `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payout_account_reports') AS ok`],
  ['one-open-report unique index', `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='payout_account_reports_one_open' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%withdrawn_at IS NULL%') AS ok`],
  ['table comment tagged', `SELECT COALESCE((SELECT obj_description(to_regclass('${TABLE}'), 'pg_class') LIKE '[PAYOUT-ACCOUNT-REPORTS]%'), false) AS ok`],
  ...CONSTRAINTS.map((name): [string, string] => [`constraint ${name}`, `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`]),
];

const FP = `'${'a'.repeat(64)}'`;
const LEGAL: Record<string, string> = {
  work_email: "'control@simple.biz'",
  account_kind: "'bank_primary'",
  account_fingerprint: FP,
  account_hint: "'••••7890'",
  account_label: "'BPI'",
  status: "'closed'",
  reported_via: "'employee_dashboard'",
  reported_by: "'control@simple.biz'",
};
const insertRow = (o: Record<string, string> = {}) => {
  const row = { ...LEGAL, ...o };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
};

const POSITIVE: Array<[string, string]> = [
  ['a legal report is ACCEPTED (proves the suite can pass)', insertRow()],
  ["'other' WITH a note is accepted", insertRow({ status: "'other'", note: "'bank says under review'" })],
  ['a withdrawn report (both columns) is accepted', insertRow({ withdrawn_at: 'now()', withdrawn_via: "'superseded'" })],
];
const NEGATIVE: Array<[string, string]> = [
  ['a mixed-case email is rejected', insertRow({ work_email: "'Control@Simple.biz'" })],
  ['an unknown kind is rejected', insertRow({ account_kind: "'card'" })],
  ['a fingerprint that is not 64 hex is rejected (a raw number can never be stored there)', insertRow({ account_fingerprint: "'001234567890'" })],
  ['an unknown status is rejected', insertRow({ status: "'Closed'" })],
  ["'other' without a note is rejected", insertRow({ status: "'other'" })],
  ['a note over 500 chars is rejected', insertRow({ note: `'${'x'.repeat(501)}'` })],
  ['an unknown channel is rejected', insertRow({ reported_via: "'people_tab'" })],
  ['withdrawn_at without withdrawn_via is rejected', insertRow({ withdrawn_at: 'now()' })],
];

const client = new Client({ connectionString });

async function main() {
  console.log(`${wantVerify ? 'VERIFY ONLY' : dryRun ? 'DRY RUN (rolled back)' : 'APPLY'} — ${TABLE}\n  SQL: ${SQL_PATH}\n`);
  await client.connect();
  const sql = readFileSync(SQL_PATH, 'utf8');
  if (dryRun) {
    await client.query('BEGIN');
    await client.query(sql);
  } else if (wantApply) {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('  applied.\n');
  }

  let failed = 0;
  for (const [label, q] of CHECKS) {
    const { rows } = await client.query(q);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  if (!dryRun) await client.query('BEGIN');
  console.log('\nControls (each in a rolled-back savepoint):');
  for (const [label, q] of POSITIVE) {
    await client.query('SAVEPOINT c');
    let ok = true;
    let why = '';
    try {
      await client.query(q);
    } catch (e) {
      ok = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT c');
    await client.query('RELEASE SAVEPOINT c');
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  }
  // The one-open index: a second OPEN report on the same account must fail.
  {
    await client.query('SAVEPOINT u');
    let rejected = false;
    try {
      await client.query(insertRow());
      await client.query(insertRow());
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT u');
    await client.query('RELEASE SAVEPOINT u');
    if (!rejected) failed++;
    console.log(`  ${rejected ? 'OK  ' : 'FAIL'}  a second OPEN report on the same account is rejected`);
  }
  for (const [label, q] of NEGATIVE) {
    await client.query('SAVEPOINT n');
    let rejected = false;
    try {
      await client.query(q);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT n');
    await client.query('RELEASE SAVEPOINT n');
    if (!rejected) failed++;
    console.log(`  ${rejected ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  await client.query('ROLLBACK');
  if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
  await client.end();
  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(async (e) => {
  console.error('\nFAILED:', (e as Error).message);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

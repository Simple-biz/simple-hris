/**
 * [ORPHANAGE-INTERNS]
 * Applies references/sql/migrate/2026-09-02_orphanage_interns.sql — the five
 * intern tables (profiles, dated rates, the interns' own Hubstaff report + its
 * uploads, the locked week), the two new orphanage_dispatches types, and the
 * orphanage's receiving-bank columns — then verifies every object landed AND
 * that each CHECK actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-orphanage-interns-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-orphanage-interns-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-orphanage-interns-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-orphanage-interns-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always
 * rolled back. Postgres DDL is transactional, so the rehearsal proves the SQL
 * parses, the tables build and the CHECKs bite while leaving production as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 * An `@` inside the password MUST be percent-encoded as %40. Session mode on
 * 5432 runs DDL; transaction mode on 6543 cannot.
 *
 * The SQL is idempotent and touches no row data, so a re-run is a no-op.
 * Run it BEFORE deploying the code that reads the tables: until it runs the
 * Interns tab, the mini wizard and the Interns queue section have nothing to
 * read and say so; nothing else in the app touches these tables.
 *
 * Shape copied from scripts/apply-termination-docs-migration.mts.
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

const SQL_RELATIVE = 'references/sql/migrate/2026-09-02_orphanage_interns.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}\nExpected <repo root>/${SQL_RELATIVE}.`);
  process.exit(1);
}

const wantVerify = process.argv.includes('--verify');
const wantApply = process.argv.includes('--apply');
const wantDry = process.argv.includes('--dry');
if ([wantVerify, wantApply, wantDry].filter(Boolean).length > 1) {
  console.error('Pass exactly one of --dry / --apply / --verify (the default is --dry).');
  process.exit(1);
}
const verifyOnly = wantVerify;
const dryRun = wantDry || (!wantVerify && !wantApply);

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      'DATABASE_URL is not set.',
      '',
      'Add the SESSION POOLER URI to .env.local:',
      '  DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres',
      '',
      "Percent-encode any '@' in the password as %40.",
    ].join('\n'),
  );
  process.exit(1);
}

const TABLES = [
  'public.orphanage_interns',
  'public.orphanage_intern_rates',
  'public.orphanage_intern_hours_uploads',
  'public.orphanage_intern_hours',
  'public.orphanage_intern_pay',
];

const CONSTRAINTS = [
  'orphanage_interns_email_domain_check',
  'orphanage_interns_status_check',
  'orphanage_interns_name_parts_present',
  'orphanage_interns_caps_positive',
  'orphanage_interns_pab_nonnegative',
  'orphanage_interns_share_pct_range',
  'orphanage_intern_rates_rate_positive',
  'orphanage_intern_rates_one_per_day',
  'orphanage_intern_hours_email_domain_check',
  'orphanage_intern_hours_one_per_row',
  'orphanage_intern_pay_one_per_week',
  'orphanage_intern_pay_status_check',
  'orphanage_intern_pay_share_mode_check',
  'orphanage_intern_pay_pab_mode_check',
  'orphanage_intern_pay_shares_sum',
  'orphanage_intern_pay_gross_sum',
  'orphanage_dispatches_dispatch_type_check',
];

const INDEXES = [
  'orphanage_intern_rates_intern_idx',
  'orphanage_intern_hours_file_idx',
  'orphanage_intern_hours_email_idx',
  'orphanage_intern_pay_file_idx',
  'orphanage_intern_pay_status_idx',
  'orphanage_dispatches_intern_pay_uniq',
];

const RLS_TABLES = TABLES;

// Each row: [label, SQL returning a single boolean column named ok]
const CHECKS: Array<[string, string]> = [
  ...TABLES.map((t): [string, string] => [`${t} exists`, `SELECT to_regclass('${t}') IS NOT NULL AS ok`]),
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
  [
    'orphanage_dispatches.intern_pay_id exists',
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='orphanage_dispatches' AND column_name='intern_pay_id') AS ok`,
  ],
  ...['bank_name', 'bank_account_name', 'bank_account_number', 'swift_code'].map(
    (col): [string, string] => [
      `orphanages.${col} exists (receiving bank for system_split)`,
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='orphanages' AND column_name='${col}') AS ok`,
    ],
  ),
  ...RLS_TABLES.map((t): [string, string] => [
    `${t} has row level security ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${t}')), false) AS ok`,
  ]),
  ...RLS_TABLES.map((t): [string, string] => [
    `${t} has NO policies (anon/authenticated get zero rows)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t.replace('public.', '')}') AS ok`,
  ]),
];

/** The ONE legal intern row every control deviates from by exactly one field. */
const LEGAL_INTERN: Record<string, string> = {
  id: "'00000000-0000-4000-8000-000000000001'",
  email: "'control@pathway.ph'",
  first_name: "'Control'",
  last_name: "'Intern'",
  full_name: "'Control Intern'",
};
function insertIntern(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_INTERN, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO public.orphanage_interns (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/** A legal locked-week row that references the control intern. */
const LEGAL_PAY: Record<string, string> = {
  source_file: "'interns_2026-08-30_to_2026-09-05.csv'",
  intern_id: LEGAL_INTERN.id,
  intern_email: "'control@pathway.ph'",
  intern_name: "'Control Intern'",
  week_start: "'2026-08-30'",
  week_end: "'2026-09-05'",
  hours_raw: '6.5',
  hours_paid: '5.00',
  hours_by_day: `'{"2026-08-31":{"raw":3.25,"paid":3.25,"rate_php":200},"2026-09-01":{"raw":3.25,"paid":1.75,"rate_php":200}}'::jsonb`,
  rate_php: '200.00',
  pay_php: '1000.00',
  pab_php: '0',
  pab_mode: "'not_payout_week'",
  gross_php: '1000.00',
  orphanage_share_pct: '50',
  orphanage_share_php: '500.00',
  intern_share_php: '500.00',
  share_mode: "'system_split'",
};
function insertPay(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_PAY, ...overrides };
  const cols = Object.keys(row);
  return `${insertIntern()}; INSERT INTO public.orphanage_intern_pay (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const POSITIVE_CONTROLS: Array<[string, string]> = [
  ['a legal intern row is ACCEPTED (proves the suite can pass)', insertIntern()],
  ['a legal locked-week row is ACCEPTED', insertPay()],
  [
    'a dated rate row is ACCEPTED',
    `${insertIntern()}; INSERT INTO public.orphanage_intern_rates (intern_id, rate_php, effective_from) VALUES (${LEGAL_INTERN.id}, 200, '2026-09-01')`,
  ],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['a @simple.biz intern is rejected (the domain rule, in the database)', insertIntern({ email: "'control@simple.biz'" })],
  ['a mixed-case intern email is rejected (the app lower-cases; the CHECK insists)', insertIntern({ email: "'Control@pathway.ph'" })],
  ["an unknown status ('paused') is rejected", insertIntern({ status: "'paused'" })],
  ['a blank first name is rejected (name parts are the source of truth)', insertIntern({ first_name: "'  '" })],
  ['a blank last name is rejected', insertIntern({ last_name: "''" })],
  ['a zero weekly cap is rejected', insertIntern({ weekly_cap_hours: '0' })],
  ['a 101% orphanage share is rejected', insertIntern({ orphanage_share_pct: '101' })],
  ['a zero rate is rejected', `${insertIntern()}; INSERT INTO public.orphanage_intern_rates (intern_id, rate_php, effective_from) VALUES (${LEGAL_INTERN.id}, 0, '2026-09-01')`],
  ["a stored status of 'paid' is rejected (paid is DERIVED from dispatches)", insertPay({ status: "'paid'" })],
  ["a share_mode of 'auto' is rejected (Q2 must be decided, never defaulted)", insertPay({ share_mode: "'auto'" })],
  ["a pab_mode of 'session_days' is rejected (Ralph chose weekly hours)", insertPay({ pab_mode: "'session_days'" })],
  ['shares that do not sum to gross are rejected', insertPay({ intern_share_php: '499.99' })],
  ['a gross that is not pay + PAB is rejected', insertPay({ gross_php: '1100.00' })],
  [
    "an orphanage_dispatches type of 'intern' is rejected (only intern_pay / intern_orphanage_share)",
    `INSERT INTO public.orphanage_dispatches (dispatch_type, label, submitter_email, amount_php) VALUES ('intern', 'x', 'x', 1)`,
  ],
  [
    'a @simple.biz row in the intern hours table is rejected',
    `INSERT INTO public.orphanage_intern_hours_uploads (id, source_file, week_start, week_end) VALUES ('00000000-0000-4000-8000-000000000002','interns_ctrl.csv','2026-08-30','2026-09-05');
     INSERT INTO public.orphanage_intern_hours (upload_id, source_file, row_index, email, row) VALUES ('00000000-0000-4000-8000-000000000002','interns_ctrl.csv',0,'kaner@simple.biz','{}'::jsonb)`,
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Orphanage Interns migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${TABLES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : ${POSITIVE_CONTROLS.length} positive, ${NEGATIVE_CONTROLS.length} negative`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL will be COMMITTED to the database DATABASE_URL points at.',
      '',
    ].join('\n'),
  );

  await client.connect();

  // The SQL file carries its own BEGIN/COMMIT so it can be pasted by hand. For
  // the dry run we need to own the transaction, so strip them and wrap ourselves.
  const rawSql = readFileSync(SQL_PATH, 'utf8');
  const sqlBody = rawSql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');

  if (dryRun) {
    console.log(`Applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query('BEGIN');
    await client.query(sqlBody);
  } else if (!verifyOnly) {
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query('BEGIN');
    await client.query(sqlBody);
    await client.query('COMMIT');
    console.log('  applied.\n');
  } else {
    console.log('Verify only — not applying.\n');
  }

  console.log('Verifying objects:');
  let failed = 0;
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  console.log('\nVerifying the constraints actually bite:');
  // SAVEPOINTs, not BEGIN/ROLLBACK: in --dry we are already inside the outer
  // transaction, and a nested BEGIN would silently no-op while the ROLLBACK
  // discarded the entire rehearsal.
  if (!dryRun) await client.query('BEGIN');

  for (const [label, sql] of POSITIVE_CONTROLS) {
    await client.query('SAVEPOINT pc');
    let accepted = true;
    let why = '';
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT pc');
    await client.query('RELEASE SAVEPOINT pc');
    console.log(`  ${accepted ? 'OK  ' : 'FAIL'}  ${label}${why}`);
    if (!accepted) {
      await client.query('ROLLBACK');
      await client.end();
      console.error('\nA positive control failed — the negative controls would be meaningless. Aborting.');
      process.exit(1);
    }
  }

  for (const [label, sql] of NEGATIVE_CONTROLS) {
    await client.query('SAVEPOINT nc');
    let rejected = false;
    try {
      await client.query(sql);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT nc');
    await client.query('RELEASE SAVEPOINT nc');
    if (!rejected) failed++;
    console.log(`  ${rejected ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  if (!dryRun) await client.query('ROLLBACK');

  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
  }

  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

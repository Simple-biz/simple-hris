/**
 * [GIFT-RECEIPTS]
 * Applies references/sql/migrate/2026-09-11_gift_receipts.sql —
 * `employee_gift_receipts`, the tenure-gift fulfilment ledger — then verifies
 * the table, its comments, all three indexes, all six CHECK constraints, the
 * unique key, the normalising trigger and row-level security landed, AND that
 * each constraint actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-gift-receipts-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-gift-receipts-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-gift-receipts-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-gift-receipts-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The dry run applies the SQL and runs
 * every check inside a transaction it always rolls back; Postgres DDL is
 * transactional, so this proves the migration parses, the table builds and the
 * CHECKs bite while leaving production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local. For this project that is the SESSION POOLER,
 * not the direct host (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The direct db.<ref>.supabase.co host is IPv6-only here and resolves to no
 * address at all. The user is `postgres.<ref>`, not bare `postgres`, and an `@`
 * inside the password MUST be percent-encoded as %40 or the driver truncates the
 * password at the first `@` and misreads the rest as the hostname — which
 * surfaces as "password authentication failed" on a password that was fine.
 * Session mode on 5432 runs DDL; transaction mode on 6543 cannot.
 *
 * The SQL is idempotent and touches no row data, so a re-run is a no-op.
 *
 * Run it BEFORE scripts/backfill-gift-receipts.mts and before deploying the code
 * that reads the table.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

/** Repo root from THIS FILE, never from cwd, so the script runs from anywhere. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const SQL_RELATIVE = 'references/sql/migrate/2026-09-11_gift_receipts.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(
    `Migration SQL not found at ${SQL_PATH}\n` +
      `Expected <repo root>/${SQL_RELATIVE} — the repo root was derived from ${SCRIPT_PATH}.`,
  );
  process.exit(1);
}
const TABLE = 'public.employee_gift_receipts';

const wantVerify = process.argv.includes('--verify');
const wantApply = process.argv.includes('--apply');
const wantDry = process.argv.includes('--dry');
if ([wantVerify, wantApply, wantDry].filter(Boolean).length > 1) {
  console.error('Pass exactly one of --dry / --apply / --verify (the default is --dry).');
  process.exit(1);
}
const verifyOnly = wantVerify;
// SAFE BY DEFAULT: an operator who forgets the flag rehearses, never writes.
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

const CONSTRAINTS = [
  'employee_gift_receipts_milestone_range',
  'employee_gift_receipts_work_email_normalized',
  'employee_gift_receipts_work_email_shape',
  'employee_gift_receipts_source_check',
  'employee_gift_receipts_source_file_present',
  'employee_gift_receipts_recorded_by_present',
  'employee_gift_receipts_person_milestone_key',
];

const INDEXES = [
  'employee_gift_receipts_work_email_idx',
  'employee_gift_receipts_received_idx',
  'employee_gift_receipts_recorded_at_idx',
];

const CHECKS: Array<[string, string]> = [
  ['employee_gift_receipts table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  // The comment is the only in-database statement of the rule that makes this
  // table safe to read. A future reader who treats a missing row as "not
  // received" manufactures a backlog out of people nobody has assessed.
  [
    'table comment states that NO ROW MEANS UNKNOWN',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
          LIKE '%NO ROW MEANS UNKNOWN%'), false) AS ok`,
  ],
  [
    'source_milestone_date is documented as evidence, not a date rule',
    `SELECT COALESCE(
       (SELECT col_description(to_regclass('${TABLE}'), ordinal_position)
               LIKE '%evidence only%'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_gift_receipts'
           AND column_name='source_milestone_date'), false) AS ok`,
  ],
  // `received` NOT NULL is what keeps the three states distinct. A nullable
  // column would make "nobody said" representable as a ROW as well as an
  // absence, and the two would immediately drift apart.
  [
    'received is BOOLEAN NOT NULL (unknown is an ABSENT ROW, never a null)',
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' AND data_type = 'boolean'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_gift_receipts'
           AND column_name='received'), false) AS ok`,
  ],
  [
    'recorded_by is NOT NULL (every assertion has an author)',
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_gift_receipts'
           AND column_name='recorded_by'), false) AS ok`,
  ],
  // A timestamptz here would reintroduce the UTC-midnight day-shift that reads
  // as the previous day in Manila — the exact trap gift-milestones.ts documents.
  [
    'source_milestone_date is a DATE (not timestamptz)',
    `SELECT COALESCE(
       (SELECT data_type = 'date'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_gift_receipts'
           AND column_name='source_milestone_date'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = '${name}'
     ) AS ok`,
  ]),
  [
    'trigger trg_egr_normalize exists',
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${TABLE}') AND tgname = 'trg_egr_normalize'
     ) AS ok`,
  ],
  // This table maps a named worker to a thing the company failed to give them,
  // and NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle.
  [
    'row level security is ENABLED',
    `SELECT COALESCE(
       (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='employee_gift_receipts'
     ) AS ok`,
  ],
];

/**
 * The ONE fully legal row every control below deviates from by exactly one
 * field. Building the controls from a single base is what PROVES a rejection is
 * credited to the rule under test rather than to a typo in a hand-copied INSERT.
 */
const LEGAL_ROW: Record<string, string> = {
  work_email: "'control@simple.biz'",
  milestone_index: '1',
  received: 'true',
  source_milestone_date: "'2026-03-11'",
  source: "'sheet_import'",
  source_file: "'control.csv'",
  recorded_by: "'control@simple.biz'",
};

function insertRow(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_ROW, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/**
 * POSITIVE CONTROL — a fully legal row MUST insert. Without it every "rejected"
 * below could be passing for an unrelated reason, and a suite that cannot accept
 * a good row produces a report indistinguishable from one where the constraints
 * all work.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal receipt row is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

const DEFAULT_CONTROL: [string, string] = [
  'an INSERT omitting id/note/recorded_at lands real defaults',
  `INSERT INTO ${TABLE} (work_email, milestone_index, received, source, recorded_by)
   VALUES ('control2@simple.biz', 2, false, 'hris', 'control@simple.biz')
   RETURNING (
     id IS NOT NULL
     AND note = ''
     AND recorded_at IS NOT NULL
     AND created_at IS NOT NULL
     AND updated_at IS NOT NULL
   ) AS ok`,
];

/** The trigger must lower-case the key, or two spellings of one person diverge. */
const TRIGGER_CONTROL: [string, string] = [
  'the normalise trigger lower-cases and trims the work email',
  `INSERT INTO ${TABLE} (work_email, milestone_index, received, source, recorded_by)
   VALUES ('  Control@Simple.Biz  ', 3, true, 'hris', 'control@simple.biz')
   RETURNING (work_email = 'control@simple.biz') AS ok`,
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  // The three-state model in the database. `received` must never be nullable —
  // "nobody said" is the ABSENCE of a row, and a null would make it a row too.
  ['a NULL received is rejected (unknown is an absent row, not a null)', insertRow({ received: 'NULL' })],
  ['milestone_index 0 is rejected', insertRow({ milestone_index: '0' })],
  ['a negative milestone_index is rejected', insertRow({ milestone_index: '-1' })],
  ['milestone_index 61 is rejected (the 60-milestone cap)', insertRow({ milestone_index: '61' })],
  // Provenance: an imported fact with no file behind it cannot be re-checked,
  // which is how the source sheet became unauditable in the first place.
  [
    'a sheet_import with NO source_file is rejected',
    insertRow({ source_file: 'NULL' }),
  ],
  [
    'a sheet_import with a BLANK source_file is rejected',
    insertRow({ source_file: "''" }),
  ],
  ["an unknown source ('google_sheet') is rejected", insertRow({ source: "'google_sheet'" })],
  ["a mis-cased source ('HRIS') is rejected", insertRow({ source: "'HRIS'" })],
  // Authorship. 107 PAB-exclusion entries are permanently unattributable
  // because this constraint did not exist there.
  ['a blank recorded_by is rejected', insertRow({ recorded_by: "'   '" })],
  ['a work email with no @ is rejected', insertRow({ work_email: "'control'" })],
  ['a blank work email is rejected', insertRow({ work_email: "'   '" })],
];

/**
 * The unique key is what stops one person accumulating two contradictory
 * opinions about the same gift. Needs two statements, so it runs on its own.
 */
const DUPLICATE_CONTROL: [string, string, string] = [
  'a second assertion for the same (work_email, milestone_index) is rejected',
  insertRow(),
  insertRow({ received: 'false', source: "'hris'", source_file: 'NULL' }),
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Gift Receipts migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : 1 positive, 1 default, 1 trigger, 1 duplicate, ${NEGATIVE_CONTROLS.length} negative`,
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

  if (dryRun) {
    const sql = readFileSync(SQL_PATH, 'utf8');
    console.log(`Applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query('BEGIN');
    await client.query(sql);
  } else if (!verifyOnly) {
    const sql = readFileSync(SQL_PATH, 'utf8');
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(sql);
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
  // transaction, where a nested BEGIN silently no-ops while its ROLLBACK would
  // discard the entire rehearsal.
  if (!dryRun) await client.query('BEGIN');

  {
    const [label, sql] = POSITIVE_CONTROL;
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
      console.error(
        '\nPositive control failed — the negative controls below would be meaningless. Aborting.',
      );
      process.exit(1);
    }
  }

  for (const [label, sql] of [DEFAULT_CONTROL, TRIGGER_CONTROL]) {
    await client.query('SAVEPOINT dc');
    let got: unknown = null;
    let why = '';
    try {
      const { rows } = await client.query(sql);
      got = rows[0]?.ok ?? null;
    } catch (e) {
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT dc');
    await client.query('RELEASE SAVEPOINT dc');
    const ok = got === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${ok ? '' : ` (got ${JSON.stringify(got)}${why})`}`);
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

  {
    const [label, first, second] = DUPLICATE_CONTROL;
    await client.query('SAVEPOINT dup');
    let rejected = false;
    try {
      await client.query(first);
      await client.query(second);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT dup');
    await client.query('RELEASE SAVEPOINT dup');
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

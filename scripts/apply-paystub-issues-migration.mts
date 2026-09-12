/**
 * [PAYSTUB-REISSUE]
 * Applies references/sql/create/2026-09-12_paystub_issues.sql — `paystub_issues`,
 * one row per pay statement actually EMAILED — then verifies the table, its
 * comment, its index and both CHECK constraints landed, AND that each constraint
 * actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-paystub-issues-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-paystub-issues-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-paystub-issues-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-paystub-issues-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a transaction
 * that is always rolled back. Postgres DDL is transactional, so this proves the
 * migration parses, the table builds and the CHECKs bite while leaving production
 * exactly as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * An `@` in the password MUST be percent-encoded as %40 or the driver truncates
 * the password at the first `@` and misreads the rest as the hostname — which
 * surfaces as "password authentication failed" on a password that was fine.
 *
 * Safe to run BEFORE or AFTER deploying the code: every write to this table is
 * best-effort and wrapped, so with the table absent paystubs still send and
 * payments still record — the issue number simply falls back to `send_count`.
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

const SQL_RELATIVE = 'references/sql/create/2026-09-12_paystub_issues.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.paystub_issues';

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

const INDEXES = ['paystub_issues_recipient_idx'];
const CONSTRAINTS = ['paystub_issues_unique_issue'];

const CHECKS: Array<[string, string]> = [
  ['paystub_issues table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  [
    'table comment records that amount_php is the total ON THAT EMAIL',
    `SELECT COALESCE((SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
        LIKE '%ON THAT EMAIL%'), false) AS ok`,
  ],
  [
    'table comment records that no row means NOT RECORDED, never issue 1',
    `SELECT COALESCE((SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
        LIKE '%never issue 1%'), false) AS ok`,
  ],
  // A nullable identity column would let an issue exist that belongs to nobody,
  // and the employee reader would then show it against every week at once.
  ...['cycle_source_file', 'recipient_email', 'issue_no', 'kind', 'source', 'issued_at'].map(
    (col): [string, string] => [
      `${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='paystub_issues'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  [
    'issued_at is timestamptz (an instant, not a calendar day)',
    `SELECT COALESCE((SELECT data_type = 'timestamp with time zone'
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='paystub_issues'
         AND column_name='issued_at'), false) AS ok`,
  ],
  // Money on a pay document: numeric, never float. A float total would print a
  // rounding artefact on a statement an employee reads as authoritative.
  ...['amount_php', 'amount_usd', 'previous_amount_php'].map(
    (col): [string, string] => [
      `${col} is numeric (never a float)`,
      `SELECT COALESCE((SELECT data_type = 'numeric' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='paystub_issues'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
];

const LEGAL_ROW: Record<string, string> = {
  cycle_source_file: "'control_report_2026-01-01_to_2026-01-07.csv'",
  recipient_email: "'control@simple.biz'",
  issue_no: '1',
  kind: "'original'",
  source: "'mark_paid'",
};

function insertRow(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_ROW, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/**
 * POSITIVE CONTROL — without it every "rejected" below could be passing for an
 * unrelated reason, and a suite that cannot accept a good row is
 * indistinguishable from one where the constraints all work.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal issue row is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

/**
 * 'unrecorded' is a REAL verdict — "recorded, but not comparable to the last
 * issue" — and must be storable, or the route would have to guess 'reissued'
 * for a statement whose previous total nobody kept.
 */
const UNRECORDED_CONTROL: [string, string] = [
  "kind 'unrecorded' is ACCEPTED — an uncomparable issue must not be stored as a guess",
  insertRow({ kind: "'unrecorded'", issue_no: '2' }),
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  // THE one that matters: "attempt" is the word this whole feature exists to
  // avoid printing on a pay document. The database refuses to store it.
  [
    "kind 'attempt' is REJECTED — an attempt implies the last one failed",
    insertRow({ kind: "'attempt'" }),
  ],
  ['an unknown source is rejected', insertRow({ source: "'somewhere'" })],
  ['a NULL kind is rejected (a statement with no verdict)', insertRow({ kind: 'NULL' })],
  [
    'a NULL issue_no is rejected (an issue that is not numbered)',
    insertRow({ issue_no: 'NULL' }),
  ],
  [
    'a NULL recipient is rejected (an issue belonging to nobody)',
    insertRow({ recipient_email: 'NULL' }),
  ],
];

/** Needs two statements, so it is run separately from the single-shot controls. */
const DUPLICATE_CONTROL: [string, string[]] = [
  'the SAME issue number for the same statement is rejected (a retry cannot mint a phantom issue)',
  [insertRow(), insertRow({ kind: "'reissued'" })],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Paystub issues`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  Controls : 2 positive, ${NEGATIVE_CONTROLS.length + 1} negative`,
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
    console.log(`Applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query('BEGIN');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(readFileSync(SQL_PATH, 'utf8'));
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
  // discard the whole rehearsal.
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
      console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
      process.exit(1);
    }
  }

  {
    const [label, sql] = UNRECORDED_CONTROL;
    await client.query('SAVEPOINT uc');
    let accepted = true;
    let why = '';
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT uc');
    await client.query('RELEASE SAVEPOINT uc');
    if (!accepted) failed++;
    console.log(`  ${accepted ? 'OK  ' : 'FAIL'}  ${label}${why}`);
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
    const [label, statements] = DUPLICATE_CONTROL;
    await client.query('SAVEPOINT dc');
    let rejected = false;
    try {
      for (const sql of statements) await client.query(sql);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT dc');
    await client.query('RELEASE SAVEPOINT dc');
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
  console.log(
    verifyOnly || dryRun
      ? '\nAll checks passed.'
      : '\nAll checks passed — paystub_issues is live.',
  );
}

main().catch(async (e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

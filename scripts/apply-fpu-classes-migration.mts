/**
 * [FPU-CLASSES]
 * Applies references/sql/create/2026-09-16_fpu_classes.sql — the `fpu_classes`
 * table behind HR -> MESA -> FPU and the review columns on `fpu_enrollments` —
 * then verifies every object landed AND that each constraint rejects what it
 * exists to reject.
 *
 *   node --import tsx scripts/apply-fpu-classes-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-fpu-classes-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-fpu-classes-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-fpu-classes-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL runs inside a transaction that
 * is always rolled back. Same shape as scripts/apply-employee-schedules-migration.mts.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER
 * (memory/migration-apply-needs-database-url):
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 * Percent-encode any '@' in the password as %40.
 *
 * Run order does NOT matter: both HR routes report `migrated: false` when the
 * table is absent rather than 500ing, so shipping the code first is safe.
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

const SQL_RELATIVE = 'references/sql/create/2026-09-16_fpu_classes.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const CLASSES = 'public.fpu_classes';
const ENROLLMENTS = 'public.fpu_enrollments';

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

const CLASS_CONSTRAINTS = [
  'fpu_classes_year_batch_uniq',
  'fpu_classes_year_sane',
  'fpu_classes_batch_sane',
  'fpu_classes_window_ordered',
  'fpu_classes_class_ordered',
];

const CHECKS: Array<[string, string]> = [
  ['fpu_classes table exists', `SELECT to_regclass('${CLASSES}') IS NOT NULL AS ok`],
  ...['year', 'batch', 'opens_on', 'closes_on', 'class_starts_on'].map(
    (col): [string, string] => [
      `fpu_classes.${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='fpu_classes' AND column_name='${col}'), false) AS ok`,
    ],
  ),
  [
    'fpu_classes.class_ends_on is NULLABLE ("not announced" is a state)',
    `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fpu_classes' AND column_name='class_ends_on'), false) AS ok`,
  ],
  ...CLASS_CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  [
    'trigger fpu_classes_touch_trg exists',
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${CLASSES}') AND tgname = 'fpu_classes_touch_trg') AS ok`,
  ],
  [
    'fpu_classes row level security is ENABLED with no policies',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${CLASSES}')), false)
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fpu_classes') AS ok`,
  ],
  ...['class_id', 'status', 'start_date_used', 'reviewed_by', 'reviewed_at', 'review_notes', 'completed_on'].map(
    (col): [string, string] => [
      `fpu_enrollments.${col} exists`,
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='fpu_enrollments' AND column_name='${col}') AS ok`,
    ],
  ),
  [
    'fpu_enrollments.status is NOT NULL with default pending',
    `SELECT COALESCE((SELECT is_nullable = 'NO' AND column_default LIKE '%pending%' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fpu_enrollments' AND column_name='status'), false) AS ok`,
  ],
  [
    'constraint fpu_enrollments_status_check',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fpu_enrollments_status_check') AS ok`,
  ],
  [
    'index fpu_enrollments_class_email_uniq is on lower(email)',
    `SELECT COALESCE((SELECT indexdef LIKE '%lower(email)%' FROM pg_indexes
       WHERE schemaname='public' AND indexname='fpu_enrollments_class_email_uniq'), false) AS ok`,
  ],
  [
    'index fpu_enrollments_class_status_idx',
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='fpu_enrollments_class_status_idx') AS ok`,
  ],
  [
    'fpu_enrollments row level security is ENABLED',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${ENROLLMENTS}')), false) AS ok`,
  ],
];

const LEGAL_CLASS: Record<string, string> = {
  year: '2026',
  batch: '1',
  opens_on: "date '2026-09-01'",
  closes_on: "date '2026-09-30'",
  class_starts_on: "date '2026-10-08'",
  class_ends_on: "date '2026-11-12'",
};

function insertClass(overrides: Record<string, string> = {}, returning = 'id'): string {
  const row = { ...LEGAL_CLASS, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${CLASSES} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')}) RETURNING ${returning}`;
}

const POSITIVE_CONTROL: [string, string] = ['a fully legal class is ACCEPTED (proves the suite can pass)', insertClass()];

const NO_END_CONTROL: [string, string] = [
  'a class with NO end date is ACCEPTED ("not announced" is a state)',
  insertClass({ class_ends_on: 'NULL' }),
];

const NEGATIVE_CLASS_CONTROLS: Array<[string, string]> = [
  ['a window that closes before it opens is rejected', insertClass({ closes_on: "date '2026-08-31'" })],
  ['a class that ends before it starts is rejected', insertClass({ class_ends_on: "date '2026-10-01'" })],
  ['batch 0 is rejected', insertClass({ batch: '0' })],
  ['batch 13 is rejected', insertClass({ batch: '13' })],
  ['year 1999 is rejected', insertClass({ year: '1999' })],
  ['a duplicate (year, batch) is rejected', `${insertClass()}; ${insertClass({ opens_on: "date '2026-10-01'", closes_on: "date '2026-10-31'" })}`],
];

/**
 * Enrollment controls need a class id, so each is a SEQUENCE of statements
 * (pg runs a `;`-separated simple query in order) against a fixed uuid. NOT a
 * data-modifying CTE chain: Postgres runs every CTE of one statement against
 * the same snapshot, so a parent deleted in the same statement that inserted
 * its child is not caught by the FK — the control would pass for the wrong
 * reason (it did, in the first dry run).
 */
const CTL_CLASS_ID = "'00000000-0000-4000-8000-0000000000c1'";
const insertCtlClass = insertClass({ id: CTL_CLASS_ID });
const insertCtlEnrollment = (email = "'control@simple.biz'", extra: Record<string, string> = {}) => {
  const row: Record<string, string> = {
    email,
    full_name: "'Control'",
    department: "'Accounting'",
    shift_schedule_est: "'9-5 EST'",
    class_id: CTL_CLASS_ID,
    ...extra,
  };
  const cols = Object.keys(row);
  return `INSERT INTO ${ENROLLMENTS} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
};

const ENROLLMENT_CONTROLS: Array<[string, string, 'accept' | 'reject']> = [
  ['a legal enrollment against a class is ACCEPTED', `${insertCtlClass}; ${insertCtlEnrollment()}`, 'accept'],
  [
    'a duplicate enrollment for the same class is rejected CASE-INSENSITIVELY',
    `${insertCtlClass}; ${insertCtlEnrollment()}; ${insertCtlEnrollment("'CONTROL@simple.biz'")}`,
    'reject',
  ],
  ['an unknown status is rejected', `${insertCtlClass}; ${insertCtlEnrollment("'control@simple.biz'", { status: "'maybe'" })}`, 'reject'],
  [
    'a class with enrollments cannot be deleted (on delete restrict)',
    `${insertCtlClass}; ${insertCtlEnrollment()}; DELETE FROM ${CLASSES} WHERE id = ${CTL_CLASS_ID}`,
    'reject',
  ],
];

const client = new Client({ connectionString });

async function runControl(label: string, sql: string, expect: 'accept' | 'reject'): Promise<boolean> {
  await client.query('SAVEPOINT ctl');
  let threw = '';
  try {
    await client.query(sql);
  } catch (e) {
    threw = (e as Error).message;
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl');
  await client.query('RELEASE SAVEPOINT ctl');
  const ok = expect === 'reject' ? threw !== '' : !threw;
  const why = expect === 'reject' ? (ok ? '' : ' — ACCEPTED, but should have been refused') : threw ? ` — ${threw}` : '';
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  return ok;
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — FPU classes + enrollment review columns`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${CLASSES}, ${ENROLLMENTS} (ALTER)`,
      `  Controls : 2 positive, ${NEGATIVE_CLASS_CONTROLS.length + 3} negative`,
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
  if (!dryRun) await client.query('BEGIN');

  if (!(await runControl(POSITIVE_CONTROL[0], POSITIVE_CONTROL[1], 'accept'))) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }
  if (!(await runControl(NO_END_CONTROL[0], NO_END_CONTROL[1], 'accept'))) failed++;
  for (const [label, sql] of NEGATIVE_CLASS_CONTROLS) {
    if (!(await runControl(label, sql, 'reject'))) failed++;
  }
  for (const [label, sql, expect] of ENROLLMENT_CONTROLS) {
    if (!(await runControl(label, sql, expect))) failed++;
  }

  await client.query('ROLLBACK');
  await client.end();

  console.log(
    failed === 0
      ? `\nAll checks passed.${dryRun ? ' Nothing was committed — re-run with --apply.' : ''}`
      : `\n${failed} check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nFailed:', (e as Error).message);
  try {
    await client.query('ROLLBACK');
  } catch {
    /* connection may already be gone */
  }
  await client.end().catch(() => {});
  process.exit(1);
});

/**
 * [HSL-SCHEDULING]
 * Applies references/sql/create/2026-09-14_employee_schedule_periods.sql — the
 * effective-dated table behind Manager -> My Team -> HSL -> Scheduling — then
 * verifies the table, its comment, all three indexes, every CHECK constraint,
 * the normalising trigger and RLS landed, AND that each constraint actually
 * rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-employee-schedules-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-employee-schedules-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-employee-schedules-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-employee-schedules-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a
 * transaction that is always rolled back. Postgres DDL is transactional, so this
 * proves the migration parses, the table builds and the CHECKs bite while
 * leaving production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The user is `postgres.<ref>`, and an `@` in the password MUST be
 * percent-encoded as %40 or the driver truncates the password at the first `@`.
 *
 * Run order does NOT matter here: the route reports `migrated: false` when the
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

const SQL_RELATIVE = 'references/sql/create/2026-09-14_employee_schedule_periods.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.employee_schedule_periods';

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

const CONSTRAINTS = [
  'employee_schedule_periods_window_both_or_neither',
  'employee_schedule_periods_window_in_day',
  'employee_schedule_periods_window_not_zero_length',
  'employee_schedule_periods_dates_ordered',
  'employee_schedule_periods_rest_days_valid',
  'employee_schedule_periods_email_present',
  'employee_schedule_periods_department_present',
];

const INDEXES = [
  'employee_schedule_periods_email_from_uniq',
  'employee_schedule_periods_department_idx',
  'employee_schedule_periods_current_idx',
];

const CHECKS: Array<[string, string]> = [
  ['employee_schedule_periods table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  [
    'table comment says it is never a pay input',
    `SELECT COALESCE((SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
        LIKE '%never a pay input%'), false) AS ok`,
  ],
  // effective_from is the spine of the whole model: a null one is a period that
  // covers nothing and sorts nowhere.
  ...['work_email', 'department', 'rest_days', 'timezone', 'effective_from'].map(
    (col): [string, string] => [
      `${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_schedule_periods'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  // "Hours not set" and "still current" are STATES. If either column were NOT
  // NULL the model would have to invent midnight or an end date.
  ...['shift_start_minute', 'shift_end_minute', 'effective_to'].map(
    (col): [string, string] => [
      `${col} is NULLABLE (it is a real state, not a missing value)`,
      `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_schedule_periods'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  ...['effective_from', 'effective_to'].map(
    (col): [string, string] => [
      `${col} is a DATE (a calendar day, not an instant)`,
      `SELECT COALESCE((SELECT data_type = 'date' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_schedule_periods'
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
  [
    'the uniqueness is on LOWER(work_email) — not the raw column',
    `SELECT COALESCE((SELECT indexdef LIKE '%lower(work_email)%' FROM pg_indexes
       WHERE schemaname='public'
         AND indexname='employee_schedule_periods_email_from_uniq'), false) AS ok`,
  ],
  [
    'trigger employee_schedule_periods_normalize_trg exists',
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${TABLE}')
         AND tgname = 'employee_schedule_periods_normalize_trg') AS ok`,
  ],
  [
    'row level security is ENABLED',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class
       WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='employee_schedule_periods') AS ok`,
  ],
];

const LEGAL_ROW: Record<string, string> = {
  work_email: "'control@simple.biz'",
  department: "'hsl:intake_specialist'",
  rest_days: "array[0,6]::smallint[]",
  effective_from: "date '2026-09-14'",
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
  'a fully legal schedule row is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

/** The second positive control: "hours not set" is a STATE and must SAVE. */
const HOURS_NOT_SET_CONTROL: [string, string] = [
  'a period with NO shift window is ACCEPTED ("hours not set" is a state)',
  insertRow({ shift_start_minute: 'NULL', shift_end_minute: 'NULL' }),
];

const OVERNIGHT_CONTROL: [string, string] = [
  'an OVERNIGHT window (22:00-06:00) is ACCEPTED — end < start crosses midnight',
  insertRow({ shift_start_minute: '1320', shift_end_minute: '360' }),
];

const TRIGGER_CONTROLS: Array<[string, string]> = [
  [
    'the trigger lower-cases and trims the work email',
    `INSERT INTO ${TABLE} (work_email, department, effective_from)
     VALUES ('  Control@Simple.Biz  ', 'hsl:intake_specialist', date '2026-09-14')
     RETURNING (work_email = 'control@simple.biz') AS ok`,
  ],
  [
    'the trigger sorts and de-duplicates rest days',
    `INSERT INTO ${TABLE} (work_email, department, rest_days, effective_from)
     VALUES ('control2@simple.biz', 'hsl:intake_specialist',
             array[6,0,6,0]::smallint[], date '2026-09-14')
     RETURNING (rest_days = array[0,6]::smallint[]) AS ok`,
  ],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  [
    'exactly ONE blank time is rejected (the half-filled form)',
    insertRow({ shift_start_minute: '540', shift_end_minute: 'NULL' }),
  ],
  [
    'a zero-length window is rejected',
    insertRow({ shift_start_minute: '540', shift_end_minute: '540' }),
  ],
  [
    'a minute outside the day is rejected',
    insertRow({ shift_start_minute: '1440', shift_end_minute: '60' }),
  ],
  [
    'an end date BEFORE the start date is rejected',
    insertRow({ effective_to: "date '2026-09-01'" }),
  ],
  ['a weekday of 7 is rejected', insertRow({ rest_days: 'array[7]::smallint[]' })],
  ['a blank work email is rejected', insertRow({ work_email: "'   '" })],
  ['a blank department is rejected', insertRow({ department: "'   '" })],
  [
    'a duplicate (email, effective_from) is rejected',
    `${insertRow()}; ${insertRow({ department: "'hsl:filing_specialist'" })}`,
  ],
  [
    'the duplicate check is CASE-INSENSITIVE',
    `${insertRow()}; ${insertRow({ work_email: "'CONTROL@simple.biz'" })}`,
  ],
];

const client = new Client({ connectionString });

async function runControl(
  label: string,
  sql: string,
  expect: 'accept' | 'reject' | 'true',
): Promise<boolean> {
  await client.query('SAVEPOINT ctl');
  let threw = '';
  let returned: unknown = null;
  try {
    const { rows } = await client.query(sql);
    returned = rows[0]?.ok ?? null;
  } catch (e) {
    threw = (e as Error).message;
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl');
  await client.query('RELEASE SAVEPOINT ctl');

  const ok =
    expect === 'reject' ? threw !== '' : expect === 'true' ? returned === true && !threw : !threw;
  const why = expect === 'reject' ? (ok ? '' : ' — ACCEPTED, but should have been refused') : threw ? ` — ${threw}` : '';
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  return ok;
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — HSL Scheduling: employee_schedule_periods`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : 3 positive, ${TRIGGER_CONTROLS.length} trigger, ${NEGATIVE_CONTROLS.length} negative`,
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

  const positiveOk = await runControl(POSITIVE_CONTROL[0], POSITIVE_CONTROL[1], 'accept');
  if (!positiveOk) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }
  if (!(await runControl(HOURS_NOT_SET_CONTROL[0], HOURS_NOT_SET_CONTROL[1], 'accept'))) failed++;
  if (!(await runControl(OVERNIGHT_CONTROL[0], OVERNIGHT_CONTROL[1], 'accept'))) failed++;
  for (const [label, sql] of TRIGGER_CONTROLS) {
    if (!(await runControl(label, sql, 'true'))) failed++;
  }
  for (const [label, sql] of NEGATIVE_CONTROLS) {
    if (!(await runControl(label, sql, 'reject'))) failed++;
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

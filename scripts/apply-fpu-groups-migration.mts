/**
 * [FPU-GROUPS]
 * Applies references/sql/create/2026-09-17_fpu_groups_attendance.sql — FPU class
 * groups, weekly session attendance, the class-close stamp and the failed/override
 * columns — then verifies every object landed AND that each constraint rejects
 * what it exists to reject.
 *
 *   node --import tsx scripts/apply-fpu-groups-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-fpu-groups-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-fpu-groups-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-fpu-groups-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL runs inside a transaction that
 * is always rolled back. Its OWN script and its OWN .cmd, never bolted onto the
 * FPU classes migration: that one's last run is a thing Kane already believes
 * finished, and piggy-backing new columns onto it hides them.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER
 * (memory/migration-apply-needs-database-url):
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 * Percent-encode any '@' in the password as %40.
 *
 * Run order does NOT matter: every new route reports `migrated: false` when the
 * tables are absent rather than 500ing, so shipping the code first is safe.
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

const SQL_RELATIVE = 'references/sql/create/2026-09-17_fpu_groups_attendance.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const GROUPS = 'public.fpu_class_groups';
const MEMBERS = 'public.fpu_group_members';
const ATTENDANCE = 'public.fpu_session_attendance';

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
  'fpu_class_groups_class_no_uniq',
  'fpu_class_groups_no_sane',
  'fpu_group_members_enrollment_uniq',
  'fpu_group_members_email_present',
  'fpu_group_members_left_pair',
  'fpu_session_attendance_uniq',
  'fpu_session_attendance_no_sane',
  'fpu_session_attendance_marked_by_present',
  'fpu_classes_class_closed_pair',
  'fpu_enrollments_override_value',
  'fpu_enrollments_override_pair',
];

const CHECKS: Array<[string, string]> = [
  ...[GROUPS, MEMBERS, ATTENDANCE].map((t): [string, string] => [`${t} exists`, `SELECT to_regclass('${t}') IS NOT NULL AS ok`]),
  // `present` must be NOT NULL: the ROW's absence is how "unmarked" is stored, so
  // a nullable column would give that state a second, silent spelling.
  [
    'fpu_session_attendance.present is NOT NULL (unmarked is the ABSENCE of a row)',
    `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fpu_session_attendance' AND column_name='present'), false) AS ok`,
  ],
  [
    'fpu_session_attendance.present has NO default',
    `SELECT COALESCE((SELECT column_default IS NULL FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fpu_session_attendance' AND column_name='present'), false) AS ok`,
  ],
  ...['class_closed_on', 'class_closed_by'].map((col): [string, string] => [
    `fpu_classes.${col} exists`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fpu_classes' AND column_name='${col}') AS ok`,
  ]),
  ...['attendance_override', 'attendance_override_by', 'attendance_override_reason', 'attendance_override_at'].map(
    (col): [string, string] => [
      `fpu_enrollments.${col} exists`,
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='fpu_enrollments' AND column_name='${col}') AS ok`,
    ],
  ),
  [
    "fpu_enrollments.status now admits 'failed'",
    `SELECT COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%failed%' FROM pg_constraint
       WHERE conname = 'fpu_enrollments_status_check'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  [
    'trigger fpu_group_members_normalize_trg exists',
    `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('${MEMBERS}') AND tgname = 'fpu_group_members_normalize_trg') AS ok`,
  ],
  ...[GROUPS, MEMBERS, ATTENDANCE].map((t): [string, string] => [
    `${t} row level security is ENABLED with no policies`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${t}')), false)
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename = split_part('${t}', '.', 2)) AS ok`,
  ]),
];

/**
 * Controls run against a REAL class and a REAL enrollment, because the FKs mean
 * a synthetic id cannot be inserted at all. They are created here, inside the
 * transaction, and rolled back with everything else — and they use year 2099 /
 * batch 12, the top of both CHECK ranges, so they can never collide with a class
 * HR actually made (the FPU classes script learned that the hard way).
 */
// 'g' is not a hex digit, so these must stay inside [0-9a-f] or nothing inserts.
const CTL_CLASS = "'00000000-0000-4000-8000-0000000c0001'";
const CTL_ENR = "'00000000-0000-4000-8000-0000000e0001'";
const CTL_ENR2 = "'00000000-0000-4000-8000-0000000e0002'";
const CTL_GROUP = "'00000000-0000-4000-8000-0000000a0001'";

const SETUP = `
  INSERT INTO public.fpu_classes (id, year, batch, opens_on, closes_on, class_starts_on, class_ends_on)
  VALUES (${CTL_CLASS}, 2099, 12, date '2099-01-01', date '2099-01-31', date '2099-02-01', date '2099-03-08');
  INSERT INTO public.fpu_enrollments (id, email, full_name, department, shift_schedule_est, class_id, status)
  VALUES (${CTL_ENR}, 'control@simple.biz', 'Control', 'Accounting', '9-5 EST', ${CTL_CLASS}, 'approved'),
         (${CTL_ENR2}, 'control2@simple.biz', 'Control Two', 'Accounting', '9-5 EST', ${CTL_CLASS}, 'approved');
  INSERT INTO public.fpu_class_groups (id, class_id, group_no)
  VALUES (${CTL_GROUP}, ${CTL_CLASS}, 1);
`;

/** One legal member row, email deliberately mixed-case to exercise the trigger. */
const member = `INSERT INTO ${MEMBERS} (group_id, enrollment_id, email) VALUES (${CTL_GROUP}, ${CTL_ENR}, 'Control@Simple.biz')`;

const POSITIVE: Array<[string, string]> = [
  ['a legal group, member and attendance row are ACCEPTED (proves the suite can pass)',
   `${member}; INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR}, ${CTL_CLASS}, 1, true, 'leader@simple.biz')`],
  ['a deliberate ABSENT mark is ACCEPTED (present=false is a real answer)',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR}, ${CTL_CLASS}, 2, false, 'leader@simple.biz')`],
  ['a member who LEFT (date AND reason) is ACCEPTED',
   `INSERT INTO ${MEMBERS} (group_id, enrollment_id, email, left_on, left_reason) VALUES (${CTL_GROUP}, ${CTL_ENR}, 'control@simple.biz', date '2099-02-10', 'offboarded')`],
  ["status 'failed' is ACCEPTED", `UPDATE public.fpu_enrollments SET status='failed' WHERE id=${CTL_ENR}`],
  ['an HR override with an author is ACCEPTED', `UPDATE public.fpu_enrollments SET attendance_override='pass', attendance_override_by='hr@simple.biz' WHERE id=${CTL_ENR}`],
  ['the trigger lower-cases the member email (division by zero if it did not)',
   `${member}; SELECT 1/(CASE WHEN EXISTS (SELECT 1 FROM ${MEMBERS} WHERE email='control@simple.biz' AND enrollment_id=${CTL_ENR}) THEN 1 ELSE 0 END)`],
];

const NEGATIVE: Array<[string, string]> = [
  ['the same person cannot be in two groups',
   `${member}; INSERT INTO ${MEMBERS} (group_id, enrollment_id, email) VALUES (${CTL_GROUP}, ${CTL_ENR}, 'control@simple.biz')`],
  ['a second mark for the same (person, session) is rejected',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR}, ${CTL_CLASS}, 1, true, 'a@simple.biz'); INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR}, ${CTL_CLASS}, 1, false, 'b@simple.biz')`],
  ['a mark with no author is rejected',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR2}, ${CTL_CLASS}, 1, true, '   ')`],
  ['session 0 is rejected',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR2}, ${CTL_CLASS}, 0, true, 'a@simple.biz')`],
  ['session 53 is rejected',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES (${CTL_ENR2}, ${CTL_CLASS}, 53, true, 'a@simple.biz')`],
  ['a duplicate group number in one class is rejected',
   `INSERT INTO ${GROUPS} (class_id, group_no) VALUES (${CTL_CLASS}, 1)`],
  ['group number 0 is rejected', `INSERT INTO ${GROUPS} (class_id, group_no) VALUES (${CTL_CLASS}, 0)`],
  ['a blank member email is rejected', `INSERT INTO ${MEMBERS} (group_id, enrollment_id, email) VALUES (${CTL_GROUP}, ${CTL_ENR}, '   ')`],
  ['a leaver with no reason is rejected',
   `INSERT INTO ${MEMBERS} (group_id, enrollment_id, email, left_on) VALUES (${CTL_GROUP}, ${CTL_ENR}, 'control@simple.biz', date '2099-02-10')`],
  ['a class closed by nobody is rejected', `UPDATE public.fpu_classes SET class_closed_on=date '2099-03-09' WHERE id=${CTL_CLASS}`],
  ['an override by nobody is rejected', `UPDATE public.fpu_enrollments SET attendance_override='pass' WHERE id=${CTL_ENR}`],
  ['an unknown override value is rejected', `UPDATE public.fpu_enrollments SET attendance_override='maybe', attendance_override_by='hr@simple.biz' WHERE id=${CTL_ENR}`],
  ['an unknown enrollment status is rejected', `UPDATE public.fpu_enrollments SET status='graduated' WHERE id=${CTL_ENR}`],
  ['a class with groups cannot be deleted (on delete restrict)',
   `${member}; DELETE FROM public.fpu_classes WHERE id=${CTL_CLASS}`],
  ['a mark for an enrollment that does not exist is rejected',
   `INSERT INTO ${ATTENDANCE} (enrollment_id, class_id, session_no, present, marked_by) VALUES ('00000000-0000-4000-8000-0000000effff', ${CTL_CLASS}, 1, true, 'a@simple.biz')`],
  ['a member row for a group that does not exist is rejected',
   `INSERT INTO ${MEMBERS} (group_id, enrollment_id, email) VALUES ('00000000-0000-4000-8000-0000000affff', ${CTL_ENR2}, 'control2@simple.biz')`],
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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — FPU groups, session attendance, class close`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${GROUPS}, ${MEMBERS}, ${ATTENDANCE} (+ ALTER fpu_classes, fpu_enrollments)`,
      `  Controls : ${POSITIVE.length} positive, ${NEGATIVE.length} negative`,
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
  // The control fixtures live inside the same transaction and roll back with it.
  await client.query(SETUP);

  const first = await runControl(POSITIVE[0]![0], POSITIVE[0]![1], 'accept');
  if (!first) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }
  for (const [label, sql] of POSITIVE.slice(1)) if (!(await runControl(label, sql, 'accept'))) failed++;
  for (const [label, sql] of NEGATIVE) if (!(await runControl(label, sql, 'reject'))) failed++;

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

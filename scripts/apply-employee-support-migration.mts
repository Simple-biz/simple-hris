/**
 * [EMPLOYEE-SUPPORT]
 * Applies references/sql/create/2026-09-16_employee_support.sql — the two tables
 * behind Employee Support — then verifies both tables, their comments, every
 * index, every CHECK constraint, both normalising triggers and RLS landed, that
 * each constraint actually rejects what it exists to reject, and that NEITHER
 * table joined the supabase_realtime publication.
 *
 *   node --import tsx scripts/apply-employee-support-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-employee-support-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-employee-support-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-employee-support-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a
 * transaction that is always rolled back. Postgres DDL is transactional, so this
 * proves the migration parses, the tables build and the CHECKs bite while
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
 * Run order does NOT matter: the routes report `migrated: false` when the tables
 * are absent rather than 500ing, so shipping the code first is safe.
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

const SQL_RELATIVE = 'references/sql/create/2026-09-16_employee_support.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TICKETS = 'public.employee_support_tickets';
const MESSAGES = 'public.employee_support_messages';

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
  'employee_support_tickets_category_valid',
  'employee_support_tickets_status_valid',
  'employee_support_tickets_flag_both_or_neither',
  'employee_support_tickets_claim_both_or_neither',
  'employee_support_tickets_close_both_or_neither',
  'employee_support_tickets_closed_has_stamp',
  'employee_support_tickets_claimed_has_owner',
  'employee_support_tickets_work_email_present',
  'employee_support_tickets_filed_by_present',
  'employee_support_tickets_concern_present',
  'employee_support_tickets_concern_bounded',
  'employee_support_messages_side_valid',
  'employee_support_messages_flag_both_or_neither',
  'employee_support_messages_author_present',
  'employee_support_messages_body_present',
  'employee_support_messages_body_bounded',
];

const INDEXES = [
  'employee_support_tickets_no_uniq',
  'employee_support_tickets_mine_idx',
  'employee_support_tickets_open_idx',
  'employee_support_tickets_flagged_idx',
  'employee_support_messages_thread_idx',
];

/** Every category the app knows. Kept in step with SUPPORT_CATEGORIES in src/lib/support/types.ts. */
const CATEGORIES = [
  'pay_payslip',
  'bonus_pab',
  'hours_time_adjustment',
  'bank_payout',
  'documents_certificates',
  'gmail',
  'hubstaff',
  'roboform',
  'other',
];

const CHECKS: Array<[string, string]> = [
  ['employee_support_tickets exists', `SELECT to_regclass('${TICKETS}') IS NOT NULL AS ok`],
  ['employee_support_messages exists', `SELECT to_regclass('${MESSAGES}') IS NOT NULL AS ok`],

  // The two decisions most likely to be undone by a well-meaning future edit,
  // pinned as assertions rather than left in a comment.
  [
    'employee_support_tickets is NOT in the supabase_realtime publication',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public'
         AND tablename='employee_support_tickets') AS ok`,
  ],
  [
    'employee_support_messages is NOT in the supabase_realtime publication',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public'
         AND tablename='employee_support_messages') AS ok`,
  ],

  ...[TICKETS, MESSAGES].map((t): [string, string] => [
    `${t.split('.')[1]} has row level security ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${t}')), false) AS ok`,
  ]),
  ...['employee_support_tickets', 'employee_support_messages'].map((t): [string, string] => [
    `${t} has NO policies (anon/authenticated get zero rows)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),

  [
    'ticket_no is its OWN identity series, not shared with the Kanban board',
    `SELECT COALESCE((SELECT is_identity = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_tickets'
         AND column_name='ticket_no'), false) AS ok`,
  ],

  // work_email is the key every other surface joins on; filed_by_email is how
  // they got here. Neither is optional, and they are not the same question.
  ...['work_email', 'filed_by_email', 'category', 'concern', 'status'].map(
    (col): [string, string] => [
      `tickets.${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_support_tickets'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  // These are real states, not missing values: unclaimed, unanswered, unflagged.
  ...['claimed_by', 'claimed_at', 'first_response_at', 'flagged_at', 'flag_reason'].map(
    (col): [string, string] => [
      `tickets.${col} is NULLABLE (it is a real state, not a missing value)`,
      `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_support_tickets'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  [
    'messages cascade when their ticket is deleted',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('${MESSAGES}')
         AND contype = 'f' AND confdeltype = 'c') AS ok`,
  ],
  [
    'messages are immutable — there is no updated_at to change',
    `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_messages'
         AND column_name='updated_at') AS ok`,
  ],
  [
    'the "mine" index is on LOWER(work_email) — not the raw column',
    `SELECT COALESCE((SELECT indexdef LIKE '%lower(work_email)%' FROM pg_indexes
       WHERE schemaname='public' AND indexname='employee_support_tickets_mine_idx'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
  ...[
    ['employee_support_tickets_normalize_trg', TICKETS],
    ['employee_support_messages_normalize_trg', MESSAGES],
  ].map(([name, table]): [string, string] => [
    `trigger ${name} exists`,
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${table}') AND tgname = '${name}') AS ok`,
  ]),
];

const LEGAL_TICKET: Record<string, string> = {
  work_email: "'control@simple.biz'",
  filed_by_email: "'control@simple.biz'",
  category: "'pay_payslip'",
  concern: "'My payslip for the 06 Sep week has not arrived.'",
};

function insertTicket(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_TICKET, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TICKETS} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/**
 * POSITIVE CONTROL — without it every "rejected" below could be passing for an
 * unrelated reason, and a suite that cannot accept a good row is
 * indistinguishable from one where the constraints all work.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal ticket is ACCEPTED (proves the suite can pass)',
  insertTicket(),
];

const ACCEPT_CONTROLS: Array<[string, string]> = [
  [
    'an UNCLAIMED, UNANSWERED, UNFLAGGED ticket is ACCEPTED (all three are states)',
    insertTicket(),
  ],
  [
    'a ticket filed from an ALTERNATE address is ACCEPTED (work_email != filed_by_email)',
    insertTicket({ filed_by_email: "'control.personal@gmail.com'" }),
  ],
  [
    'a FLAGGED ticket is still ACCEPTED — screening records, it never blocks',
    insertTicket({ flagged_at: 'now()', flag_reason: "'Contains strong language.'" }),
  ],
  ...CATEGORIES.map((c): [string, string] => [
    `category '${c}' is ACCEPTED`,
    insertTicket({ category: `'${c}'` }),
  ]),
];

const TRIGGER_CONTROLS: Array<[string, string]> = [
  [
    'the trigger lower-cases and trims the work email',
    `INSERT INTO ${TICKETS} (work_email, filed_by_email, category, concern)
     VALUES ('  Control@Simple.Biz  ', 'control@simple.biz', 'pay_payslip', 'x')
     RETURNING (work_email = 'control@simple.biz') AS ok`,
  ],
  [
    'the trigger lower-cases the claimant',
    `INSERT INTO ${TICKETS} (work_email, filed_by_email, category, concern, status, claimed_by, claimed_at)
     VALUES ('control@simple.biz', 'control@simple.biz', 'pay_payslip', 'x',
             'claimed', '  Carla@Simple.BIZ ', now())
     RETURNING (claimed_by = 'carla@simple.biz') AS ok`,
  ],
  [
    'a blank department is stored as NULL, not as an empty string',
    `INSERT INTO ${TICKETS} (work_email, filed_by_email, category, concern, department)
     VALUES ('control@simple.biz', 'control@simple.biz', 'pay_payslip', 'x', '   ')
     RETURNING (department IS NULL) AS ok`,
  ],
  [
    'the message trigger lower-cases the author',
    `WITH t AS (${insertTicket()} RETURNING id)
     INSERT INTO ${MESSAGES} (ticket_id, author_side, author_email, body)
     SELECT id, 'staff', '  Carla@Simple.BIZ ', 'Looking into it.' FROM t
     RETURNING (author_email = 'carla@simple.biz') AS ok`,
  ],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  [
    'an unknown category is rejected (the CHECK and SUPPORT_CATEGORIES must agree)',
    insertTicket({ category: "'schedules'" }),
  ],
  [
    'a schedules/time-off category does NOT exist — Carla routed those to a manager',
    insertTicket({ category: "'time_off'" }),
  ],
  ['an unknown status is rejected', insertTicket({ status: "'pending'" })],
  ['a blank concern is rejected', insertTicket({ concern: "'   '" })],
  ['a blank work email is rejected', insertTicket({ work_email: "'   '" })],
  ['a blank filed_by email is rejected', insertTicket({ filed_by_email: "'   '" })],
  [
    'a concern over 4000 chars is rejected',
    insertTicket({ concern: `repeat('x', 4001)` }),
  ],
  [
    'a flag with no reason is rejected (a flag is an assertion)',
    insertTicket({ flagged_at: 'now()' }),
  ],
  [
    'a reason with no flag timestamp is rejected',
    insertTicket({ flag_reason: "'Contains strong language.'" }),
  ],
  [
    'claimed_at without a claimant is rejected',
    insertTicket({ claimed_at: 'now()' }),
  ],
  [
    'status=claimed with nobody holding it is rejected',
    insertTicket({ status: "'claimed'" }),
  ],
  [
    'status=closed with no closure stamp is rejected',
    insertTicket({ status: "'closed'" }),
  ],
  [
    'an unknown author side is rejected',
    `WITH t AS (${insertTicket()} RETURNING id)
     INSERT INTO ${MESSAGES} (ticket_id, author_side, author_email, body)
     SELECT id, 'manager', 'carla@simple.biz', 'x' FROM t`,
  ],
  [
    'an empty message body is rejected',
    `WITH t AS (${insertTicket()} RETURNING id)
     INSERT INTO ${MESSAGES} (ticket_id, author_side, author_email, body)
     SELECT id, 'staff', 'carla@simple.biz', '   ' FROM t`,
  ],
  [
    'a message against a ticket that does not exist is rejected',
    `INSERT INTO ${MESSAGES} (ticket_id, author_side, author_email, body)
     VALUES (gen_random_uuid(), 'staff', 'carla@simple.biz', 'x')`,
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
  const why =
    expect === 'reject'
      ? ok
        ? ''
        : ' — ACCEPTED, but should have been refused'
      : threw
        ? ` — ${threw}`
        : '';
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  return ok;
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Employee Support`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${TICKETS}, ${MESSAGES}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : ${1 + ACCEPT_CONTROLS.length} positive, ${TRIGGER_CONTROLS.length} trigger, ${NEGATIVE_CONTROLS.length} negative`,
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
  for (const [label, sql] of ACCEPT_CONTROLS) {
    if (!(await runControl(label, sql, 'accept'))) failed++;
  }
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

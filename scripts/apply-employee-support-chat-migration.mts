/**
 * [EMPLOYEE-SUPPORT-CHAT]
 * Applies the Employee Support LIVE CHAT migration — three tables and two CHECK
 * widens — then verifies every table, comment, index, CHECK, trigger and RLS
 * setting landed, that each constraint actually rejects what it exists to
 * reject, that the two widened CHECK lists did not LOSE a single value, and that
 * none of the three new tables joined the supabase_realtime publication.
 *
 *   node --import tsx scripts/apply-employee-support-chat-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-employee-support-chat-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-employee-support-chat-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-employee-support-chat-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a
 * transaction that is always rolled back. Postgres DDL is transactional, so this
 * proves the migration parses, the tables build and the CHECKs bite while
 * leaving production exactly as it was.
 *
 * ONE TRANSACTION ACROSS ALL THE FILES, in --apply as well as --dry. The files
 * carry no BEGIN/COMMIT of their own precisely so this script can own the
 * transaction: a failure in the third file must not leave the first two
 * committed, because the widen files read the live constraint and a half-applied
 * run would make the next run's floor wrong.
 *
 * ONE THING TO KNOW ABOUT THE REHEARSAL: the two widen files DROP and re-ADD a
 * CHECK, which takes an ACCESS EXCLUSIVE lock on `employee_roles` and
 * `employee_notifications` — and in a dry run that lock is held until the final
 * ROLLBACK, i.e. for the whole control suite. It is seconds, not minutes, but
 * every notification INSERT in the system waits behind it. Do not rehearse in
 * the middle of a payroll notification burst.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The user is `postgres.<ref>`, and an `@` in the password MUST be
 * percent-encoded as %40 or the driver truncates the password at the first `@`.
 *
 * PREREQUISITE: the 2026-09-16 ticket migration. The chat sessions table has a
 * foreign key into public.employee_support_tickets. Its live state is UNKNOWN,
 * not unapplied — nothing has been measured against production — so this script
 * checks for the table before it applies anything and says which launcher to run.
 *
 * Run order against the app does NOT matter: the routes report `migrated: false`
 * when the tables are absent rather than 500ing, so shipping the code first is
 * safe.
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

/**
 * THE MIGRATION IS A LIST, NOT A SPECIAL CASE.
 *
 * Applied in this order, inside one transaction. The Employee Support TICKET
 * side still owes two files of its own — a triage ALTER and
 * `2026-09-16_add_support_notification_types.sql` (v1 plan task 3) — and they
 * fold in by adding a line here. Nothing else in this script changes: every
 * check below is keyed on an object name, not on which file created it.
 *
 * The apply-fpu-classes script grew a second and then a third file as three
 * hand-copied `const`s and a bespoke `applySql()`; this is that shape's
 * replacement.
 */
const SQL_RELATIVE_PATHS = [
  'references/sql/create/2026-09-19_employee_support_chat.sql',
  'references/sql/alter/2026-09-19_employee_support_role.sql',
  'references/sql/alter/2026-09-19_add_chat_notification_types.sql',
];

const SQL_FILES = SQL_RELATIVE_PATHS.map((rel) => ({
  rel,
  abs: path.join(REPO_ROOT, ...rel.split('/')),
}));

const missingFile = SQL_FILES.find((f) => !existsSync(f.abs));
if (missingFile) {
  console.error(`Migration SQL not found at ${missingFile.abs}`);
  process.exit(1);
}

const SESSIONS = 'public.employee_support_chat_sessions';
const MESSAGES = 'public.employee_support_chat_messages';
const AGENTS = 'public.employee_support_chat_agents';
const TICKETS = 'public.employee_support_tickets';
const NEW_TABLES = ['employee_support_chat_sessions', 'employee_support_chat_messages', 'employee_support_chat_agents'];

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

/**
 * The full role list the widened CHECK must still allow, restated here
 * INDEPENDENTLY of references/sql/alter/2026-09-19_employee_support_role.sql.
 *
 * The duplication is the point. The failure this whole migration is built
 * against is a widen that restates a SUBSET and silently breaks every omitted
 * value's INSERT; a verifier that imported the same array could not catch it,
 * because it would be asking the list about itself. Two hand-written copies
 * disagreeing is a FAIL line, which is what we want.
 */
const EXPECTED_ROLES = [
  'admin',
  'ceo',
  'hr_coordinator',
  'accounting',
  'manager',
  'orphanage_manager',
  'contractor',
  'qc',
  'tickets',
  'employee_support', // the new one
  // legacy: history only, not assignable since 2026-06-18
  'finance',
  'payroll_coordinator',
  'payroll_manager',
  'viewer',
];

/** Same reasoning as EXPECTED_ROLES — an independent restatement, not an import. */
const EXPECTED_NOTIFICATION_TYPES = [
  'rate.change',
  'promotion',
  'dispute.approved',
  'dispute.denied',
  'dispute.revoked',
  'onboarding.submitted',
  'time_adjustment.approved',
  'time_adjustment.denied',
  'transfer.requested',
  'transfer.approved',
  'transfer.rejected',
  'transfer.release_requested',
  'transfer.released',
  'transfer.declined',
  'transfer.applied',
  'payroll.processing_started',
  'payroll.processing_stopped',
  'payroll.paid',
  'payroll.available',
  'payroll.hours_gap',
  'special_transfer.recorded',
  'qc.scores_submitted',
  'qc.scores_returned',
  'people.banking.self_updated',
  'people.banking.overridden',
  'bank_info.requested',
  'offboarding.requested',
  'offboarding.request_completed',
  'offboarding.request_dismissed',
  'offboarding.request_returned',
  'resignation.submitted',
  'resignation.approved',
  'resignation.rejected',
  'ticket.replied',
  'ticket.assigned',
  'documents.requested',
  'documents.signed',
  'documents.rejected',
  'bank_preferred.decided',
  'pab.excluded',
  'pab.restored',
  'kpi.scored',
  'ticket.moved',
  'kpi.published',
  'support_chat.replied', // the new ones
  'support_chat.became_ticket',
];

/** Mirrors CHAT_SESSION_STATUSES in src/lib/support/chat-types.ts. */
const SESSION_STATUSES = ['waiting', 'claimed', 'live', 'ended', 'abandoned'];
/** Mirrors CHAT_AUTHOR_SIDES. 'system' is the one the ticket table does not have. */
const AUTHOR_SIDES = ['employee', 'agent', 'system'];

const CONSTRAINTS = [
  'employee_support_chat_sessions_status_valid',
  'employee_support_chat_sessions_claim_both_or_neither',
  'employee_support_chat_sessions_became_both_or_neither',
  'employee_support_chat_sessions_claimed_has_owner',
  'employee_support_chat_sessions_waiting_is_unclaimed',
  'employee_support_chat_sessions_ended_has_stamp',
  'employee_support_chat_sessions_only_abandoned_becomes_ticket',
  'employee_support_chat_sessions_work_email_present',
  'employee_support_chat_sessions_filed_by_present',
  'employee_support_chat_messages_side_valid',
  'employee_support_chat_messages_author_matches_side',
  'employee_support_chat_messages_flag_both_or_neither',
  'employee_support_chat_messages_body_present',
  'employee_support_chat_messages_body_bounded',
  'employee_support_chat_agents_since_matches_toggle',
  'employee_support_chat_agents_beat_matches_toggle',
  'employee_support_chat_agents_email_present',
];

const INDEXES = [
  'employee_support_chat_sessions_no_uniq',
  'employee_support_chat_sessions_one_open_per_employee',
  'employee_support_chat_sessions_queue_idx',
  'employee_support_chat_sessions_agent_idx',
  'employee_support_chat_sessions_mine_idx',
  'employee_support_chat_sessions_stale_idx',
  'employee_support_chat_messages_thread_idx',
  'employee_support_chat_messages_flagged_idx',
  'employee_support_chat_agents_on_queue_idx',
];

const TRIGGERS: Array<[string, string]> = [
  ['employee_support_chat_sessions_normalize_trg', SESSIONS],
  ['employee_support_chat_messages_normalize_trg', MESSAGES],
  ['employee_support_chat_agents_normalize_trg', AGENTS],
];

/** `ARRAY['a','b']::text[]` — values are repo constants, never user input. */
function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}

/**
 * Asserts a CHECK constraint still allows EVERY value in `values`, and names the
 * ones it does not. `position(... in ...)` rather than LIKE: an underscore is a
 * LIKE wildcard, and `payroll_coordinator` matching by wildcard would turn this
 * proof into a formality.
 */
function constraintCoverage(conname: string, values: string[]): string {
  return `WITH d AS (
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = '${conname}'
    ), v AS (
      SELECT unnest(${sqlTextArray(values)}) AS val
    )
    SELECT
      (SELECT count(*) FROM d) = 1
        AND NOT EXISTS (SELECT 1 FROM v, d WHERE position(quote_literal(v.val) in d.def) = 0) AS ok,
      (SELECT string_agg(v.val, ', ') FROM v, d WHERE position(quote_literal(v.val) in d.def) = 0) AS detail`;
}

const CHECKS: Array<[string, string]> = [
  ...NEW_TABLES.map((t): [string, string] => [
    `${t} exists`,
    `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`,
  ]),

  // The decision most likely to be undone by a well-meaning future edit, pinned
  // as an assertion rather than left in a comment. ABSENCE IS THE PASS: a chat
  // transcript on a public Broadcast topic is the hole this design exists to
  // avoid, and the moment one of these tables joins the publication, delivering
  // it to the anon browser would require a permissive SELECT policy.
  ...NEW_TABLES.map((t): [string, string] => [
    `${t} is NOT in the supabase_realtime publication`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public'
         AND tablename='${t}') AS ok`,
  ]),

  ...NEW_TABLES.map((t): [string, string] => [
    `${t} has row level security ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...NEW_TABLES.map((t): [string, string] => [
    `${t} has NO policies (anon/authenticated get zero rows)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...NEW_TABLES.map((t): [string, string] => [
    `${t} carries its table comment`,
    `SELECT COALESCE(length(obj_description(to_regclass('public.${t}'), 'pg_class')) > 0, false) AS ok`,
  ]),

  [
    'session_no is its OWN identity series, not shared with the ticket table',
    `SELECT COALESCE((SELECT is_identity = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_sessions'
         AND column_name='session_no'), false) AS ok`,
  ],

  // The route writes these from authz.effectiveEmail; neither is optional, and
  // queued_at and last_seen_at are states the queue is read from, never absent.
  ...['work_email', 'filed_by_email', 'status', 'queued_at', 'last_seen_at', 'created_at', 'updated_at'].map(
    (col): [string, string] => [
      `sessions.${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_support_chat_sessions'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  // These are real states, not missing values: unclaimed, still running, never
  // became a ticket.
  ...['claimed_by', 'claimed_at', 'ended_at', 'became_ticket_id', 'became_ticket_at', 'member_name', 'department'].map(
    (col): [string, string] => [
      `sessions.${col} is NULLABLE (it is a real state, not a missing value)`,
      `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='employee_support_chat_sessions'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  [
    'sessions.status defaults to waiting (entering the line is the only way in)',
    `SELECT COALESCE((SELECT column_default LIKE '%waiting%' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_sessions'
         AND column_name='status'), false) AS ok`,
  ],
  [
    'sessions has NO position column — a stored position is wrong the moment somebody leaves the line',
    `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_sessions'
         AND column_name IN ('position', 'queue_position')) AS ok`,
  ],

  [
    'messages.author_email is NULLABLE (a system line has no author to name)',
    `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_messages'
         AND column_name='author_email'), false) AS ok`,
  ],
  ...['session_id', 'author_side', 'body', 'created_at'].map((col): [string, string] => [
    `messages.${col} is NOT NULL`,
    `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_messages'
         AND column_name='${col}'), false) AS ok`,
  ]),
  [
    'messages are immutable — there is no updated_at to change',
    `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_messages'
         AND column_name='updated_at') AS ok`,
  ],
  [
    'messages cascade when their session is deleted',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('${MESSAGES}')
         AND contype = 'f' AND confdeltype = 'c') AS ok`,
  ],
  [
    'became_ticket_id is ON DELETE RESTRICT — the ticket a chat became cannot be deleted out from under it',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('${SESSIONS}')
         AND contype = 'f' AND confrelid = to_regclass('${TICKETS}')
         AND confdeltype = 'r') AS ok`,
  ],

  ...['on_queue', 'updated_at'].map((col): [string, string] => [
    `agents.${col} is NOT NULL`,
    `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_agents'
         AND column_name='${col}'), false) AS ok`,
  ]),
  [
    'agents.on_queue defaults to false — availability is declared, never assumed',
    `SELECT COALESCE((SELECT column_default LIKE '%false%' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employee_support_chat_agents'
         AND column_name='on_queue'), false) AS ok`,
  ],

  [
    'the "one open session per employee" index is UNIQUE, PARTIAL and on LOWER(work_email)',
    `SELECT COALESCE((SELECT indexdef LIKE 'CREATE UNIQUE INDEX%'
         AND indexdef LIKE '%lower(work_email)%'
         AND indexdef LIKE '%WHERE%' FROM pg_indexes
       WHERE schemaname='public' AND indexname='employee_support_chat_sessions_one_open_per_employee'), false) AS ok`,
  ],
  [
    'the "mine" index is on LOWER(work_email) — not the raw column',
    `SELECT COALESCE((SELECT indexdef LIKE '%lower(work_email)%' FROM pg_indexes
       WHERE schemaname='public' AND indexname='employee_support_chat_sessions_mine_idx'), false) AS ok`,
  ],
  [
    'the queue index is partial on status = waiting',
    `SELECT COALESCE((SELECT indexdef LIKE '%WHERE%waiting%' FROM pg_indexes
       WHERE schemaname='public' AND indexname='employee_support_chat_sessions_queue_idx'), false) AS ok`,
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
  ...TRIGGERS.map(([name, table]): [string, string] => [
    `trigger ${name} exists`,
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${table}') AND tgname = '${name}') AS ok`,
  ]),

  // ---- The widens. These two lines are the reason this script exists. ----
  [
    `employee_roles_role_check still allows ALL ${EXPECTED_ROLES.length} roles (nothing was dropped by the restatement)`,
    constraintCoverage('employee_roles_role_check', EXPECTED_ROLES),
  ],
  [
    `employee_notifications_type_check still allows ALL ${EXPECTED_NOTIFICATION_TYPES.length} types (nothing was dropped by the restatement)`,
    constraintCoverage('employee_notifications_type_check', EXPECTED_NOTIFICATION_TYPES),
  ],
];

// ===========================================================================
// Controls
// ===========================================================================
// Fixed uuids so a control can insert a parent and a child as a `;`-separated
// SEQUENCE of statements. NOT a data-modifying CTE chain: Postgres runs every
// CTE of one statement against the same snapshot, so a parent deleted in the
// same statement that inserted its child is not caught by the FK and the
// control passes for the wrong reason (it did, in apply-fpu-classes' first run).
const CTL_TICKET_ID = "'00000000-0000-4000-8000-0000000000e1'";
const CTL_SESSION_ID = "'00000000-0000-4000-8000-0000000000e2'";

/** Deliberately not a plausible person: these run against production in --apply. */
const CTL_EMAIL = "'migration.control@simple.biz'";
const CTL_AGENT = "'migration.agent@simple.biz'";

const LEGAL_SESSION: Record<string, string> = {
  work_email: CTL_EMAIL,
  filed_by_email: CTL_EMAIL,
};

function insertRow(table: string, row: Record<string, string>, returning = ''): string {
  const cols = Object.keys(row);
  return `INSERT INTO ${table} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})${returning ? ` RETURNING ${returning}` : ''}`;
}

function insertSession(overrides: Record<string, string> = {}, returning = ''): string {
  return insertRow(SESSIONS, { ...LEGAL_SESSION, ...overrides }, returning);
}

/** A session in each status, with the companions that status requires. */
const STATUS_COMPANIONS: Record<string, Record<string, string>> = {
  waiting: {},
  claimed: { claimed_by: "'carla@simple.biz'", claimed_at: 'now()' },
  live: { claimed_by: "'carla@simple.biz'", claimed_at: 'now()' },
  ended: { ended_at: 'now()' },
  abandoned: { ended_at: 'now()' },
};

const insertCtlTicket = insertRow(TICKETS, {
  id: CTL_TICKET_ID,
  work_email: CTL_EMAIL,
  filed_by_email: CTL_EMAIL,
  category: "'pay_payslip'",
  concern: "'Migration control row.'",
});

function insertMessage(overrides: Record<string, string> = {}): string {
  return insertRow(MESSAGES, {
    session_id: CTL_SESSION_ID,
    author_side: "'employee'",
    author_email: CTL_EMAIL,
    body: "'Is my payslip late?'",
    ...overrides,
  });
}

/** A message control needs a session, so each one is a `;` sequence. */
function withSession(sql: string, sessionOverrides: Record<string, string> = {}): string {
  return `${insertSession({ id: CTL_SESSION_ID, ...sessionOverrides })}; ${sql}`;
}

function insertAgent(overrides: Record<string, string> = {}): string {
  return insertRow(AGENTS, { agent_email: CTL_AGENT, ...overrides });
}

const ON_QUEUE = { on_queue: 'true', on_queue_since: 'now()', last_heartbeat_at: 'now()' };

/**
 * POSITIVE CONTROL — without it every "rejected" below could be passing for an
 * unrelated reason, and a suite that cannot accept a good row is
 * indistinguishable from one where the constraints all work.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal waiting session is ACCEPTED (proves the suite can pass)',
  insertSession(),
];

const ACCEPT_CONTROLS: Array<[string, string]> = [
  [
    'a session filed from an ALTERNATE address is ACCEPTED (work_email != filed_by_email)',
    insertSession({ filed_by_email: "'control.personal@gmail.com'" }),
  ],
  ...SESSION_STATUSES.map((s): [string, string] => [
    `status '${s}' with its required companions is ACCEPTED`,
    insertSession({ status: `'${s}'`, ...STATUS_COMPANIONS[s] }),
  ]),
  [
    'an abandoned session that BECAME a ticket is ACCEPTED (Q1, the whole point)',
    `${insertCtlTicket}; ${insertSession({
      status: "'abandoned'",
      ended_at: 'now()',
      became_ticket_id: CTL_TICKET_ID,
      became_ticket_at: 'now()',
    })}`,
  ],
  [
    'a SECOND session is ACCEPTED once the first has ended (the uniqueness is partial)',
    `${insertSession({ status: "'ended'", ended_at: 'now()' })}; ${insertSession()}`,
  ],
  [
    'RELEASING a claim returns the session to waiting with BOTH claim columns cleared',
    `${insertSession({ id: CTL_SESSION_ID, status: "'claimed'", ...STATUS_COMPANIONS.claimed })};
     UPDATE ${SESSIONS} SET status='waiting', claimed_by=NULL, claimed_at=NULL WHERE id = ${CTL_SESSION_ID}`,
  ],
  ...AUTHOR_SIDES.map((side): [string, string] => [
    `a '${side}' message is ACCEPTED`,
    withSession(insertMessage(side === 'system' ? { author_side: `'${side}'`, author_email: 'NULL' } : { author_side: `'${side}'` })),
  ]),
  [
    'a FLAGGED message is still ACCEPTED — screening records, it never blocks',
    withSession(insertMessage({ flagged_at: 'now()', flag_reason: "'Contains strong language.'" })),
  ],
  [
    'deleting a session CASCADES its messages',
    `${withSession(insertMessage())}; DELETE FROM ${SESSIONS} WHERE id = ${CTL_SESSION_ID}`,
  ],
  ['an agent OFF the queue (both stamps null) is ACCEPTED', insertAgent()],
  ['an agent ON the queue with both stamps is ACCEPTED', insertAgent(ON_QUEUE)],
  [
    "the new 'employee_support' role is ACCEPTED (the widen worked)",
    insertRow('public.employee_roles', {
      work_email: CTL_EMAIL,
      role: "'employee_support'",
      assigned_by: "'chat-migration-control'",
    }),
  ],
  // Every role the constraint must STILL allow, one INSERT each. The coverage
  // check above reads the definition text; these prove the database agrees.
  ...EXPECTED_ROLES.map((r): [string, string] => [
    `role '${r}' is still ACCEPTED`,
    insertRow('public.employee_roles', {
      work_email: CTL_EMAIL,
      role: `'${r}'`,
      assigned_by: "'chat-migration-control'",
    }),
  ]),
  ...['support_chat.replied', 'support_chat.became_ticket'].map((t): [string, string] => [
    `notification type '${t}' is ACCEPTED (the widen worked)`,
    insertRow('public.employee_notifications', {
      recipient_email: CTL_EMAIL,
      type: `'${t}'`,
      title: "'Control'",
      message: "'Control'",
    }),
  ]),
  // A representative slice of the list that must NOT have been dropped. The
  // definition-text coverage check above carries all 46; these four are the
  // ones whose loss would be felt first and loudest.
  ...['rate.change', 'payroll.paid', 'ticket.replied', 'kpi.published'].map((t): [string, string] => [
    `pre-existing notification type '${t}' is still ACCEPTED`,
    insertRow('public.employee_notifications', {
      recipient_email: CTL_EMAIL,
      type: `'${t}'`,
      title: "'Control'",
      message: "'Control'",
    }),
  ]),
];

const TRIGGER_CONTROLS: Array<[string, string]> = [
  [
    'the trigger lower-cases and trims the work email',
    insertSession({ work_email: "'  Migration.Control@Simple.Biz  '" }, `(work_email = ${CTL_EMAIL}) AS ok`),
  ],
  [
    'the trigger lower-cases the claimant',
    insertSession(
      { status: "'claimed'", claimed_by: "'  Carla@Simple.BIZ '", claimed_at: 'now()' },
      "(claimed_by = 'carla@simple.biz') AS ok",
    ),
  ],
  [
    'a blank department is stored as NULL, not as an empty string',
    insertSession({ department: "'   '" }, '(department IS NULL) AS ok'),
  ],
  [
    'the message trigger lower-cases the author',
    `${insertSession({ id: CTL_SESSION_ID })};
     ${insertRow(MESSAGES, {
       session_id: CTL_SESSION_ID,
       author_side: "'agent'",
       author_email: "'  Carla@Simple.BIZ '",
       body: "'Looking into it.'",
     })} RETURNING (author_email = 'carla@simple.biz') AS ok`,
  ],
  [
    'the agent trigger lower-cases the agent email',
    `${insertRow(AGENTS, { agent_email: "'  Carla@Simple.BIZ '" })} RETURNING (agent_email = 'carla@simple.biz') AS ok`,
  ],
  [
    'queued_at survives a release UNCHANGED — a position never rises',
    `${insertSession({ id: CTL_SESSION_ID, status: "'claimed'", ...STATUS_COMPANIONS.claimed, queued_at: "timestamptz '2026-01-01 00:00:00+00'" })};
     UPDATE ${SESSIONS} SET status='waiting', claimed_by=NULL, claimed_at=NULL WHERE id = ${CTL_SESSION_ID}
     RETURNING (queued_at = timestamptz '2026-01-01 00:00:00+00') AS ok`,
  ],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['an unknown session status is rejected', insertSession({ status: "'paused'" })],
  ['a blank work email is rejected', insertSession({ work_email: "'   '" })],
  ['a blank filed_by email is rejected', insertSession({ filed_by_email: "'   '" })],
  [
    'status=claimed with nobody holding it is rejected',
    insertSession({ status: "'claimed'" }),
  ],
  ['status=live with nobody holding it is rejected', insertSession({ status: "'live'" })],
  ['claimed_at without a claimant is rejected', insertSession({ claimed_at: 'now()' })],
  ['a claimant without claimed_at is rejected', insertSession({ claimed_by: "'carla@simple.biz'" })],
  [
    'a WAITING session that still names a claimant is rejected (the release must clear both)',
    insertSession({ status: "'waiting'", claimed_by: "'carla@simple.biz'", claimed_at: 'now()' }),
  ],
  ['status=ended with no ended_at is rejected', insertSession({ status: "'ended'" })],
  ['status=abandoned with no ended_at is rejected', insertSession({ status: "'abandoned'" })],
  [
    'became_ticket_id with no became_ticket_at is rejected',
    `${insertCtlTicket}; ${insertSession({ status: "'abandoned'", ended_at: 'now()', became_ticket_id: CTL_TICKET_ID })}`,
  ],
  [
    'became_ticket_at with no ticket is rejected',
    insertSession({ status: "'abandoned'", ended_at: 'now()', became_ticket_at: 'now()' }),
  ],
  [
    'an ENDED (answered) session cannot become a ticket — only an abandoned one does',
    `${insertCtlTicket}; ${insertSession({
      status: "'ended'",
      ended_at: 'now()',
      became_ticket_id: CTL_TICKET_ID,
      became_ticket_at: 'now()',
    })}`,
  ],
  [
    'a became_ticket_id pointing at no ticket is rejected',
    insertSession({
      status: "'abandoned'",
      ended_at: 'now()',
      became_ticket_id: 'gen_random_uuid()',
      became_ticket_at: 'now()',
    }),
  ],
  [
    'deleting the ticket a chat BECAME is rejected (on delete restrict)',
    `${insertCtlTicket}; ${insertSession({
      status: "'abandoned'",
      ended_at: 'now()',
      became_ticket_id: CTL_TICKET_ID,
      became_ticket_at: 'now()',
    })}; DELETE FROM ${TICKETS} WHERE id = ${CTL_TICKET_ID}`,
  ],
  [
    'a SECOND open session for the same employee is rejected CASE-INSENSITIVELY',
    `${insertSession()}; ${insertSession({ work_email: "'MIGRATION.CONTROL@simple.biz'" })}`,
  ],
  [
    'moving queued_at is rejected — a position never rises',
    `${insertSession({ id: CTL_SESSION_ID })};
     UPDATE ${SESSIONS} SET queued_at = now() + interval '1 hour' WHERE id = ${CTL_SESSION_ID}`,
  ],
  ['an unknown author side is rejected', withSession(insertMessage({ author_side: "'manager'" }))],
  [
    'an employee message with NO author email is rejected',
    withSession(insertMessage({ author_email: 'NULL' })),
  ],
  [
    'an employee message with a BLANK author email is rejected',
    withSession(insertMessage({ author_email: "'   '" })),
  ],
  [
    'a SYSTEM message that names an author is rejected — nobody said it',
    withSession(insertMessage({ author_side: "'system'" })),
  ],
  ['an empty message body is rejected', withSession(insertMessage({ body: "'   '" }))],
  [
    'a message over 4000 chars is rejected',
    withSession(insertMessage({ body: "repeat('x', 4001)" })),
  ],
  [
    'a flag with no reason is rejected (a flag is an assertion)',
    withSession(insertMessage({ flagged_at: 'now()' })),
  ],
  [
    'a reason with no flag timestamp is rejected',
    withSession(insertMessage({ flag_reason: "'Contains strong language.'" })),
  ],
  [
    'a message against a session that does not exist is rejected',
    insertRow(MESSAGES, {
      session_id: 'gen_random_uuid()',
      author_side: "'agent'",
      author_email: "'carla@simple.biz'",
      body: "'x'",
    }),
  ],
  [
    'an agent ON the queue with no heartbeat is rejected',
    insertAgent({ on_queue: 'true', on_queue_since: 'now()' }),
  ],
  [
    'an agent ON the queue with no since-stamp is rejected',
    insertAgent({ on_queue: 'true', last_heartbeat_at: 'now()' }),
  ],
  [
    'an agent OFF the queue still carrying a since-stamp is rejected',
    insertAgent({ on_queue: 'false', on_queue_since: 'now()' }),
  ],
  ['a blank agent email is rejected', insertAgent({ agent_email: "'   '" })],
  [
    'an unknown role is still rejected (the widen did not open the door)',
    insertRow('public.employee_roles', {
      work_email: CTL_EMAIL,
      role: "'employee_supportt'",
      assigned_by: "'chat-migration-control'",
    }),
  ],
  [
    'an unknown notification type is still rejected',
    insertRow('public.employee_notifications', {
      recipient_email: CTL_EMAIL,
      type: "'support_chat.nope'",
      title: "'Control'",
      message: "'Control'",
    }),
  ],
];

const client = new Client({ connectionString });

// The two widen files report drift through RAISE NOTICE — a value the live
// constraint had that the file did not expect, or one the file expected that the
// live constraint lacked. Swallowed, those lines are the single most useful
// output of this whole run.
client.on('notice', (n) => {
  const text = (n.message ?? '').trim();
  if (text) console.log(`  NOTICE  ${text}`);
});

async function runControl(
  label: string,
  sql: string,
  expect: 'accept' | 'reject' | 'true',
): Promise<boolean> {
  await client.query('SAVEPOINT ctl');
  let threw = '';
  let returned: unknown = null;
  try {
    // A `;`-separated control is a simple query and pg hands back ONE RESULT PER
    // STATEMENT, as an array. The `ok` we asserted on is the last statement's.
    const res: unknown = await client.query(sql);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    returned = (last as { rows?: Array<Record<string, unknown>> } | undefined)?.rows?.[0]?.ok ?? null;
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
        : expect === 'true' && returned !== true
          ? ` — returned ${JSON.stringify(returned)}, expected true`
          : '';
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  return ok;
}

async function applyAll(): Promise<void> {
  for (const f of SQL_FILES) {
    console.log(`  ${f.rel}`);
    await client.query(readFileSync(f.abs, 'utf8'));
  }
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Employee Support live chat`,
      '',
      `  SQL files: ${SQL_FILES.length}`,
      ...SQL_FILES.map((f) => `    - ${f.rel}`),
      `  Tables   : ${NEW_TABLES.join(', ')}`,
      `  Widens   : employee_roles_role_check (+employee_support), employee_notifications_type_check (+2 chat types)`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : ${1 + ACCEPT_CONTROLS.length} positive, ${TRIGGER_CONTROLS.length} trigger, ${NEGATIVE_CONTROLS.length} negative`,
      '',
      '  THE TWO WIDEN FILES RESTATE LISTS THAT WERE RECONSTRUCTED FROM THE REPO,',
      '  not measured from this database. They can only ever WIDEN — each one reads',
      '  the live constraint and unions onto it — but re-read both live definitions',
      '  before --apply anyway:',
      "    select pg_get_constraintdef(oid) from pg_constraint where conname in",
      "      ('employee_roles_role_check','employee_notifications_type_check');",
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

  // The chat sessions table has a foreign key into the ticket table. Fail here,
  // with the launcher's name, rather than 300 lines into a CREATE.
  const { rows: pre } = await client.query(`SELECT to_regclass('${TICKETS}') IS NOT NULL AS ok`);
  if (pre[0]?.ok !== true) {
    console.error(
      [
        `\n${TICKETS} does not exist.`,
        '',
        'The live chat tables have a foreign key into it (became_ticket_id), so the',
        'ticket migration has to run first:',
        '',
        '  scripts/Apply Employee Support migration.cmd',
        '',
        'Then run this one again.',
      ].join('\n'),
    );
    await client.end();
    process.exit(1);
  }

  let failed = 0;

  if (verifyOnly) {
    console.log('Verify only — not applying.\n');
  } else {
    console.log(
      dryRun
        ? 'Applying all files inside ONE transaction, then rolling back:'
        : 'Applying all files inside ONE transaction:',
    );
    await client.query('BEGIN');
    await applyAll();
    if (dryRun) {
      console.log('  applied (rollback pending).\n');
    } else {
      await client.query('COMMIT');
      console.log('  committed.\n');
    }
  }

  console.log('Verifying objects:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    const detail = rows[0]?.detail ? ` — missing: ${rows[0].detail}` : '';
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}${detail}`);
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

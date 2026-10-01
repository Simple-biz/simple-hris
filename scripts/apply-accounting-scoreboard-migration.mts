/**
 * [Accounting Scoreboard]
 * Applies references/sql/create/2026-10-01_accounting_scoreboard.sql — the five
 * `accounting_scoreboard_*` tables and the collections log's append-only trigger — then verifies
 * that every object landed, that nobody but the service role can read or write them, AND that
 * each guard actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The SQL runs inside a transaction that is always rolled
 * back, because Postgres DDL is transactional. That proves the migration parses, the tables
 * build and the guards bite, while production stays exactly as it was. --apply commits only when
 * every check passed. Re-running --apply is safe: CREATE … IF NOT EXISTS, CREATE OR REPLACE
 * FUNCTION, DROP/CREATE TRIGGER, ENABLE ROW LEVEL SECURITY and REVOKE are no-ops for whatever
 * already exists, and no row is touched.
 *
 * Every control runs inside a SAVEPOINT that is rolled back, on labels starting `__control__`,
 * so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * Percent-encode an `@` in the password as %40.
 *
 * Safe to run BEFORE or AFTER deploying the code. Until the tables exist, the board answers
 * "not set up yet" and nothing else reads them.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-01_accounting_scoreboard.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLES = [
  'accounting_scoreboard_rows',
  'accounting_scoreboard_entries',
  'accounting_scoreboard_collections',
  'accounting_scoreboard_members',
  'accounting_scoreboard_sections',
] as const;
const TRIGGER_FN = 'public.accounting_scoreboard_collections_guard_update()';
const CONSTRAINTS = [
  'acct_sb_rows_section_valid',
  'acct_sb_rows_label_valid',
  'acct_sb_rows_email_valid',
  'acct_sb_rows_archive_pair',
  'acct_sb_rows_id_section',
  'acct_sb_entries_pk',
  'acct_sb_entries_slot_valid',
  'acct_sb_entries_value_range',
  'acct_sb_entries_minutes_range',
  'acct_sb_entries_flag_binary',
  'acct_sb_coll_section_is_collections',
  'acct_sb_coll_rep_fk',
  'acct_sb_coll_points_range',
  'acct_sb_coll_delete_pair',
  'acct_sb_members_email_valid',
  'acct_sb_sections_key_valid',
];
const INDEXES = ['acct_sb_rows_one_live_label', 'acct_sb_rows_one_live_person', 'acct_sb_entries_by_date', 'acct_sb_coll_live_by_date'];

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

const CHECKS: Array<[string, string]> = [
  ...TABLES.map((t): [string, string] => [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`]),
  ['the append-only trigger function exists', `SELECT to_regprocedure('${TRIGGER_FN}') IS NOT NULL AS ok`],
  [
    'the collections table comment records that it is APPEND-ONLY',
    `SELECT COALESCE((SELECT obj_description(to_regclass('public.accounting_scoreboard_collections'), 'pg_class')
        LIKE '%APPEND-ONLY%'), false) AS ok`,
  ],
  ...TABLES.map((t): [string, string] => [
    `${t}: row level security is ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...TABLES.map((t): [string, string] => [
    `${t}: ZERO policies (service role only)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...TABLES.flatMap((t) =>
    (['anon', 'authenticated'] as const).flatMap((role) =>
      (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
        `${t}: ${role} has NO ${priv} privilege`,
        `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
      ]),
    ),
  ),
  ...TABLES.flatMap((t) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${t}: service_role HAS ${priv} (the routes need it)`,
      `SELECT has_table_privilege('service_role', 'public.${t}', '${priv}') AS ok`,
    ]),
  ),
  ...(['anon', 'authenticated'] as const).map((role): [string, string] => [
    `the trigger function: ${role} CANNOT execute it`,
    `SELECT NOT has_function_privilege('${role}', '${TRIGGER_FN}', 'EXECUTE') AS ok`,
  ]),
  [
    'the trigger function pins search_path',
    `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc
       WHERE oid = to_regprocedure('${TRIGGER_FN}')), false) AS ok`,
  ],
  [
    'no scoreboard table is in supabase_realtime',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename IN (${TABLES.map((t) => `'${t}'`).join(', ')})) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT to_regclass('public.${name}') IS NOT NULL AS ok`,
  ]),
  [
    'trigger acct_sb_coll_guard_update on accounting_scoreboard_collections',
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgname = 'acct_sb_coll_guard_update'
         AND tgrelid = to_regclass('public.accounting_scoreboard_collections') AND NOT tgisinternal) AS ok`,
  ],
];

const BY = "'acct-sb-control@simple.biz'";

const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function inSavepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    return await fn();
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

/** Runs `sql` in its OWN savepoint and reports whether Postgres refused it. */
async function rejects(sql: string | string[]): Promise<{ rejected: boolean; message: string }> {
  await client.query('SAVEPOINT rj');
  let result: { rejected: boolean; message: string };
  try {
    for (const s of Array.isArray(sql) ? sql : [sql]) await client.query(s);
    result = { rejected: false, message: '' };
  } catch (e) {
    result = { rejected: true, message: (e as Error).message };
  }
  await client.query('ROLLBACK TO SAVEPOINT rj');
  await client.query('RELEASE SAVEPOINT rj');
  return result;
}

function insertRow(section: string, label: string, email: string | null = null): string {
  return `INSERT INTO public.accounting_scoreboard_rows (section_key, label, work_email, created_by)
          VALUES ('${section}', '${label}', ${email === null ? 'NULL' : `'${email}'`}, ${BY}) RETURNING id`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard tables`,
      '',
      `  SQL    : ${SQL_PATH}`,
      `  Tables : ${TABLES.join(', ')}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check below passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects and privileges:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query<{ ok: boolean }>(sql);
    report(Boolean(rows[0]?.ok), label);
  }

  console.log('\nPositive control (rolled back):');
  await inSavepoint('pc', async () => {
    try {
      const rep = (await client.query<{ id: string }>(insertRow('collections', '__control__ Rep'))).rows[0].id;
      const bucket = (await client.query<{ id: string }>(insertRow('buckets', '__control__ Bucket'))).rows[0].id;
      await client.query(
        `INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by)
         VALUES ('${bucket}', '2000-01-03', 'am', 12, ${BY}), ('${bucket}', '2000-01-03', 'pm', 0, ${BY})`,
      );
      const coll = (
        await client.query<{ id: string }>(
          `INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, amount_usd, created_by)
           VALUES ('2000-01-03', '${rep}', '__control__ Business', 12, 89.30, ${BY}) RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `UPDATE public.accounting_scoreboard_collections SET deleted_at = now(), deleted_by = ${BY} WHERE id = '${coll}'`,
      );
      await client.query(
        `INSERT INTO public.accounting_scoreboard_members (work_email, added_by) VALUES ('__control__@simple.biz', ${BY})`,
      );
      await client.query(
        `INSERT INTO public.accounting_scoreboard_sections (section_key, enabled, goal, updated_by) VALUES ('inbox', false, 9, ${BY})
         ON CONFLICT (section_key) DO UPDATE SET enabled = excluded.enabled`,
      );
      report(true, 'a row, two entries, a collection, its soft delete, a member and a section switch all write');
    } catch (e) {
      report(false, 'the legal writes were accepted', (e as Error).message);
    }
  });

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const withRows = (stmts: (rep: string, bucket: string) => string[]): string[] => [
    `CREATE TEMP TABLE IF NOT EXISTS acct_sb_ctl (rep uuid, bucket uuid) ON COMMIT DROP`,
    `DELETE FROM acct_sb_ctl`,
    `WITH r AS (${insertRow('collections', '__control__ Rep')}), b AS (${insertRow('buckets', '__control__ Bucket')})
     INSERT INTO acct_sb_ctl SELECT r.id, b.id FROM r, b`,
    ...stmts('(SELECT rep FROM acct_sb_ctl)', '(SELECT bucket FROM acct_sb_ctl)'),
  ];
  const NEGATIVE: Array<[string, string | string[], string?]> = [
    ['a row in an unknown section is refused', insertRow('payroll', '__control__ X'), 'acct_sb_rows_section_valid'],
    ['a label with surrounding spaces is refused', insertRow('buckets', ' __control__ X'), 'acct_sb_rows_label_valid'],
    ['an upper-case work email is refused', insertRow('inbox', '__control__ X', 'Someone@Simple.biz'), 'acct_sb_rows_email_valid'],
    ['two live rows with one label in a section are refused', [insertRow('buckets', '__control__ Same'), insertRow('buckets', '__control__ same')], 'acct_sb_rows_one_live_label'],
    ['two live rows for one person in a section are refused', [insertRow('inbox', '__control__ A', 'p@simple.biz'), insertRow('inbox', '__control__ B', 'p@simple.biz')], 'acct_sb_rows_one_live_person'],
    ['an archived stamp without who archived it is refused', `INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by, archived_at) VALUES ('buckets', '__control__ X', ${BY}, now())`, 'acct_sb_rows_archive_pair'],
    [
      'an unknown entry slot is refused',
      withRows((_rep, b) => [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'noon', 1, ${BY})`]),
      'acct_sb_entries_slot_valid',
    ],
    [
      'a negative count is refused',
      withRows((_rep, b) => [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'am', -1, ${BY})`]),
      'acct_sb_entries_value_range',
    ],
    [
      'a start time past midnight (1441 min) is refused',
      withRows((_rep, b) => [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'start', 1441, ${BY})`]),
      'acct_sb_entries_minutes_range',
    ],
    [
      'a meeting flag of 2 is refused',
      withRows((_rep, b) => [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'mtg', 2, ${BY})`]),
      'acct_sb_entries_flag_binary',
    ],
    [
      'two values for one cell are refused',
      withRows((_rep, b) => [
        `INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'am', 1, ${BY})`,
        `INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${b}, '2000-01-03', 'am', 2, ${BY})`,
      ]),
      'acct_sb_entries_pk',
    ],
    [
      'a collection logged against a NON-collections row is refused',
      withRows((_rep, b) => [`INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES ('2000-01-03', ${b}, '__control__ Biz', 1, ${BY})`]),
      'acct_sb_coll_rep_fk',
    ],
    [
      'negative points are refused',
      withRows((rep) => [`INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES ('2000-01-03', ${rep}, '__control__ Biz', -1, ${BY})`]),
      'acct_sb_coll_points_range',
    ],
    [
      'EDITING a logged collection (its points) is refused',
      withRows((rep) => [
        `INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES ('2000-01-03', ${rep}, '__control__ Biz', 1, ${BY})`,
        `UPDATE public.accounting_scoreboard_collections SET points = 12 WHERE business_name = '__control__ Biz'`,
      ]),
      'acct_sb_coll_append_only',
    ],
    [
      'UN-deleting a deleted collection is refused',
      withRows((rep) => [
        `INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES ('2000-01-03', ${rep}, '__control__ Biz', 1, ${BY})`,
        `UPDATE public.accounting_scoreboard_collections SET deleted_at = now(), deleted_by = ${BY} WHERE business_name = '__control__ Biz'`,
        `UPDATE public.accounting_scoreboard_collections SET deleted_at = NULL, deleted_by = NULL WHERE business_name = '__control__ Biz'`,
      ]),
      'acct_sb_coll_deleted_is_final',
    ],
    [
      'a soft delete without who deleted it is refused',
      withRows((rep) => [
        `INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES ('2000-01-03', ${rep}, '__control__ Biz', 1, ${BY})`,
        `UPDATE public.accounting_scoreboard_collections SET deleted_at = now() WHERE business_name = '__control__ Biz'`,
      ]),
      'acct_sb_coll_delete_pair',
    ],
    ['a member email that is not lower-case is refused', `INSERT INTO public.accounting_scoreboard_members (work_email, added_by) VALUES ('X@simple.biz', ${BY})`, 'acct_sb_members_email_valid'],
    ['a switch for an unknown section is refused', `INSERT INTO public.accounting_scoreboard_sections (section_key, updated_by) VALUES ('payroll', ${BY})`, 'acct_sb_sections_key_valid'],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await inSavepoint('nc', () => rejects(sql));
    const ok = r.rejected && (!expect || r.message.includes(expect));
    report(ok, label, r.rejected ? (ok ? '' : `refused for another reason: ${r.message}`) : 'it was ACCEPTED');
  }

  if (!dryRun && !verifyOnly && failed === 0) {
    await client.query('COMMIT');
  } else {
    await client.query('ROLLBACK');
    if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
    if (!dryRun && !verifyOnly && failed) console.log('\nRolled back because a check failed — nothing was committed.');
  }
  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the Accounting Scoreboard tables are live.');
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

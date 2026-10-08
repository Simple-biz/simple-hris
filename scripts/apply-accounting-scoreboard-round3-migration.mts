/**
 * [Accounting Scoreboard round 3]
 * Applies references/sql/create/2026-10-06_accounting_scoreboard_round3.sql — Carla's 2026-10-02
 * "SCOREBOARD UPDATES": custom sections, the bucket_day / due_soon / custom_section_id row columns,
 * the Chargeback Outcomes section and its usd/count slots, Payment Verified, and the Payroll
 * Problems log with its types — then verifies every object, the lock-down, and that each guard
 * rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-round3-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-round3-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-round3-migration.mts --apply   # backup, then COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-round3-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. --apply
 * first writes every row its data steps UPDATE to docs/audits/backups/ (CLAUDE.md: a bulk UPDATE
 * needs a SELECT backup on disk first), then commits only when every check passed. Re-running
 * --apply is safe: every DDL is IF NOT EXISTS / DROP … IF EXISTS + ADD, and every data step is
 * guarded. Every control runs inside a SAVEPOINT that is rolled back, on labels starting
 * `__control__`, so the controls write no rows even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply AFTER the 2026-10-01 migrations. Deploy the code only after this is applied: the board
 * reads the new tables and columns and answers "not set up yet" until they exist.
 * Governing doc: docs/features/accounting-scoreboard.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-06_accounting_scoreboard_round3.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const NEW_TABLES = [
  'accounting_scoreboard_custom_sections',
  'accounting_scoreboard_collection_verifications',
  'accounting_scoreboard_problem_types',
  'accounting_scoreboard_problems',
] as const;
const TRIGGER_FNS = [
  'public.accounting_scoreboard_verifications_guard_update()',
  'public.accounting_scoreboard_problems_guard_update()',
];
const TRIGGERS: Array<[string, string]> = [
  ['acct_sb_verif_guard_update', 'accounting_scoreboard_collection_verifications'],
  ['acct_sb_prob_guard_update', 'accounting_scoreboard_problems'],
  // The collections log's own guard must still be there (Payment Verified never touches it).
  ['acct_sb_coll_guard_update', 'accounting_scoreboard_collections'],
];
const CONSTRAINTS = [
  'acct_sb_custom_title_valid',
  'acct_sb_custom_kind_valid',
  'acct_sb_custom_goal_range',
  'acct_sb_custom_goal_direction_valid',
  'acct_sb_custom_goal_pair',
  'acct_sb_custom_score_goal_at_least',
  'acct_sb_custom_score_goal_max',
  'acct_sb_custom_archive_pair',
  'acct_sb_rows_section_valid',
  'acct_sb_rows_custom_pair',
  'acct_sb_rows_bucket_day_valid',
  'acct_sb_rows_due_soon_valid',
  'acct_sb_sections_key_valid',
  'acct_sb_entries_slot_valid',
  'acct_sb_entries_count_whole',
  'acct_sb_verif_unverify_pair',
  'acct_sb_verif_name_valid',
  'acct_sb_ptype_label_valid',
  'acct_sb_ptype_archive_pair',
  'acct_sb_prob_section_is_problems',
  'acct_sb_prob_person_fk',
  'acct_sb_prob_count_range',
  'acct_sb_prob_delete_pair',
];
const INDEXES = [
  'acct_sb_custom_one_live_title',
  'acct_sb_rows_one_live_label',
  'acct_sb_rows_one_live_person',
  'acct_sb_verif_one_live',
  'acct_sb_ptype_one_live_label',
  'acct_sb_prob_live_by_date',
];
const BUCKET_LABELS = ['Mon (Collections)', 'Tues (Collections)', 'Wed (Collections)', 'Thurs (Collections)', 'Fri (Collections)'];
const MOVED_LABELS = ['Pre-arb', 'Wins', 'Losses'];
const DUE_SOON_LABEL = 'Disputes due in 7 days';

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
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: readonly string[]) => xs.map(q).join(', ');

/** What the seed left, true right after it runs: dry run and --apply only (the note at the end of CHECKS says why). */
const SEED_DATA_CHECKS: Array<[string, string]> = [
  [
    'every live weekday Collections bucket carries its day',
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE section_key = 'buckets'
       AND archived_at IS NULL AND label IN (${list(BUCKET_LABELS)}) AND bucket_day IS NULL) AS ok`,
  ],
  [
    'no other bucket was given a day',
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE bucket_day IS NOT NULL
       AND label NOT IN (${list(BUCKET_LABELS)})) AS ok`,
  ],
  [
    `the live "${DUE_SOON_LABEL}" line is flagged, and nothing else is`,
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE archived_at IS NULL AND section_key = 'chargebacks'
         AND ((label = ${q(DUE_SOON_LABEL)}) <> due_soon)) AS ok`,
  ],
  [
    'Chargeback Outcomes holds live Pre-arb, Wins and Losses rows',
    `SELECT (SELECT count(*) FROM public.accounting_scoreboard_rows WHERE section_key = 'chargeback_outcomes'
       AND archived_at IS NULL AND label IN (${list(MOVED_LABELS)})) = 3 AS ok`,
  ],
  [
    "Open Disputes no longer has live Pre-arb / Wins / Losses AM/PM rows (archived, not deleted)",
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE section_key = 'chargebacks'
       AND archived_at IS NULL AND label IN (${list(MOVED_LABELS)})) AS ok`,
  ],
  [
    "Carla's three starting problem types are live",
    `SELECT (SELECT count(*) FROM public.accounting_scoreboard_problem_types WHERE archived_at IS NULL
       AND label IN ('Account Error', 'Scoreboard Error', 'Other')) = 3 AS ok`,
  ],
];

/**
 * What stays true for good, checked by --verify: a type is archived, never deleted (accounting-scoreboard.md
 * § Payroll Problems), so the three seeded types still exist, live or archived.
 */
const VERIFY_DATA_CHECKS: Array<[string, string]> = [
  [
    "Carla's three starting problem types still exist, live or archived (a type is never deleted)",
    `SELECT (SELECT count(DISTINCT label) FROM public.accounting_scoreboard_problem_types
       WHERE label IN ('Account Error', 'Scoreboard Error', 'Other')) = 3 AS ok`,
  ],
];

const CHECKS: Array<[string, string]> = [
  ...NEW_TABLES.map((t): [string, string] => [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`]),
  ...(['custom_section_id', 'bucket_day', 'due_soon'] as const).map((c): [string, string] => [
    `accounting_scoreboard_rows.${c} exists`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
       AND table_name='accounting_scoreboard_rows' AND column_name='${c}') AS ok`,
  ]),
  ...NEW_TABLES.map((t): [string, string] => [
    `${t}: row level security is ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...NEW_TABLES.map((t): [string, string] => [
    `${t}: ZERO policies (service role only)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...NEW_TABLES.flatMap((t) =>
    (['anon', 'authenticated'] as const).flatMap((role) =>
      (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
        `${t}: ${role} has NO ${priv} privilege`,
        `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
      ]),
    ),
  ),
  ...NEW_TABLES.flatMap((t) =>
    (['SELECT', 'INSERT', 'UPDATE'] as const).map((priv): [string, string] => [
      `${t}: service_role HAS ${priv} (the routes need it)`,
      `SELECT has_table_privilege('service_role', 'public.${t}', '${priv}') AS ok`,
    ]),
  ),
  ...TRIGGER_FNS.flatMap((fn) => [
    [`${fn} exists`, `SELECT to_regprocedure('${fn}') IS NOT NULL AS ok`] as [string, string],
    [
      `${fn} pins search_path`,
      `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc WHERE oid = to_regprocedure('${fn}')), false) AS ok`,
    ] as [string, string],
    ...(['anon', 'authenticated'] as const).map((role): [string, string] => [
      `${fn}: ${role} CANNOT execute it`,
      `SELECT NOT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`,
    ]),
  ]),
  ...TRIGGERS.map(([tg, table]): [string, string] => [
    `trigger ${tg} on ${table}`,
    `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${tg}'
       AND tgrelid = to_regclass('public.${table}') AND NOT tgisinternal) AS ok`,
  ]),
  [
    'no new scoreboard table is in supabase_realtime',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public' AND tablename IN (${list(NEW_TABLES)})) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [`index ${name}`, `SELECT to_regclass('public.${name}') IS NOT NULL AS ok`]),
  // Data: what the migration's data step did. These hold when the seed runs (dry run and --apply), and only then:
  // managers change all of it on purpose afterwards (Setup → Rows sets a bucket's day and the "due in 7 days" flag,
  // renames and archives lines; Setup → Problem types archives types). Run under --verify, they failed on normal use
  // (Open item 399: Carla archived "Other" on 2026-10-07). --verify checks what stays true instead (VERIFY_DATA_CHECKS).
  ...(verifyOnly ? VERIFY_DATA_CHECKS : SEED_DATA_CHECKS),
];

const BY = "'acct-sb-control@simple.biz'";
const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Runs `sql` (fixtures + statements) inside a savepoint that is ALWAYS rolled back, in one round trip
 * plus one for the rollback. Reports whether Postgres refused it, and why.
 */
async function attempt(sql: string): Promise<{ rejected: boolean; message: string }> {
  let result: { rejected: boolean; message: string };
  try {
    await client.query(`SAVEPOINT ctl; ${sql}`);
    result = { rejected: false, message: '' };
  } catch (e) {
    result = { rejected: true, message: (e as Error).message };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl; RELEASE SAVEPOINT ctl;');
  return result;
}

/**
 * Control fixtures in a temp table, in ONE statement (one round trip: the pooler is ~240 ms away,
 * and the migration's ALTERs hold table locks until the transaction ends, so every round trip is
 * time the live board waits): a rep, a bucket, a problems person, two custom sections, a
 * collection and a problem type.
 */
const FIXTURES_SQL = `
  CREATE TEMP TABLE IF NOT EXISTS acct_sb_r3 (k text primary key, id uuid) ON COMMIT DROP;
  DELETE FROM acct_sb_r3;
  WITH rep AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('collections', '__control__ Rep', ${BY}) RETURNING id
  ), bucket AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('buckets', '__control__ Bucket', ${BY}) RETURNING id
  ), person AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('payroll_problems', '__control__ Person', ${BY}) RETURNING id
  ), custom AS (
    INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, created_by, updated_by) VALUES ('__control__ Section', 'daily', ${BY}, ${BY}) RETURNING id
  ), custom2 AS (
    INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, created_by, updated_by) VALUES ('__control__ Section 2', 'am_pm', ${BY}, ${BY}) RETURNING id
  ), coll AS (
    INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by)
    SELECT '2000-01-03', id, '__control__ Biz', 1, ${BY} FROM rep RETURNING id
  ), ptype AS (
    INSERT INTO public.accounting_scoreboard_problem_types (label, created_by) VALUES ('__control__ Type', ${BY}) RETURNING id
  )
  INSERT INTO acct_sb_r3 (k, id)
  SELECT 'rep', id FROM rep UNION ALL SELECT 'bucket', id FROM bucket UNION ALL SELECT 'person', id FROM person
  UNION ALL SELECT 'custom', id FROM custom UNION ALL SELECT 'custom2', id FROM custom2
  UNION ALL SELECT 'coll', id FROM coll UNION ALL SELECT 'ptype', id FROM ptype;`;
const id = (k: string) => `(SELECT id FROM acct_sb_r3 WHERE k = '${k}')`;
/** Keep the id an INSERT … RETURNING made, under `k`, without a round trip. */
const keep = (k: string, insert: string) => `WITH x AS (${insert} RETURNING id) INSERT INTO acct_sb_r3 (k, id) SELECT '${k}', id FROM x;`;

async function backupTouchedRows(): Promise<string> {
  const { rows } = await client.query(
    `SELECT * FROM public.accounting_scoreboard_rows
     WHERE archived_at IS NULL AND (
       (section_key = 'buckets' AND label IN (${list(BUCKET_LABELS)}))
       OR (section_key = 'chargebacks' AND label IN (${list([...MOVED_LABELS, DUE_SOON_LABEL])}))
     ) ORDER BY section_key, label`,
  );
  const dir = path.join(REPO_ROOT, 'docs', 'audits', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `accounting-scoreboard-round3-rows-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), sql: SQL_RELATIVE, rows }, null, 2));
  return `${path.relative(REPO_ROOT, file)} (${rows.length} rows)`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard round 3`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The rows the data steps change are backed up first; the SQL is COMMITTED when every check passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  if (!verifyOnly && !dryRun) console.log(`Backup: ${await backupTouchedRows()}\n`);
  await client.query('BEGIN');
  // Never queue the ALTERs behind a long-running board read (and never make the board queue behind
  // us for long): give up instead, and nothing is committed.
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects, privileges and data:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{
    rows: Array<{ ok: boolean }>;
  }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));

  console.log('\nPositive control (rolled back):');
  const positive = await attempt(`
    ${FIXTURES_SQL}
    ${keep('crow', `INSERT INTO public.accounting_scoreboard_rows (section_key, custom_section_id, label, created_by)
                     VALUES ('custom', ${id('custom')}, '__control__ Line', ${BY})`)}
    -- The same label in ANOTHER custom section is fine: uniqueness is per custom section.
    INSERT INTO public.accounting_scoreboard_rows (section_key, custom_section_id, label, created_by)
      VALUES ('custom', ${id('custom2')}, '__control__ Line', ${BY});
    INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by)
      VALUES (${id('crow')}, '2000-01-03', 'day', 4, ${BY});
    ${keep('outcome', `INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by)
                        VALUES ('chargeback_outcomes', '__control__ Wins', ${BY})`)}
    INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by)
      VALUES (${id('outcome')}, '2000-01-03', 'usd', 99.00, ${BY}), (${id('outcome')}, '2000-01-03', 'count', 1, ${BY});
    UPDATE public.accounting_scoreboard_rows SET bucket_day = 'wed' WHERE id = ${id('bucket')};
    ${keep('verif', `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name)
                      VALUES (${id('coll')}, ${BY}, 'Control')`)}
    UPDATE public.accounting_scoreboard_collection_verifications SET unverified_at = now(), unverified_by = ${BY} WHERE id = ${id('verif')};
    INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name)
      VALUES (${id('coll')}, ${BY}, 'Control');
    ${keep('prob', `INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, problem_count, created_by)
                     VALUES ('2000-01-03', ${id('person')}, ${id('ptype')}, 51, ${BY})`)}
    UPDATE public.accounting_scoreboard_problems SET deleted_at = now(), deleted_by = ${BY} WHERE id = ${id('prob')};
    UPDATE public.accounting_scoreboard_problem_types SET archived_at = now(), archived_by = ${BY} WHERE id = ${id('ptype')};
  `);
  report(
    !positive.rejected,
    'custom rows (same label in two sections), $ and # cells, a bucket day, check/uncheck/re-check, a 51-problem line and its delete all write',
    positive.message,
  );

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string[], string]> = [
    [
      'a custom row with no custom section is refused',
      [`INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('custom', '__control__ X', ${BY})`],
      'acct_sb_rows_custom_pair',
    ],
    [
      'a built-in row that names a custom section is refused',
      [`INSERT INTO public.accounting_scoreboard_rows (section_key, custom_section_id, label, created_by) VALUES ('inbox', ${id('custom')}, '__control__ X', ${BY})`],
      'acct_sb_rows_custom_pair',
    ],
    [
      'the same label twice in ONE custom section is refused',
      [
        `INSERT INTO public.accounting_scoreboard_rows (section_key, custom_section_id, label, created_by) VALUES ('custom', ${id('custom')}, '__control__ Same', ${BY})`,
        `INSERT INTO public.accounting_scoreboard_rows (section_key, custom_section_id, label, created_by) VALUES ('custom', ${id('custom')}, '__control__ same', ${BY})`,
      ],
      'acct_sb_rows_one_live_label',
    ],
    [
      'the same label twice in a built-in section is still refused',
      [
        `INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('buckets', '__control__ Twin', ${BY})`,
        `INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('buckets', '__control__ twin', ${BY})`,
      ],
      'acct_sb_rows_one_live_label',
    ],
    ['a bucket day on a non-bucket row is refused', [`UPDATE public.accounting_scoreboard_rows SET bucket_day = 'mon' WHERE id = ${id('rep')}`], 'acct_sb_rows_bucket_day_valid'],
    ['a Saturday bucket day is refused', [`UPDATE public.accounting_scoreboard_rows SET bucket_day = 'sat' WHERE id = ${id('bucket')}`], 'acct_sb_rows_bucket_day_valid'],
    ['due-soon on a non-chargebacks row is refused', [`UPDATE public.accounting_scoreboard_rows SET due_soon = true WHERE id = ${id('bucket')}`], 'acct_sb_rows_due_soon_valid'],
    ['a row in an unknown section is still refused', [`INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('payroll', '__control__ X', ${BY})`], 'acct_sb_rows_section_valid'],
    [
      'a fractional chargeback count is refused',
      [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${id('bucket')}, '2000-01-03', 'count', 1.5, ${BY})`],
      'acct_sb_entries_count_whole',
    ],
    [
      'an unknown slot is still refused',
      [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${id('bucket')}, '2000-01-03', 'noon', 1, ${BY})`],
      'acct_sb_entries_slot_valid',
    ],
    [
      'a dollar amount over the 100,000 ceiling is refused',
      [`INSERT INTO public.accounting_scoreboard_entries (row_id, entry_date, slot, value, updated_by) VALUES (${id('bucket')}, '2000-01-03', 'usd', 100000.01, ${BY})`],
      'acct_sb_entries_value_range',
    ],
    [
      'an unknown custom kind is refused',
      [`INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, created_by, updated_by) VALUES ('__control__ K', 'time', ${BY}, ${BY})`],
      'acct_sb_custom_kind_valid',
    ],
    [
      'a goal with no direction is refused',
      [`INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, goal, created_by, updated_by) VALUES ('__control__ G', 'daily', 5, ${BY}, ${BY})`],
      'acct_sb_custom_goal_pair',
    ],
    [
      'a "below" goal on a scored (AM/PM) section is refused',
      [`INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, goal, goal_direction, created_by, updated_by) VALUES ('__control__ G', 'am_pm', 5, 'below', ${BY}, ${BY})`],
      'acct_sb_custom_score_goal_at_least',
    ],
    [
      'a score goal over 10 is refused',
      [`INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, goal, goal_direction, created_by, updated_by) VALUES ('__control__ G', 'am_pm', 11, 'at_least', ${BY}, ${BY})`],
      'acct_sb_custom_score_goal_max',
    ],
    [
      'two live custom sections with one title are refused',
      [`INSERT INTO public.accounting_scoreboard_custom_sections (title, kind, created_by, updated_by) VALUES ('__control__ section', 'daily', ${BY}, ${BY})`],
      'acct_sb_custom_one_live_title',
    ],
    [
      'two live verifications on one collection are refused',
      [
        `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name) VALUES (${id('coll')}, ${BY}, 'A')`,
        `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name) VALUES (${id('coll')}, ${BY}, 'B')`,
      ],
      'acct_sb_verif_one_live',
    ],
    [
      'EDITING who verified is refused',
      [
        `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name) VALUES (${id('coll')}, ${BY}, 'A')`,
        `UPDATE public.accounting_scoreboard_collection_verifications SET verified_by_name = 'Someone else' WHERE collection_id = ${id('coll')}`,
      ],
      'acct_sb_verif_append_only',
    ],
    [
      'bringing an unchecked verification back is refused (check again instead)',
      [
        `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name) VALUES (${id('coll')}, ${BY}, 'A')`,
        `UPDATE public.accounting_scoreboard_collection_verifications SET unverified_at = now(), unverified_by = ${BY} WHERE collection_id = ${id('coll')}`,
        `UPDATE public.accounting_scoreboard_collection_verifications SET unverified_at = NULL, unverified_by = NULL WHERE collection_id = ${id('coll')}`,
      ],
      'acct_sb_verif_unchecked_is_final',
    ],
    [
      'an uncheck without who unchecked it is refused',
      [
        `INSERT INTO public.accounting_scoreboard_collection_verifications (collection_id, verified_by, verified_by_name) VALUES (${id('coll')}, ${BY}, 'A')`,
        `UPDATE public.accounting_scoreboard_collection_verifications SET unverified_at = now() WHERE collection_id = ${id('coll')}`,
      ],
      'acct_sb_verif_unverify_pair',
    ],
    [
      'the collections log is STILL append-only (editing points refused)',
      [`UPDATE public.accounting_scoreboard_collections SET points = 12 WHERE id = ${id('coll')}`],
      'acct_sb_coll_append_only',
    ],
    [
      'a problem logged against a NON-problems row is refused',
      [`INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, created_by) VALUES ('2000-01-03', ${id('rep')}, ${id('ptype')}, ${BY})`],
      'acct_sb_prob_person_fk',
    ],
    [
      // Was "a count of 0 is refused" (1–1000). Since 2026-10-07 the range is 0–1000 (Kane: "0 can count as
      // 0 problems"; 2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql), so -1 is the edge now.
      'a negative problem count is refused',
      [`INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, problem_count, created_by) VALUES ('2000-01-03', ${id('person')}, ${id('ptype')}, -1, ${BY})`],
      'acct_sb_prob_count_range',
    ],
    [
      'EDITING a logged problem is refused',
      [
        `INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, created_by) VALUES ('2000-01-03', ${id('person')}, ${id('ptype')}, ${BY})`,
        `UPDATE public.accounting_scoreboard_problems SET problem_count = 5 WHERE row_id = ${id('person')}`,
      ],
      'acct_sb_prob_append_only',
    ],
    [
      'UN-deleting a deleted problem is refused',
      [
        `INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, created_by) VALUES ('2000-01-03', ${id('person')}, ${id('ptype')}, ${BY})`,
        `UPDATE public.accounting_scoreboard_problems SET deleted_at = now(), deleted_by = ${BY} WHERE row_id = ${id('person')}`,
        `UPDATE public.accounting_scoreboard_problems SET deleted_at = NULL, deleted_by = NULL WHERE row_id = ${id('person')}`,
      ],
      'acct_sb_prob_deleted_is_final',
    ],
    [
      'two live problem types with one name are refused',
      [`INSERT INTO public.accounting_scoreboard_problem_types (label, created_by) VALUES ('__control__ type', ${BY})`],
      'acct_sb_ptype_one_live_label',
    ],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await attempt(`${FIXTURES_SQL}\n${sql.map((x) => `${x};`).join('\n')}`);
    const ok = r.rejected && r.message.includes(expect);
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — round 3 is live.');
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

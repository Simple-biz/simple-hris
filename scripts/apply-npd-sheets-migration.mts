/**
 * [NPD]
 * Applies references/sql/create/2026-10-01_npd_sheets.sql — the NPD (New Payroll
 * Dashboard) tables `npd_sheets`, `npd_all_departments_rows`, `npd_hsl_rows` and
 * the save function `npd_save_sheet` — then verifies that every object landed,
 * that nobody but the service role can read the rows or call the function, AND
 * that each guard actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-npd-sheets-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-npd-sheets-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-npd-sheets-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-npd-sheets-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a transaction
 * that is always rolled back. Postgres DDL is transactional, so this proves the
 * migration parses, the tables build and the guards bite while leaving production
 * exactly as it was. Re-running --apply is safe: CREATE ... IF NOT EXISTS,
 * CREATE OR REPLACE FUNCTION, ENABLE ROW LEVEL SECURITY and REVOKE are no-ops for
 * whatever already exists, and no row is touched.
 *
 * Every control below runs inside a SAVEPOINT that is rolled back, on the week of
 * 2000-01-02 (a Sunday nobody will ever pay), so even --apply writes no rows.
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
 * Safe to run BEFORE or AFTER deploying the code: until the tables exist the NPD
 * route answers 503 "not set up yet" and the page says so; nothing else reads them.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-01_npd_sheets.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLES = ['npd_sheets', 'npd_all_departments_rows', 'npd_hsl_rows'] as const;
const FN = 'public.npd_save_sheet(text, date, integer, text, jsonb)';
const CONSTRAINTS = [
  'npd_sheets_one_per_week',
  'npd_sheets_id_sheet',
  'npd_sheets_week_is_sunday',
  'npd_all_departments_rows_sheet_fk',
  'npd_all_departments_rows_one_per_position',
  'npd_hsl_rows_sheet_fk',
  'npd_hsl_rows_one_per_position',
];

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
  ...TABLES.map((t): [string, string] => [
    `${t} exists`,
    `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`,
  ]),
  [
    'npd_save_sheet exists',
    `SELECT to_regprocedure('${FN}') IS NOT NULL AS ok`,
  ],
  [
    'npd_sheets comment records that cells are TEXT exactly as pasted',
    `SELECT COALESCE((SELECT obj_description(to_regclass('public.npd_sheets'), 'pg_class')
        LIKE '%TEXT exactly as pasted%'), false) AS ok`,
  ],
  // Per-person pay figures and the last four digits of bank accounts. With RLS
  // off, Supabase's default grants hand the public anon key full read/write.
  ...TABLES.map((t): [string, string] => [
    `${t}: row level security is ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class
       WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...TABLES.map((t): [string, string] => [
    `${t}: ZERO policies (service role only)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...TABLES.flatMap((t) =>
    (['anon', 'authenticated'] as const).map((role): [string, string] => [
      `${t}: ${role} has NO select privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${t}', 'SELECT') AS ok`,
    ]),
  ),
  ...(['anon', 'authenticated'] as const).map((role): [string, string] => [
    `npd_save_sheet: ${role} CANNOT execute it`,
    `SELECT NOT has_function_privilege('${role}', '${FN}', 'EXECUTE') AS ok`,
  ]),
  [
    'npd_save_sheet: service_role CAN execute it',
    `SELECT has_function_privilege('service_role', '${FN}', 'EXECUTE') AS ok`,
  ],
  [
    'npd_save_sheet pins search_path',
    `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc
       WHERE oid = to_regprocedure('${FN}')), false) AS ok`,
  ],
  [
    'no NPD table is in supabase_realtime',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename IN (${TABLES.map((t) => `'${t}'`).join(', ')})) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  // Every cell column is text. A numeric column would refuse "₱1,234.56".
  ...(['npd_all_departments_rows', 'npd_hsl_rows'] as const).map((t): [string, string] => [
    `${t}: every cell column is text`,
    `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${t}'
         AND column_name NOT IN ('id', 'sheet_id', 'sheet', 'row_no', 'created_at')
         AND data_type <> 'text') AS ok`,
  ]),
  [
    'npd_all_departments_rows has exactly 30 cell columns',
    `SELECT (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='npd_all_departments_rows'
         AND column_name NOT IN ('id', 'sheet_id', 'sheet', 'row_no', 'created_at')) = 30 AS ok`,
  ],
  [
    'npd_hsl_rows has exactly 32 cell columns',
    `SELECT (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='npd_hsl_rows'
         AND column_name NOT IN ('id', 'sheet_id', 'sheet', 'row_no', 'created_at')) = 32 AS ok`,
  ],
];

const WEEK = "'2000-01-02'"; // a Sunday
const BY = "'npd-control@simple.biz'";
const ROW_A = '00000000-0000-4000-8000-0000000000a1';
const ROW_B = '00000000-0000-4000-8000-0000000000b2';

function save(sheet: string, expected: number, rows: unknown, week = WEEK, by = BY): string {
  const json = JSON.stringify(rows).replace(/'/g, "''");
  return `SELECT * FROM public.npd_save_sheet('${sheet}', ${week}::date, ${expected}, ${by}, '${json}'::jsonb)`;
}

const TWO_ROWS = [
  { id: ROW_A, row_no: 1, work_email: 'a@simple.biz', total_pay_php: '₱1,234.56', hris: 'Yes' },
  { id: ROW_B, row_no: 2, name: 'B "quoted" O\'Neil', notes_bonuses: 'line one\nline two' },
];

const client = new Client({ connectionString });

async function inSavepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    return await fn();
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

/**
 * Runs `sql` in its OWN savepoint and reports whether Postgres refused it. The
 * savepoint is not optional: a refused statement leaves the transaction aborted,
 * and without rolling back to a savepoint every later statement would fail with
 * "current transaction is aborted" — which every later control would then read
 * as its own guard biting.
 */
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

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — NPD sheets`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${TABLES.join(', ')}`,
      `  Function : ${FN}`,
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

  console.log('\nVerifying the save and its guards actually behave:');
  // SAVEPOINTs, not BEGIN/ROLLBACK: in --dry we are already inside the outer
  // transaction, where a nested BEGIN silently no-ops while its ROLLBACK would
  // discard the whole rehearsal.
  if (!dryRun) await client.query('BEGIN');

  const report = (ok: boolean, label: string, why = '') => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why ? ` — ${why}` : ''}`);
  };

  // POSITIVE CONTROL — without it every "rejected" below could be passing for an
  // unrelated reason, and a suite that cannot accept a good save is
  // indistinguishable from one where the guards all work.
  const positiveOk = await inSavepoint('pc', async () => {
    try {
      const first = await client.query(save('hsl', 0, TWO_ROWS));
      const v1 = first.rows[0];
      if (v1?.version !== 1 || v1?.row_count !== 2) {
        report(false, 'first save of a new HSL sheet → version 1, 2 rows', JSON.stringify(v1));
        return false;
      }
      const cells = await client.query(
        `SELECT total_pay_php, notes_bonuses, name FROM public.npd_hsl_rows
          WHERE sheet_id = $1 ORDER BY row_no`,
        [v1.sheet_id],
      );
      const verbatim =
        cells.rows[0]?.total_pay_php === '₱1,234.56' &&
        cells.rows[1]?.notes_bonuses === 'line one\nline two' &&
        cells.rows[1]?.name === 'B "quoted" O\'Neil';
      report(verbatim, 'cells are stored VERBATIM (₱, commas, quotes, newlines)');

      const second = await client.query(save('hsl', 1, [TWO_ROWS[1]].map((r) => ({ ...r, row_no: 1 }))));
      const v2 = second.rows[0];
      const left = await client.query('SELECT count(*)::int AS n FROM public.npd_hsl_rows WHERE sheet_id = $1', [v1.sheet_id]);
      const replaced = v2?.version === 2 && v2?.row_count === 1 && left.rows[0]?.n === 1;
      report(replaced, 'a second save REPLACES the rows (2 → 1) and bumps the version to 2');

      const stale = await rejects(save('hsl', 1, TWO_ROWS));
      report(
        stale.rejected && stale.message.includes('npd_version_conflict:2'),
        'a save carrying a STALE version is refused with npd_version_conflict:<current>',
        stale.rejected ? '' : 'it was accepted — two editors would overwrite each other',
      );

      const crossSheet = await rejects(
        `INSERT INTO public.npd_all_departments_rows (id, sheet_id, row_no)
         VALUES (gen_random_uuid(), '${v1.sheet_id}', 1)`,
      );
      report(crossSheet.rejected, 'an All Departments row CANNOT hang off an HSL sheet (composite FK)');
      return true;
    } catch (e) {
      report(false, 'a legal save is ACCEPTED (proves the suite can pass)', (e as Error).message);
      return false;
    }
  });
  if (positiveOk) report(true, 'a legal save is ACCEPTED (proves the suite can pass)');
  if (!positiveOk) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }

  const allDeptOk = await inSavepoint('ad', async () => {
    const r = await rejects(save('all_departments', 0, [{ id: ROW_A, row_no: 1, regular_rate: '₱265.00' }]));
    return !r.rejected;
  });
  report(allDeptOk, 'an All Departments sheet saves through the same function');

  const NEGATIVE: Array<[string, string | string[]]> = [
    ['a week that is not a Sunday is refused', save('hsl', 0, TWO_ROWS, "'2000-01-03'")],
    ['an unknown sheet is refused', save('payroll', 0, TWO_ROWS)],
    ['a blank saved_by is refused (a save that belongs to nobody)', save('hsl', 0, TWO_ROWS, WEEK, "'   '")],
    ['rows that are not a JSON array are refused', save('hsl', 0, { id: ROW_A })],
    [
      'two rows at the same position are refused',
      save('hsl', 0, [TWO_ROWS[0], { ...TWO_ROWS[1], row_no: 1 }]),
    ],
    [
      'a sheet row inserted directly for a Monday is refused',
      `INSERT INTO public.npd_sheets (sheet, week_start, created_by, updated_by)
       VALUES ('hsl', '2000-01-03', ${BY}, ${BY})`,
    ],
    [
      'a second sheet for the same tab and week is refused',
      [
        `INSERT INTO public.npd_sheets (sheet, week_start, created_by, updated_by) VALUES ('hsl', ${WEEK}, ${BY}, ${BY})`,
        `INSERT INTO public.npd_sheets (sheet, week_start, created_by, updated_by) VALUES ('hsl', ${WEEK}, ${BY}, ${BY})`,
      ],
    ],
  ];
  for (const [label, sql] of NEGATIVE) {
    const r = await inSavepoint('nc', () => rejects(sql));
    report(r.rejected, label);
  }

  await client.query('ROLLBACK');
  if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');

  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    verifyOnly || dryRun
      ? '\nAll checks passed.'
      : '\nAll checks passed — the NPD tables are live.',
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

/**
 * [NPD-LOCK]
 * Applies references/sql/alter/2026-10-01_npd_sheets_lock.sql — NPD's Lock in:
 * `npd_sheets.locked_at` / `locked_by`, `npd_save_sheet` replaced so it refuses a
 * locked sheet, and the new `npd_lock_sheet` / `npd_unlock_sheet` — then verifies
 * every object landed, that only the service role can call the functions, AND that
 * a locked sheet really refuses a save in the database.
 *
 *   node --import tsx scripts/apply-npd-sheets-lock-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-npd-sheets-lock-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-npd-sheets-lock-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-npd-sheets-lock-migration.mts --verify  # verify only
 *
 * NEEDS THE BASE MIGRATION FIRST (scripts/apply-npd-sheets-migration.mts). It
 * refuses to run when `npd_sheets` is missing, rather than half-building NPD.
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL runs inside a transaction that is
 * always rolled back. Every control below runs in a SAVEPOINT that is rolled back,
 * on the week of 2000-01-02 (a Sunday nobody will ever pay), so even --apply writes
 * no rows. The ALTER adds two nullable columns and touches no existing row.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url). Percent-encode an `@` in the
 * password as %40.
 *
 * Safe to run BEFORE or AFTER deploying the code: until it is applied the NPD page
 * still loads and saves (nothing can be locked without npd_lock_sheet), and Lock in
 * answers "Lock in is not set up yet".
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-01_npd_sheets_lock.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const FUNCTIONS = [
  ['npd_save_sheet', 'public.npd_save_sheet(text, date, integer, text, jsonb)'],
  ['npd_lock_sheet', 'public.npd_lock_sheet(text, date, integer, text)'],
  ['npd_unlock_sheet', 'public.npd_unlock_sheet(text, date, text)'],
] as const;

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
  ...(['locked_at', 'locked_by'] as const).map((col): [string, string] => [
    `npd_sheets.${col} exists and is nullable`,
    `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='npd_sheets' AND column_name='${col}'), false) AS ok`,
  ]),
  [
    'npd_sheets.locked_at is timestamptz',
    `SELECT COALESCE((SELECT data_type = 'timestamp with time zone' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='npd_sheets' AND column_name='locked_at'), false) AS ok`,
  ],
  ...['npd_sheets_lock_both_or_neither', 'npd_sheets_locked_by_present'].map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...FUNCTIONS.flatMap(([name, sig]): Array<[string, string]> => [
    [`${name} exists`, `SELECT to_regprocedure('${sig}') IS NOT NULL AS ok`],
    ...(['anon', 'authenticated'] as const).map((role): [string, string] => [
      `${name}: ${role} CANNOT execute it`,
      `SELECT NOT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS ok`,
    ]),
    [`${name}: service_role CAN execute it`, `SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS ok`],
    [
      `${name} pins search_path`,
      `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc
         WHERE oid = to_regprocedure('${sig}')), false) AS ok`,
    ],
  ]),
  [
    'npd_save_sheet checks the lock (its body names npd_sheet_locked)',
    `SELECT COALESCE((SELECT prosrc LIKE '%npd_sheet_locked%' FROM pg_proc
       WHERE oid = to_regprocedure('public.npd_save_sheet(text, date, integer, text, jsonb)')), false) AS ok`,
  ],
  [
    'the NPD tables still have RLS on and ZERO policies',
    `SELECT (SELECT bool_and(relrowsecurity) FROM pg_class
              WHERE oid IN (to_regclass('public.npd_sheets'), to_regclass('public.npd_all_departments_rows'),
                            to_regclass('public.npd_hsl_rows')))
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'npd_%') AS ok`,
  ],
];

const WEEK = "'2000-01-02'"; // a Sunday
const BY = "'npd-control@simple.biz'";
const ROWS = [
  { id: '00000000-0000-4000-8000-0000000000a1', row_no: 1, work_email: 'a@simple.biz', total_pay_php: '₱1,234.56' },
  { id: '00000000-0000-4000-8000-0000000000b2', row_no: 2, name: 'B' },
];

function save(sheet: string, expected: number, rows: unknown, week = WEEK, by = BY): string {
  const json = JSON.stringify(rows).replace(/'/g, "''");
  return `SELECT * FROM public.npd_save_sheet('${sheet}', ${week}::date, ${expected}, ${by}, '${json}'::jsonb)`;
}
function lock(sheet: string, expected: number, week = WEEK, by = BY): string {
  return `SELECT * FROM public.npd_lock_sheet('${sheet}', ${week}::date, ${expected}, ${by})`;
}
function unlock(sheet: string, week = WEEK, by = BY): string {
  return `SELECT * FROM public.npd_unlock_sheet('${sheet}', ${week}::date, ${by})`;
}

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

/** Runs `sql` in its OWN savepoint, so a refusal never leaves the transaction aborted for the next control. */
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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — NPD Lock in`,
      '',
      `  SQL : ${SQL_PATH}`,
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

  const base = await client.query(`SELECT to_regclass('public.npd_sheets') IS NOT NULL AS ok`);
  if (base.rows[0]?.ok !== true) {
    await client.end();
    console.error('npd_sheets does not exist. Apply the base migration first: scripts/apply-npd-sheets-migration.mts --apply');
    process.exit(1);
  }

  if (dryRun) {
    console.log('Applying inside a transaction, then rolling back.\n');
    await client.query('BEGIN');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    console.log('Applying ...');
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

  console.log('\nVerifying the lock actually holds:');
  if (!dryRun) await client.query('BEGIN');

  const report = (ok: boolean, label: string, why = '') => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why ? ` — ${why}` : ''}`);
  };

  // POSITIVE CONTROL first — a suite that cannot save and lock a good sheet proves nothing.
  const positiveOk = await inSavepoint('pc', async () => {
    try {
      const v1 = (await client.query(save('hsl', 0, ROWS))).rows[0];
      if (v1?.version !== 1) {
        report(false, 'a legal save is ACCEPTED (proves the suite can pass)', JSON.stringify(v1));
        return false;
      }
      report(true, 'a legal save is ACCEPTED (proves the suite can pass)');

      const stale = await rejects(lock('hsl', 0));
      report(stale.rejected && stale.message.includes('npd_version_conflict:1'), 'a lock at a STALE version is refused (lock only what you saw)', stale.message);

      const locked = (await client.query(lock('hsl', 1))).rows[0];
      report(
        !!locked?.locked_at && locked?.locked_by === 'npd-control@simple.biz' && locked?.version === 1 && locked?.row_count === 2,
        'a lock at the current version locks the sheet and keeps its version',
        JSON.stringify(locked),
      );

      const blocked = await rejects(save('hsl', 1, ROWS));
      report(blocked.rejected && blocked.message.includes('npd_sheet_locked'), 'a save on a LOCKED sheet is refused, even at the current version', blocked.message);
      const emptied = await rejects(save('hsl', 1, []));
      report(emptied.rejected && emptied.message.includes('npd_sheet_locked'), 'a locked sheet cannot be emptied either');
      const anyVersion = await rejects(save('hsl', 7, ROWS));
      report(anyVersion.rejected && anyVersion.message.includes('npd_sheet_locked'), 'the lock is checked BEFORE the version (a stale save still reads "locked")');
      const twice = await rejects(lock('hsl', 1));
      report(twice.rejected && twice.message.includes('npd_sheet_locked'), 'locking a locked sheet is refused');

      const cells = await client.query('SELECT count(*)::int AS n FROM public.npd_hsl_rows WHERE sheet_id = $1', [v1.sheet_id]);
      report(cells.rows[0]?.n === 2, 'the refused saves changed no rows');

      const unlocked = (await client.query(unlock('hsl'))).rows[0];
      report(unlocked?.version === 1, 'unlock clears the lock and keeps the version', JSON.stringify(unlocked));
      const after = await rejects(save('hsl', 1, ROWS));
      report(!after.rejected, 'after unlock the sheet saves again', after.message);
      const again = await rejects(unlock('hsl'));
      report(again.rejected && again.message.includes('npd_sheet_not_locked'), 'unlocking an unlocked sheet is refused');
      return true;
    } catch (e) {
      report(false, 'the lock suite ran', (e as Error).message);
      return false;
    }
  });
  if (!positiveOk) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }

  const NEGATIVE: Array<[string, string | string[]]> = [
    ['locking a week that has no sheet is refused', lock('hsl', 0)],
    ['locking a sheet with no rows is refused', [save('all_departments', 0, []), lock('all_departments', 1)]],
    ['a lock with a blank author is refused', [save('hsl', 0, ROWS), lock('hsl', 1, WEEK, "'   '")]],
    [
      'the table refuses a lock with no author (locked_at without locked_by)',
      [save('hsl', 0, ROWS), `UPDATE public.npd_sheets SET locked_at = now() WHERE week_start = ${WEEK}`],
    ],
    ['an unlock with a blank author is refused', [save('hsl', 0, ROWS), lock('hsl', 1), unlock('hsl', WEEK, "'   '")]],
    ['a stale save on an UNLOCKED sheet is still a version conflict', [save('hsl', 0, ROWS), save('hsl', 0, ROWS)]],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — NPD Lock in is live.');
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

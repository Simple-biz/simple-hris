/**
 * [NPD-FORMULAS]
 * Applies references/sql/alter/2026-10-01_npd_formulas.sql — NPD's formulas:
 * `npd_sheets.usd_per_php` + `column_formulas`, `formula_overrides` + `formula_cells`
 * on both row tables, and `npd_save_sheet_v2` — then verifies every object, the
 * privileges, and that a save really stores what it was given (and still refuses a
 * locked sheet).
 *
 *   node --import tsx scripts/apply-npd-formulas-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-npd-formulas-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-npd-formulas-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-npd-formulas-migration.mts --verify  # verify only
 *
 * ORDER: base (scripts/apply-npd-sheets-migration.mts) → Lock in
 * (scripts/apply-npd-sheets-lock-migration.mts) → this. `--apply` refuses to run
 * while the Lock in columns are missing. A DRY RUN with Lock in not yet applied
 * rehearses Lock in first, inside the same rolled-back transaction, and says so.
 *
 * SAFE BY DEFAULT: no flag is a dry run, always rolled back. Every control runs in a
 * SAVEPOINT that is rolled back, on the week of 2000-01-02, so --apply writes no rows.
 * The ALTER adds columns with defaults and touches no existing row's values.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER (memory/migration-apply-needs-database-url).
 *
 * Deploy: apply this BEFORE pushing the formulas code. That code saves through
 * npd_save_sheet_v2 and, until it exists, a save fails loudly ("NPD formulas are not
 * set up yet") with the edits kept on screen. The old npd_save_sheet stays, so code
 * that has not been redeployed keeps saving.
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

const SQL_PATH = path.join(REPO_ROOT, 'references', 'sql', 'alter', '2026-10-01_npd_formulas.sql');
const LOCK_SQL_PATH = path.join(REPO_ROOT, 'references', 'sql', 'alter', '2026-10-01_npd_sheets_lock.sql');
for (const p of [SQL_PATH, LOCK_SQL_PATH]) {
  if (!existsSync(p)) {
    console.error(`Migration SQL not found at ${p}`);
    process.exit(1);
  }
}
const V2 = 'public.npd_save_sheet_v2(text, date, integer, text, jsonb, numeric, jsonb)';

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
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (percent-encode any @ in the password as %40).');
  process.exit(1);
}

const col = (table: string, column: string, test: string) =>
  `SELECT COALESCE((SELECT ${test} FROM information_schema.columns
     WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}'), false) AS ok`;

const CHECKS: Array<[string, string]> = [
  ['npd_sheets.usd_per_php is numeric (exact, never a float)', col('npd_sheets', 'usd_per_php', "data_type = 'numeric'")],
  ['npd_sheets.column_formulas is jsonb NOT NULL', col('npd_sheets', 'column_formulas', "data_type = 'jsonb' AND is_nullable = 'NO'")],
  ...(['npd_all_departments_rows', 'npd_hsl_rows'] as const).flatMap((t): Array<[string, string]> => [
    [`${t}.formula_overrides is text[] NOT NULL`, col(t, 'formula_overrides', "data_type = 'ARRAY' AND is_nullable = 'NO'")],
    [`${t}.formula_cells is jsonb NOT NULL`, col(t, 'formula_cells', "data_type = 'jsonb' AND is_nullable = 'NO'")],
  ]),
  ...[
    'npd_sheets_usd_per_php_range',
    'npd_sheets_column_formulas_object',
    'npd_all_departments_rows_formula_cells_object',
    'npd_hsl_rows_formula_cells_object',
  ].map((name): [string, string] => [`constraint ${name}`, `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`]),
  ['npd_save_sheet_v2 exists', `SELECT to_regprocedure('${V2}') IS NOT NULL AS ok`],
  ...(['anon', 'authenticated'] as const).map((role): [string, string] => [
    `npd_save_sheet_v2: ${role} CANNOT execute it`,
    `SELECT NOT has_function_privilege('${role}', '${V2}', 'EXECUTE') AS ok`,
  ]),
  ['npd_save_sheet_v2: service_role CAN execute it', `SELECT has_function_privilege('service_role', '${V2}', 'EXECUTE') AS ok`],
  [
    'npd_save_sheet_v2 pins search_path',
    `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc WHERE oid = to_regprocedure('${V2}')), false) AS ok`,
  ],
  [
    'npd_save_sheet_v2 still refuses a locked sheet (its body names npd_sheet_locked)',
    `SELECT COALESCE((SELECT prosrc LIKE '%npd_sheet_locked%' FROM pg_proc WHERE oid = to_regprocedure('${V2}')), false) AS ok`,
  ],
  [
    'the original npd_save_sheet is still there (code not yet redeployed keeps saving)',
    `SELECT to_regprocedure('public.npd_save_sheet(text, date, integer, text, jsonb)') IS NOT NULL AS ok`,
  ],
  [
    'the NPD tables still have RLS on and ZERO policies',
    `SELECT (SELECT bool_and(relrowsecurity) FROM pg_class
              WHERE oid IN (to_regclass('public.npd_sheets'), to_regclass('public.npd_all_departments_rows'),
                            to_regclass('public.npd_hsl_rows')))
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'npd_%') AS ok`,
  ],
];

const WEEK = "'2000-01-02'";
const BY = "'npd-control@simple.biz'";
const ROW_ID = '00000000-0000-4000-8000-0000000000c3';
const rowJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      id: ROW_ID,
      row_no: 1,
      work_email: 'a@simple.biz',
      regular_rate: '265.00',
      ot_rate: '400.00',
      formula_overrides: ['ot_rate'],
      formula_cells: { tech_bonus: '=1+1' },
      ...extra,
    },
  ]).replace(/'/g, "''");

function saveV2(expected: number, rate: string, columnFormulas = '{"hours_until_ot":"=0"}', rows = rowJson()): string {
  return `SELECT * FROM public.npd_save_sheet_v2('all_departments', ${WEEK}::date, ${expected}, ${BY}, '${rows}'::jsonb, ${rate}, '${columnFormulas}'::jsonb)`;
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
  console.log(`${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — NPD formulas\n\n  SQL : ${SQL_PATH}\n`);
  await client.connect();

  const base = await client.query(`SELECT to_regclass('public.npd_sheets') IS NOT NULL AS ok`);
  if (base.rows[0]?.ok !== true) {
    await client.end();
    console.error('npd_sheets does not exist. Apply the base migration first.');
    process.exit(1);
  }
  const lock = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='npd_sheets' AND column_name='locked_at') AS ok`,
  );
  const lockApplied = lock.rows[0]?.ok === true;

  if (dryRun) {
    await client.query('BEGIN');
    if (!lockApplied) {
      console.log('Lock in is NOT applied yet — rehearsing it first, inside the same rolled-back transaction.');
      await client.query(readFileSync(LOCK_SQL_PATH, 'utf8'));
    }
    console.log('Applying inside a transaction, then rolling back.\n');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    if (!lockApplied) {
      await client.end();
      console.error('Lock in is not applied. Run scripts/apply-npd-sheets-lock-migration.mts --apply first.');
      process.exit(1);
    }
    console.log('Applying ...');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    console.log('  applied.\n');
  } else {
    console.log('Verify only — not applying.\n');
  }

  let failed = 0;
  console.log('Verifying objects:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  console.log('\nVerifying a save stores what it was given:');
  if (!dryRun) await client.query('BEGIN');
  const report = (ok: boolean, label: string, why = '') => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why ? ` — ${why}` : ''}`);
  };

  const positiveOk = await inSavepoint('pc', async () => {
    try {
      const v1 = (await client.query(saveV2(0, '0.0162575'))).rows[0];
      report(v1?.version === 1 && v1?.row_count === 1, 'a legal v2 save is ACCEPTED (proves the suite can pass)', JSON.stringify(v1));
      const sheet = (
        await client.query(`SELECT usd_per_php::text AS rate, column_formulas FROM public.npd_sheets WHERE id = $1`, [v1.sheet_id])
      ).rows[0];
      report(sheet?.rate === '0.0162575', 'the rate is stored EXACTLY (numeric, not a float)', sheet?.rate);
      report(sheet?.column_formulas?.hours_until_ot === '=0', 'column formulas are stored');
      const row = (
        await client.query(
          `SELECT formula_overrides, formula_cells, ot_rate FROM public.npd_all_departments_rows WHERE sheet_id = $1`,
          [v1.sheet_id],
        )
      ).rows[0];
      report(
        Array.isArray(row?.formula_overrides) && row.formula_overrides.join(',') === 'ot_rate',
        'a row keeps which cells are typed over a formula',
        JSON.stringify(row?.formula_overrides),
      );
      report(row?.formula_cells?.tech_bonus === '=1+1' && row?.ot_rate === '400.00', "a row keeps its own formulas and its cells' text");

      const v2 = (await client.query(saveV2(1, 'NULL', '{}', rowJson({ formula_overrides: [], formula_cells: {} })))).rows[0];
      const after = (await client.query(`SELECT usd_per_php FROM public.npd_sheets WHERE id = $1`, [v1.sheet_id])).rows[0];
      report(v2?.version === 2 && after?.usd_per_php === null, 'a later save can clear the rate');

      const stale = await rejects(saveV2(1, '0.0162575'));
      report(stale.rejected && stale.message.includes('npd_version_conflict:2'), 'a stale v2 save is a version conflict');

      await client.query(`SELECT * FROM public.npd_lock_sheet('all_departments', ${WEEK}::date, 2, ${BY})`);
      const locked = await rejects(saveV2(2, '0.0162575'));
      report(locked.rejected && locked.message.includes('npd_sheet_locked'), 'v2 refuses a LOCKED sheet', locked.message);
      await client.query(`SELECT * FROM public.npd_unlock_sheet('all_departments', ${WEEK}::date, ${BY})`);

      const legacy = await rejects(
        `SELECT * FROM public.npd_save_sheet('all_departments', ${WEEK}::date, 2, ${BY}, '[{"id":"${ROW_ID}","row_no":1,"work_email":"a@simple.biz"}]'::jsonb)`,
      );
      report(!legacy.rejected, 'the original npd_save_sheet still saves (deploy window)', legacy.message);
      return true;
    } catch (e) {
      report(false, 'the save suite ran', (e as Error).message);
      return false;
    }
  });
  if (!positiveOk) {
    await client.query('ROLLBACK');
    await client.end();
    console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
    process.exit(1);
  }

  const NEGATIVE: Array<[string, string]> = [
    ['a rate ≥ 1 (pesos per dollar typed the wrong way round) is refused', saveV2(0, '61.51')],
    ['a rate of 0 is refused', saveV2(0, '0')],
    ['a negative rate is refused', saveV2(0, '-0.016')],
    ['column formulas that are not an object are refused', saveV2(0, '0.0162575', '[]')],
    ["a row's own formulas that are not an object are refused", saveV2(0, '0.0162575', '{}', rowJson({ formula_cells: ['=1'] }))],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — NPD formulas are live.');
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

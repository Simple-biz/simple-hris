/**
 * [Payroll Wizard · HRIS vs NPD]
 * Applies references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql — the
 * HRIS vs NPD "Save output" tables `payroll_wizard_npd_comparisons` and
 * `payroll_wizard_npd_comparison_rows`, the save function
 * `payroll_wizard_save_npd_comparison` and the no-UPDATE trigger — then verifies that
 * every object landed, that nobody but the service role can read the rows or call the
 * function, AND that each guard actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-payroll-wizard-npd-comparisons-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-payroll-wizard-npd-comparisons-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-payroll-wizard-npd-comparisons-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-payroll-wizard-npd-comparisons-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a transaction that
 * is always rolled back. Postgres DDL is transactional, so this proves the migration
 * parses, the tables build and the guards bite while leaving production exactly as it
 * was. Re-running --apply is safe: CREATE ... IF NOT EXISTS, CREATE OR REPLACE
 * FUNCTION, DROP/CREATE TRIGGER, ENABLE ROW LEVEL SECURITY and REVOKE are no-ops for
 * whatever already exists, and no row is touched.
 *
 * Every control below runs inside a SAVEPOINT that is rolled back, on a source file
 * named `__control__…` that no Hubstaff upload can have, so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * An `@` in the password MUST be percent-encoded as %40 or the driver truncates the
 * password at the first `@` and misreads the rest as the hostname — which surfaces as
 * "password authentication failed" on a password that was fine.
 *
 * Safe to run BEFORE or AFTER deploying the code: until the tables exist the route
 * answers 503 "not set up yet", the Save output button is disabled and says so, and
 * nothing else reads them.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLES = ['payroll_wizard_npd_comparisons', 'payroll_wizard_npd_comparison_rows'] as const;
const FN = 'public.payroll_wizard_save_npd_comparison(text, text, text, jsonb)';
const TRIGGER_FN = 'public.payroll_wizard_npd_comparisons_refuse_update()';
const CONSTRAINTS = [
  'pw_npd_cmp_one_per_version',
  'pw_npd_cmp_row_count_is_sum',
  'pw_npd_cmp_tolerance_range',
  'pw_npd_cmp_fx_positive',
  'pw_npd_cmp_rows_pk',
  'pw_npd_cmp_rows_status_valid',
  'pw_npd_cmp_rows_hris_side',
  'pw_npd_cmp_rows_npd_side',
  'pw_npd_cmp_rows_delta',
];
const TRIGGERS: Array<[string, string]> = [
  ['pw_npd_cmp_refuse_update', 'payroll_wizard_npd_comparisons'],
  ['pw_npd_cmp_rows_refuse_update', 'payroll_wizard_npd_comparison_rows'],
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
  ['payroll_wizard_save_npd_comparison exists', `SELECT to_regprocedure('${FN}') IS NOT NULL AS ok`],
  ['the no-UPDATE trigger function exists', `SELECT to_regprocedure('${TRIGGER_FN}') IS NOT NULL AS ok`],
  [
    'payroll_wizard_npd_comparisons comment records that it is APPEND-ONLY',
    `SELECT COALESCE((SELECT obj_description(to_regclass('public.payroll_wizard_npd_comparisons'), 'pg_class')
        LIKE '%APPEND-ONLY%'), false) AS ok`,
  ],
  // Every person's pay for the week. With RLS off, Supabase's default grants hand the
  // public anon key full read/write.
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
    (['anon', 'authenticated'] as const).flatMap((role) =>
      (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
        `${t}: ${role} has NO ${priv} privilege`,
        `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
      ]),
    ),
  ),
  ...(['anon', 'authenticated'] as const).flatMap((role): Array<[string, string]> => [
    [
      `payroll_wizard_save_npd_comparison: ${role} CANNOT execute it`,
      `SELECT NOT has_function_privilege('${role}', '${FN}', 'EXECUTE') AS ok`,
    ],
    [
      `the trigger function: ${role} CANNOT execute it`,
      `SELECT NOT has_function_privilege('${role}', '${TRIGGER_FN}', 'EXECUTE') AS ok`,
    ],
  ]),
  [
    'payroll_wizard_save_npd_comparison: service_role CAN execute it',
    `SELECT has_function_privilege('service_role', '${FN}', 'EXECUTE') AS ok`,
  ],
  ...[FN, TRIGGER_FN].map((fn): [string, string] => [
    `${fn.replace('public.', '').replace(/\(.*$/, '')} pins search_path`,
    `SELECT COALESCE((SELECT proconfig::text LIKE '%search_path=%' FROM pg_proc
       WHERE oid = to_regprocedure('${fn}')), false) AS ok`,
  ]),
  [
    'no HRIS vs NPD table is in supabase_realtime',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename IN (${TABLES.map((t) => `'${t}'`).join(', ')})) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...TRIGGERS.map(([name, table]): [string, string] => [
    `trigger ${name} on ${table} (BEFORE UPDATE)`,
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgname = '${name}' AND tgrelid = to_regclass('public.${table}') AND NOT tgisinternal) AS ok`,
  ]),
  [
    'payroll_wizard_npd_comparison_rows.status is NOT NULL (a held output is never saved)',
    `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payroll_wizard_npd_comparison_rows'
         AND column_name='status'), false) AS ok`,
  ],
];

const SOURCE = "'__control__2000-01-02_to_2000-01-08.csv'";
const BY = "'pw-npd-control@simple.biz'";
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const PASTE = 'Work Email\tUSD\na@simple.biz\t$100.00\nb@simple.biz\t$52.00\nc@simple.biz\t$7.50\n';

type Snap = { header: Record<string, unknown>; rows: Array<Record<string, unknown>> };

/** A legal 4-row output at a 3¢ tolerance: a 2¢ match, a $2 mismatch, an NPD-only and an HRIS-only row. */
function legal(): Snap {
  return {
    header: {
      tolerance_cents: 3,
      fx_rate: 61.52,
      match_count: 1,
      mismatch_count: 1,
      not_in_hris_count: 1,
      not_in_npd_count: 1,
      row_count: 4,
      left_out_count: 1,
      npd_lines_read: 3,
      refusal_count: 1,
      hris_total_cents: 9998 + 5000 + 4000,
      npd_total_cents: 10000 + 5200 + 750,
      paste_text: PASTE,
      refusals: [{ line: 5, raw: 'total\t$157.50', reason: 'No work email on this line' }],
      left_out: [{ work_email: 'x@simple.biz', name: 'X', reason: 'excluded', npd_cents: null, npd_lines: [] }],
    },
    rows: [
      { row_no: 1, work_email: 'a@simple.biz', name: 'A "quoted" O\'Neil', status: 'match', hris_cents: 9998, npd_cents: 10000, delta_cents: 2, hris_php: 6150.77, hris_row_count: 1, excluded_row_count: 0, no_payout_row_count: 0, npd_lines: [2], implied_npd_rate: null },
      { row_no: 2, work_email: 'b@simple.biz', name: 'B', status: 'mismatch', hris_cents: 5000, npd_cents: 5200, delta_cents: 200, hris_php: 3076, hris_row_count: 1, excluded_row_count: 0, no_payout_row_count: 0, npd_lines: [3], implied_npd_rate: 59.15 },
      { row_no: 3, work_email: 'c@simple.biz', name: null, status: 'not_in_hris', hris_cents: null, npd_cents: 750, delta_cents: null, hris_php: null, hris_row_count: 0, excluded_row_count: 0, no_payout_row_count: 0, npd_lines: [4], implied_npd_rate: null },
      { row_no: 4, work_email: 'd@simple.biz', name: 'D', status: 'not_in_npd', hris_cents: 4000, npd_cents: null, delta_cents: null, hris_php: 2460.8, hris_row_count: 1, excluded_row_count: 0, no_payout_row_count: 1, npd_lines: [], implied_npd_rate: null },
    ],
  };
}

function save(snap: unknown, sha = SHA_A, by = BY, source = SOURCE): string {
  const json = JSON.stringify(snap).replace(/'/g, "''");
  return `SELECT * FROM public.payroll_wizard_save_npd_comparison(${source}, ${by}, '${sha}', '${json}'::jsonb)`;
}

/** A legal snapshot with one change applied. */
function variant(change: (s: Snap) => void): Snap {
  const s = legal();
  change(s);
  return s;
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

/**
 * Runs `sql` in its OWN savepoint and reports whether Postgres refused it. The savepoint
 * is not optional: a refused statement leaves the transaction aborted, and without
 * rolling back to a savepoint every later statement would fail with "current
 * transaction is aborted" — which every later control would then read as its own guard
 * biting.
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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — HRIS vs NPD saved outputs`,
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
  // transaction, where a nested BEGIN silently no-ops while its ROLLBACK would discard
  // the whole rehearsal.
  if (!dryRun) await client.query('BEGIN');

  const report = (ok: boolean, label: string, why = '') => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why ? ` — ${why}` : ''}`);
  };

  // POSITIVE CONTROL — without it every "rejected" below could be passing for an
  // unrelated reason, and a suite that cannot accept a good save is indistinguishable
  // from one where the guards all work.
  const positiveOk = await inSavepoint('pc', async () => {
    try {
      const first = (await client.query(save(legal()))).rows[0];
      if (first?.version !== 1 || first?.row_count !== 4 || first?.unchanged !== false) {
        report(false, 'first save of a week → version 1, 4 rows, not unchanged', JSON.stringify(first));
        return false;
      }
      const head = (
        await client.query(
          `SELECT paste_text, saved_by, tolerance_cents, fx_rate::text AS fx, jsonb_array_length(refusals) AS nr
             FROM public.payroll_wizard_npd_comparisons WHERE id = $1`,
          [first.comparison_id],
        )
      ).rows[0];
      report(
        head?.paste_text === PASTE && head?.saved_by === 'pw-npd-control@simple.biz' && head?.tolerance_cents === 3 && head?.fx === '61.52' && head?.nr === 1,
        'the header is stored as sent (paste VERBATIM, tolerance, FX, refusals)',
        JSON.stringify(head),
      );
      const rows = (
        await client.query(
          `SELECT row_no, name, status, delta_cents::int AS d, npd_lines, hris_php::text AS php
             FROM public.payroll_wizard_npd_comparison_rows WHERE comparison_id = $1 ORDER BY row_no`,
          [first.comparison_id],
        )
      ).rows;
      report(
        rows.length === 4 &&
          rows[0].name === 'A "quoted" O\'Neil' &&
          rows[0].status === 'match' &&
          rows[0].d === 2 &&
          Array.isArray(rows[0].npd_lines) && rows[0].npd_lines[0] === 2 &&
          rows[3].npd_lines.length === 0 &&
          rows[1].php === '3076.00',
        'the rows are stored as sent (verdicts, a 2¢ match keeps its difference, npd_lines[], ₱ to 2dp)',
        JSON.stringify(rows),
      );

      const again = (await client.query(save(legal()))).rows[0];
      report(
        again?.unchanged === true && again?.version === 1 && again?.comparison_id === first.comparison_id,
        'saving the IDENTICAL output (same sha256) returns version 1, unchanged — no copy',
        JSON.stringify(again),
      );
      const second = (await client.query(save(legal(), SHA_B))).rows[0];
      report(second?.version === 2 && second?.unchanged === false, 'a changed output APPENDS version 2', JSON.stringify(second));
      const kept = (
        await client.query(`SELECT count(*)::int AS n FROM public.payroll_wizard_npd_comparisons WHERE source_file = ${SOURCE}`)
      ).rows[0];
      report(kept?.n === 2, 'version 1 is still there after version 2 (nothing overwritten)');

      const upd = await rejects(`UPDATE public.payroll_wizard_npd_comparisons SET tolerance_cents = 10 WHERE id = '${first.comparison_id}'`);
      report(
        upd.rejected && upd.message.includes('pw_npd_cmp_saved_output_is_immutable'),
        'an UPDATE of a saved output is REFUSED (header)',
        upd.rejected ? '' : 'it was accepted — a saved output could be rewritten',
      );
      const updRow = await rejects(`UPDATE public.payroll_wizard_npd_comparison_rows SET status = 'match' WHERE comparison_id = '${first.comparison_id}' AND row_no = 2`);
      report(
        updRow.rejected && updRow.message.includes('pw_npd_cmp_saved_output_is_immutable'),
        'an UPDATE of a saved row is REFUSED (a mismatch cannot be turned green later)',
      );
      // `rejects` runs it in its own savepoint and rolls it back, so v1 is still there.
      const del = await rejects(`DELETE FROM public.payroll_wizard_npd_comparisons WHERE id = '${first.comparison_id}'`);
      report(!del.rejected, 'the service role CAN delete a save (cleanup stays possible)', del.message);
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

  const cascadeOk = await inSavepoint('cd', async () => {
    const first = (await client.query(save(legal()))).rows[0];
    await client.query(`DELETE FROM public.payroll_wizard_npd_comparisons WHERE id = $1`, [first.comparison_id]);
    const left = (
      await client.query(`SELECT count(*)::int AS n FROM public.payroll_wizard_npd_comparison_rows WHERE comparison_id = $1`, [first.comparison_id])
    ).rows[0];
    return left?.n === 0;
  });
  report(cascadeOk, 'deleting a save deletes its rows with it (cascade)');

  const NEGATIVE: Array<[string, string | string[], string?]> = [
    ['a row with NO verdict (a held output) is refused', save(variant((s) => { s.rows[0].status = null; }))],
    ['an unknown verdict is refused', save(variant((s) => { s.rows[0].status = 'close_enough'; }))],
    [
      'a MATCH outside the tolerance is refused',
      save(variant((s) => { s.header.tolerance_cents = 1; })),
      'pw_npd_cmp_verdict_disagrees',
    ],
    [
      'a MISMATCH inside the tolerance is refused',
      // B's gap becomes 2¢ at a 3¢ tolerance, still marked mismatch; totals kept consistent.
      save(variant((s) => {
        s.rows[1].npd_cents = 5002;
        s.rows[1].delta_cents = 2;
        s.header.npd_total_cents = 10000 + 5002 + 750;
      })),
      'pw_npd_cmp_verdict_disagrees',
    ],
    [
      'header counts that are not the rows’ verdicts are refused',
      save(variant((s) => { s.header.match_count = 2; s.header.mismatch_count = 0; })),
      'pw_npd_cmp_counts_disagree',
    ],
    [
      'a header row_count that is not the sum of its counts is refused',
      save(variant((s) => { s.header.row_count = 5; })),
    ],
    [
      'an HRIS total that is not the rows’ sum is refused',
      save(variant((s) => { s.header.hris_total_cents = 1; })),
      'pw_npd_cmp_totals_disagree',
    ],
    [
      'an NPD total that is not the rows’ sum is refused',
      save(variant((s) => { s.header.npd_total_cents = 1; })),
      'pw_npd_cmp_totals_disagree',
    ],
    ['a difference that is not NPD − HRIS is refused', save(variant((s) => { s.rows[1].delta_cents = 100; }))],
    ['a Not in HRIS row carrying an HRIS figure is refused', save(variant((s) => { s.rows[2].hris_cents = 1; }))],
    ['a Not in NPD row carrying an NPD figure is refused', save(variant((s) => { s.rows[3].npd_cents = 1; }))],
    ['a Not in NPD row carrying paste lines is refused', save(variant((s) => { s.rows[3].npd_lines = [9]; }))],
    ['a match with NO difference recorded is refused', save(variant((s) => { s.rows[0].delta_cents = null; }))],
    ['an implied rate on a non-mismatch is refused', save(variant((s) => { s.rows[0].implied_npd_rate = 61; }))],
    ['row numbers with a gap are refused', save(variant((s) => { s.rows[3].row_no = 9; })), 'pw_npd_cmp_row_order'],
    ['two rows at the same position are refused', save(variant((s) => { s.rows[3].row_no = 1; }))],
    ['a tolerance of 100¢ is refused', save(variant((s) => { s.header.tolerance_cents = 100; }))],
    ['an FX rate of 0 is refused', save(variant((s) => { s.header.fx_rate = 0; }))],
    ['a refusals array that disagrees with refusal_count is refused', save(variant((s) => { s.header.refusal_count = 2; }))],
    ['a left-out array that disagrees with left_out_count is refused', save(variant((s) => { s.header.left_out_count = 0; }))],
    ['an empty paste is refused', save(variant((s) => { s.header.paste_text = ''; }))],
    ['an output with ZERO rows is refused', save({ header: legal().header, rows: [] }), 'pw_npd_cmp_no_rows'],
    ['a snapshot that is not an object is refused', save([]), 'pw_npd_cmp_bad_snapshot'],
    ['a blank saved_by is refused (a save that belongs to nobody)', save(legal(), SHA_A, "'   '"), 'pw_npd_cmp_saved_by_missing'],
    ['a content hash that is not 64 hex chars is refused', save(legal(), 'not-a-sha'), 'pw_npd_cmp_bad_sha256'],
    ['a blank source file is refused', save(legal(), SHA_A, BY, "'  '"), 'pw_npd_cmp_bad_source_file'],
    [
      'a header inserted directly with a row_count that is not its counts’ sum is refused',
      `INSERT INTO public.payroll_wizard_npd_comparisons (source_file, version, saved_by, tolerance_cents, fx_rate,
         match_count, mismatch_count, not_in_hris_count, not_in_npd_count, row_count, left_out_count, npd_lines_read,
         refusal_count, hris_total_cents, npd_total_cents, paste_text, refusals, left_out, content_sha256)
       VALUES (${SOURCE}, 1, ${BY}, 3, 61.52, 1, 0, 0, 0, 2, 0, 1, 0, 0, 0, 'x', '[]', '[]', '${SHA_A}')`,
    ],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await inSavepoint('nc', () => rejects(sql));
    const ok = r.rejected && (!expect || r.message.includes(expect));
    report(ok, label, r.rejected ? (ok ? '' : `refused for another reason: ${r.message}`) : 'it was ACCEPTED');
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
      : '\nAll checks passed — HRIS vs NPD Save output is live.',
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

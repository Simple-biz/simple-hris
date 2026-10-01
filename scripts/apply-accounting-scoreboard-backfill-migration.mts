/**
 * [Accounting Scoreboard backfill]
 * Applies references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql — the
 * `accounting_scoreboard_archive` table and the `accounting_scoreboard_collection_weeks` view —
 * then verifies that both landed, that nobody but the service role can read or write them, and that
 * each guard rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-backfill-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-backfill-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-backfill-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-backfill-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. --apply
 * commits only when every check passed. Re-running --apply is safe (IF NOT EXISTS, CREATE OR
 * REPLACE VIEW, ENABLE ROW LEVEL SECURITY and REVOKE are no-ops for what exists). Every control
 * runs inside a SAVEPOINT that is rolled back, so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply AFTER references/sql/create/2026-10-01_accounting_scoreboard.sql (the view reads its log).
 * Governing doc: docs/features/accounting-scoreboard-backfill.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const ARCHIVE = 'accounting_scoreboard_archive';
const VIEW = 'accounting_scoreboard_collection_weeks';
const CONSTRAINTS = [
  'acct_sb_archive_tab_valid',
  'acct_sb_archive_row_valid',
  'acct_sb_archive_cells_array',
  'acct_sb_archive_imported_by_present',
  'acct_sb_archive_pk',
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
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}

const CHECKS: Array<[string, string]> = [
  [`${ARCHIVE} exists`, `SELECT to_regclass('public.${ARCHIVE}') IS NOT NULL AS ok`],
  [`${VIEW} exists and is a view`, `SELECT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.${VIEW}') AND relkind = 'v') AS ok`],
  [
    `${VIEW} is security_invoker`,
    `SELECT COALESCE((SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class WHERE oid = to_regclass('public.${VIEW}')), false) AS ok`,
  ],
  [
    `${ARCHIVE}: row level security is ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${ARCHIVE}')), false) AS ok`,
  ],
  [`${ARCHIVE}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${ARCHIVE}') AS ok`],
  ...[ARCHIVE, VIEW].flatMap((t) =>
    (['anon', 'authenticated'] as const).flatMap((role) =>
      (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
        `${t}: ${role} has NO ${priv} privilege`,
        `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
      ]),
    ),
  ),
  ...(['SELECT', 'INSERT', 'DELETE'] as const).map((priv): [string, string] => [
    `${ARCHIVE}: service_role HAS ${priv} (the import and the page need it)`,
    `SELECT has_table_privilege('service_role', 'public.${ARCHIVE}', '${priv}') AS ok`,
  ]),
  [`${VIEW}: service_role HAS SELECT (the board reads it)`, `SELECT has_table_privilege('service_role', 'public.${VIEW}', 'SELECT') AS ok`],
  [
    'neither is in supabase_realtime',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename IN ('${ARCHIVE}', '${VIEW}')) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [`constraint ${name}`, `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`]),
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

const archiveInsert = (tab: string, row: number, cells: string) =>
  `INSERT INTO public.${ARCHIVE} (tab, sheet_row, cells, entry_date, imported_by) VALUES ('${tab}', ${row}, '${cells}'::jsonb, NULL, ${BY})`;

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard archive + weekly collections view`,
      '',
      `  SQL : ${SQL_PATH}`,
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

  console.log('\nPositive controls (rolled back):');
  await inSavepoint('pc', async () => {
    try {
      await client.query(archiveInsert('__control__ Tab', 1, '["Date","Collections"]'));
      await client.query(archiveInsert('__control__ Tab', 2, '["12/05/2024","34/26",""]'));
      report(true, 'two archive rows, typed as text, are accepted');
      const rep = (
        await client.query<{ id: string }>(
          `INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('collections', '__control__ Rep', ${BY}) RETURNING id`,
        )
      ).rows[0].id;
      // Mon 2000-01-03 and Fri 2000-01-07 are one Sunday week (2000-01-02); the next Monday is not.
      await client.query(
        `INSERT INTO public.accounting_scoreboard_collections (entry_date, row_id, business_name, points, created_by) VALUES
           ('2000-01-03', '${rep}', '__control__ A', 1, ${BY}),
           ('2000-01-07', '${rep}', '__control__ B', 12, ${BY}),
           ('2000-01-07', '${rep}', '__control__ C', 5, ${BY}),
           ('2000-01-10', '${rep}', '__control__ D', 2, ${BY})`,
      );
      await client.query(
        `UPDATE public.accounting_scoreboard_collections SET deleted_at = now(), deleted_by = ${BY}
          WHERE row_id = '${rep}' AND business_name = '__control__ C'`,
      );
      const { rows } = await client.query<{ week_start: string; points: string; lines: string }>(
        `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, points::text, lines::text
           FROM public.${VIEW} WHERE row_id = '${rep}' ORDER BY week_start`,
      );
      const got = rows.map((r) => `${r.week_start}:${Number(r.points)}:${r.lines}`).join(' ');
      report(got === '2000-01-02:13:2 2000-01-09:2:1', 'the view sums LIVE lines per Sunday week (a deleted line drops out)', got);
    } catch (e) {
      report(false, 'the positive controls ran', (e as Error).message);
    }
  });

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string | string[], string]> = [
    ['cells that are not a JSON array are refused', archiveInsert('__control__ Tab', 1, '{"a":1}'), 'acct_sb_archive_cells_array'],
    ['sheet row 0 is refused', archiveInsert('__control__ Tab', 0, '[]'), 'acct_sb_archive_row_valid'],
    ['a tab name with surrounding spaces is refused', archiveInsert(' __control__ Tab', 1, '[]'), 'acct_sb_archive_tab_valid'],
    [
      'the same sheet row twice is refused',
      [archiveInsert('__control__ Tab', 3, '[]'), archiveInsert('__control__ Tab', 3, '[]')],
      'acct_sb_archive_pk',
    ],
    [
      'an archive row without who imported it is refused',
      `INSERT INTO public.${ARCHIVE} (tab, sheet_row, cells, imported_by) VALUES ('__control__ Tab', 4, '[]', ' ')`,
      'acct_sb_archive_imported_by_present',
    ],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await inSavepoint('nc', () => rejects(sql));
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the archive and the weekly view are live.');
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

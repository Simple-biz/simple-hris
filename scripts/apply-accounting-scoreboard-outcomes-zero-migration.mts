/**
 * [Accounting Scoreboard: win/loss flags + 0 payroll problems]
 * Applies references/sql/create/2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql:
 *   1. accounting_scoreboard_rows.outcome ('win' | 'loss' | null) on Chargeback Outcomes lines, for Carla's
 *      win ratio, with the live "Wins" and "Losses" lines flagged;
 *   2. the Payroll Problems count CHECK widened from 1–1000 to 0–1000 (Kane, 2026-10-07).
 * Then it verifies the objects, that the live outcome CHECK lists exactly OUTCOMES from sections.ts, the
 * seeded flags, that both tables are still service-role only, and that each guard refuses what it must.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts --apply   # backup, then COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. --apply first
 * writes the rows its UPDATEs touch to docs/audits/backups/ (CLAUDE.md: a bulk UPDATE needs a SELECT backup
 * on disk first), then commits only when every check passed. Every control runs inside a SAVEPOINT that is
 * rolled back, on labels starting `__control__`, so the controls write no rows even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply BEFORE the code is deployed: the board selects rows.outcome, and until the column exists every
 * board read answers "not set up yet" (server.ts isMissingTable).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
// tsx loads the .ts module as CommonJS, so a named import fails here; take the namespace off the default.
import sectionsModule from '../src/lib/accounting-scoreboard/sections';

const { OUTCOMES } = sectionsModule as unknown as typeof import('../src/lib/accounting-scoreboard/sections');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLES = ['accounting_scoreboard_rows', 'accounting_scoreboard_problems'] as const;

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
  [
    'accounting_scoreboard_rows.outcome exists, text, nullable',
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='accounting_scoreboard_rows'
       AND column_name='outcome' AND data_type='text' AND is_nullable='YES') AS ok`,
  ],
  ['constraint acct_sb_rows_outcome_valid', `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acct_sb_rows_outcome_valid') AS ok`],
  ['constraint acct_sb_prob_count_range', `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acct_sb_prob_count_range') AS ok`],
  [
    'the live "Wins" line counts as a win',
    `SELECT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE section_key = 'chargeback_outcomes'
       AND archived_at IS NULL AND label = 'Wins' AND outcome = 'win') AS ok`,
  ],
  [
    'the live "Losses" line counts as a loss',
    `SELECT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE section_key = 'chargeback_outcomes'
       AND archived_at IS NULL AND label = 'Losses' AND outcome = 'loss') AS ok`,
  ],
  [
    'Pre-arb counts as neither (it is not decided)',
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE section_key = 'chargeback_outcomes'
       AND label = 'Pre-arb' AND outcome IS NOT NULL) AS ok`,
  ],
  [
    'no line outside Chargeback Outcomes carries an outcome',
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows WHERE outcome IS NOT NULL AND section_key <> 'chargeback_outcomes') AS ok`,
  ],
  [
    'every logged problem count is still 0–1000 (no data step touched the log)',
    `SELECT NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_problems WHERE problem_count < 0 OR problem_count > 1000) AS ok`,
  ],
  [
    "the problems log's append-only trigger is still there",
    `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'acct_sb_prob_guard_update'
       AND tgrelid = to_regclass('public.accounting_scoreboard_problems') AND NOT tgisinternal) AS ok`,
  ],
  ...TABLES.map((t): [string, string] => [
    `${t}: row level security is still ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...TABLES.map((t): [string, string] => [
    `${t}: still ZERO policies (service role only)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...TABLES.flatMap((t) =>
    (['anon', 'authenticated'] as const).flatMap((role) =>
      (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
        `${t}: ${role} still has NO ${priv} privilege`,
        `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
      ]),
    ),
  ),
];

const BY = "'acct-sb-control@simple.biz'";
const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Runs `sql` inside a savepoint that is ALWAYS rolled back. Reports whether Postgres refused it, and why. */
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

/** Control fixtures in a temp table, in one statement: an outcome line, a bucket, a problems person and a type. */
const FIXTURES_SQL = `
  CREATE TEMP TABLE IF NOT EXISTS acct_sb_oz (k text primary key, id uuid) ON COMMIT DROP;
  DELETE FROM acct_sb_oz;
  WITH outcome AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('chargeback_outcomes', '__control__ Outcome', ${BY}) RETURNING id
  ), bucket AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('buckets', '__control__ Bucket', ${BY}) RETURNING id
  ), person AS (
    INSERT INTO public.accounting_scoreboard_rows (section_key, label, created_by) VALUES ('payroll_problems', '__control__ Person', ${BY}) RETURNING id
  ), ptype AS (
    INSERT INTO public.accounting_scoreboard_problem_types (label, created_by) VALUES ('__control__ Type', ${BY}) RETURNING id
  )
  INSERT INTO acct_sb_oz (k, id)
  SELECT 'outcome', id FROM outcome UNION ALL SELECT 'bucket', id FROM bucket
  UNION ALL SELECT 'person', id FROM person UNION ALL SELECT 'ptype', id FROM ptype;`;
const id = (k: string) => `(SELECT id FROM acct_sb_oz WHERE k = '${k}')`;
const problem = (count: number) =>
  `INSERT INTO public.accounting_scoreboard_problems (entry_date, row_id, type_id, problem_count, created_by)
     VALUES ('2000-01-03', ${id('person')}, ${id('ptype')}, ${count}, ${BY})`;

async function backupTouchedRows(): Promise<string> {
  const { rows } = await client.query(
    `SELECT * FROM public.accounting_scoreboard_rows
     WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL AND label IN ('Wins', 'Losses')
     ORDER BY label`,
  );
  const dir = path.join(REPO_ROOT, 'docs', 'audits', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `accounting-scoreboard-outcomes-rows-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), sql: SQL_RELATIVE, rows }, null, 2));
  return `${path.relative(REPO_ROOT, file)} (${rows.length} rows)`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: win/loss flags + 0 payroll problems`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The rows the UPDATEs change are backed up first; the SQL is COMMITTED when every check passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  if (!verifyOnly && !dryRun) console.log(`Backup: ${await backupTouchedRows()}\n`);
  await client.query('BEGIN');
  // Never queue the ALTERs behind a long board read, and never make the board wait on us for long.
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects, data and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{
    rows: Array<{ ok: boolean }>;
  }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));

  // The live CHECKs must say exactly what the code says.
  const defs = await client.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname IN ('acct_sb_rows_outcome_valid', 'acct_sb_prob_count_range')`,
  );
  const def = (name: string) => defs.rows.find((r) => r.conname === name)?.def ?? '';
  const listed = [...def('acct_sb_rows_outcome_valid').matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((v) => v !== 'chargeback_outcomes')
    .sort();
  report(
    JSON.stringify(listed) === JSON.stringify([...OUTCOMES].sort()),
    'the live outcome CHECK lists exactly OUTCOMES (sections.ts)',
    `CHECK: ${listed.join(', ') || '(none)'}`,
  );
  report(/>= 0\b/.test(def('acct_sb_prob_count_range')) && /<= 1000\b/.test(def('acct_sb_prob_count_range')), 'the problem count CHECK is 0–1000', def('acct_sb_prob_count_range'));

  console.log('\nPositive control (rolled back):');
  const positive = await attempt(`
    ${FIXTURES_SQL}
    UPDATE public.accounting_scoreboard_rows SET outcome = 'win' WHERE id = ${id('outcome')};
    UPDATE public.accounting_scoreboard_rows SET outcome = 'loss' WHERE id = ${id('outcome')};
    UPDATE public.accounting_scoreboard_rows SET outcome = NULL WHERE id = ${id('outcome')};
    ${problem(0)};
    ${problem(1000)};
  `);
  report(!positive.rejected, 'an outcome line marked win, then loss, then neither; a 0-problem line and a 1000-problem line all write', positive.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['an outcome on a non-Outcomes line is refused', `UPDATE public.accounting_scoreboard_rows SET outcome = 'win' WHERE id = ${id('bucket')}`, 'acct_sb_rows_outcome_valid'],
    ["an outcome other than win/loss is refused ('draw')", `UPDATE public.accounting_scoreboard_rows SET outcome = 'draw' WHERE id = ${id('outcome')}`, 'acct_sb_rows_outcome_valid'],
    ["a label as the outcome is refused ('Wins')", `UPDATE public.accounting_scoreboard_rows SET outcome = 'Wins' WHERE id = ${id('outcome')}`, 'acct_sb_rows_outcome_valid'],
    ['a negative problem count is refused', problem(-1), 'acct_sb_prob_count_range'],
    ['more than 1000 problems on one line is refused', problem(1001), 'acct_sb_prob_count_range'],
    [
      'the problems log is STILL append-only (editing a 0 line is refused)',
      `${problem(0)}; UPDATE public.accounting_scoreboard_problems SET problem_count = 3 WHERE row_id = ${id('person')}`,
      'acct_sb_prob_append_only',
    ],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await attempt(`${FIXTURES_SQL}\n${sql};`);
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — win/loss flags and 0 payroll problems are live.');
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

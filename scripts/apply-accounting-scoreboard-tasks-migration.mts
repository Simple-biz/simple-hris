/**
 * [Accounting Scoreboard: per-person task boards]  2026-10-08, Open item 393 (plan Task 7)
 * Applies references/sql/create/2026-10-08_accounting_scoreboard_tasks.sql.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts            # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts --dry      # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts --apply
 *   node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts --verify
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The migration creates two
 * empty tables and writes no data, so there is nothing to back up. Every control runs inside a SAVEPOINT that is
 * rolled back, so the controls write nothing even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * The board read (readBoard) never touches these tables: until they exist only the Tasks view says "not set up yet".
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-08_accounting_scoreboard_tasks.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TASKS = 'accounting_scoreboard_tasks';
const CHECKS_T = 'accounting_scoreboard_task_checks';

const argv = process.argv.slice(2);
const wantVerify = argv.includes('--verify');
const wantApply = argv.includes('--apply');
const wantDry = argv.includes('--dry');
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

const tableChecks = (t: string, columns: string[], guard: string): Array<[string, string]> => [
  [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`],
  [
    `${t} has its ${columns.length} columns`,
    `SELECT count(*) = ${columns.length} AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'
       AND column_name IN (${columns.map((c) => `'${c}'`).join(',')})`,
  ],
  [`${t}: the ${guard} trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${t}') AND tgname='${guard}' AND NOT tgisinternal) AS ok`],
  [`${t}: row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`],
  [`${t}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${t}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${t}: anon and authenticated cannot EXECUTE ${guard}()`,
    `SELECT NOT has_function_privilege('anon', 'public.${guard}()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.${guard}()', 'EXECUTE') AS ok`,
  ],
  [`${t}: not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${t}') AS ok`],
];

const CHECKS: Array<[string, string]> = [
  ...tableChecks(TASKS, ['id', 'owner_email', 'title', 'frequency', 'sort_order', 'created_by', 'created_at', 'archived_by', 'archived_at'], 'acct_sb_tasks_guard'),
  ...tableChecks(CHECKS_T, ['id', 'task_id', 'period_key', 'checked_by', 'checked_at', 'unchecked_by', 'unchecked_at'], 'acct_sb_task_checks_guard'),
  [`one live tick per task per period (acct_sb_task_checks_one_live)`, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${CHECKS_T}' AND indexname='acct_sb_task_checks_one_live') AS ok`],
];

const OWNER = "'acct-sb-control@simple.biz'";
const BY = "'acct-sb-control@simple.biz'";
/** A control task, created inside the savepoint. */
const NEW_TASK = (freq: string) =>
  `INSERT INTO public.${TASKS} (owner_email, title, frequency, created_by) VALUES (${OWNER}, 'Control task', '${freq}', ${BY})`;

const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Runs `sql` inside a savepoint that is ALWAYS rolled back. Reports whether Postgres refused it, how, and why. */
async function attempt(sql: string): Promise<{ rejected: boolean; code: string; message: string; rows: unknown[] }> {
  let result: { rejected: boolean; code: string; message: string; rows: unknown[] };
  try {
    const res = (await client.query(`SAVEPOINT ctl; ${sql}`)) as unknown;
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    result = { rejected: false, code: '', message: '', rows: (last as { rows?: unknown[] })?.rows ?? [] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    result = { rejected: true, code: err.code ?? '', message: err.message ?? String(e), rows: [] };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl; RELEASE SAVEPOINT ctl;');
  return result;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: per-person task boards`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check passes. It creates two empty tables; no data is written.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{ rows: Array<{ ok: boolean }> }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));
  const counts = await client.query<{ tasks: number; ticks: number }>(
    `SELECT (SELECT count(*)::int FROM public.${TASKS}) AS tasks, (SELECT count(*)::int FROM public.${CHECKS_T}) AS ticks`,
  );
  console.log(`  ....  rows: ${counts.rows[0]?.tasks} task(s), ${counts.rows[0]?.ticks} tick(s)`);

  console.log("\nThe board's own reads (server.ts):");
  const read = await attempt(
    `SELECT id, owner_email, title, frequency, sort_order, created_at FROM public.${TASKS} WHERE archived_at IS NULL AND owner_email IN ('carla@simple.biz') ORDER BY sort_order, created_at, id LIMIT 1;`,
  );
  report(!read.rejected, `${TASKS}: the board's task select answers`, read.message);
  const ticks = await attempt(
    `SELECT task_id, period_key, checked_by, checked_at FROM public.${CHECKS_T} WHERE unchecked_at IS NULL AND period_key IN ('2026-10-08') ORDER BY id LIMIT 1;`,
  );
  report(!ticks.rejected, `${CHECKS_T}: the board's tick select answers`, ticks.message);

  console.log('\nThe anon role is refused (42501; rolled back):');
  for (const t of [TASKS, CHECKS_T]) {
    const anon = await attempt(`SET LOCAL ROLE anon; SELECT id FROM public.${t} LIMIT 1;`);
    report(anon.rejected && anon.code === '42501', `anon SELECT on ${t} is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');
  }

  console.log('\nPositive controls (rolled back):');
  const life = await attempt(`
    ${NEW_TASK('daily')};
    UPDATE public.${TASKS} SET title = 'Control task, renamed', sort_order = 5 WHERE owner_email = ${OWNER};
    INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by) SELECT id, '2026-10-08', ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};
    UPDATE public.${CHECKS_T} SET unchecked_at = now(), unchecked_by = ${BY} WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER});
    INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by) SELECT id, '2026-10-08', ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};
    UPDATE public.${TASKS} SET archived_at = now(), archived_by = ${BY} WHERE owner_email = ${OWNER};
    SELECT (SELECT count(*)::int FROM public.${CHECKS_T} WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER})) AS n;
  `);
  report(
    !life.rejected && (life.rows[0] as { n?: number } | undefined)?.n === 2,
    'create → rename + reorder → tick → uncheck → tick again (history kept) → archive',
    life.message,
  );
  const nextPeriod = await attempt(`
    ${NEW_TASK('weekly')};
    INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by) SELECT id, '2026-10-04', ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};
    INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by) SELECT id, '2026-10-11', ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};
    SELECT 1 AS ok;
  `);
  report(!nextPeriod.rejected, 'one live tick in each of two periods for the same task', nextPeriod.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const tick = (period = '2026-10-08') =>
    `INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by) SELECT id, '${period}', ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};`;
  const NEGATIVE: Array<[string, string, string]> = [
    ['a task DELETE is refused (archived, never deleted)', `${NEW_TASK('daily')}; DELETE FROM public.${TASKS} WHERE owner_email = ${OWNER};`, '23514'],
    ["changing a task's owner in place is refused", `${NEW_TASK('daily')}; UPDATE public.${TASKS} SET owner_email = 'someone@simple.biz' WHERE owner_email = ${OWNER};`, '23514'],
    ["changing a task's frequency in place is refused (a new frequency is a new task)", `${NEW_TASK('daily')}; UPDATE public.${TASKS} SET frequency = 'weekly' WHERE owner_email = ${OWNER};`, '23514'],
    ['editing an archived task is refused (archive is final)', `${NEW_TASK('daily')}; UPDATE public.${TASKS} SET archived_at = now(), archived_by = ${BY} WHERE owner_email = ${OWNER}; UPDATE public.${TASKS} SET title = 'Back again' WHERE owner_email = ${OWNER};`, '23514'],
    ['a task created already archived is refused', `INSERT INTO public.${TASKS} (owner_email, title, frequency, created_by, archived_at, archived_by) VALUES (${OWNER}, 'Control task', 'daily', ${BY}, now(), ${BY});`, '23514'],
    ['a frequency outside the eight is refused', `${NEW_TASK('hourly')};`, '23514'],
    ['an owner that is not a lower-case, trimmed address is refused', `INSERT INTO public.${TASKS} (owner_email, title, frequency, created_by) VALUES (' Acct-SB-Control@simple.biz', 'Control task', 'daily', ${BY});`, '23514'],
    ['a blank title is refused', `INSERT INTO public.${TASKS} (owner_email, title, frequency, created_by) VALUES (${OWNER}, '   ', 'daily', ${BY});`, '23514'],
    ['an archive stamp without who archived it is refused', `${NEW_TASK('daily')}; UPDATE public.${TASKS} SET archived_at = now() WHERE owner_email = ${OWNER};`, '23514'],
    ['ticking an as-needed task is refused (listed, never counted)', `${NEW_TASK('as_needed')}; ${tick()}`, '23514'],
    ['ticking an archived task is refused', `${NEW_TASK('daily')}; UPDATE public.${TASKS} SET archived_at = now(), archived_by = ${BY} WHERE owner_email = ${OWNER}; ${tick()}`, '23514'],
    ['a second LIVE tick for the same task and period is refused', `${NEW_TASK('daily')}; ${tick()} ${tick()}`, '23505'],
    ['a tick DELETE is refused (unchecked, never deleted)', `${NEW_TASK('daily')}; ${tick()} DELETE FROM public.${CHECKS_T} WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER});`, '23514'],
    ['unchecking twice is refused (the stamp is final)', `${NEW_TASK('daily')}; ${tick()} UPDATE public.${CHECKS_T} SET unchecked_at = now(), unchecked_by = ${BY} WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER}); UPDATE public.${CHECKS_T} SET unchecked_at = now(), unchecked_by = 'someone@simple.biz' WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER});`, '23514'],
    ["moving a tick to another period is refused", `${NEW_TASK('daily')}; ${tick()} UPDATE public.${CHECKS_T} SET period_key = '2026-10-09' WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER});`, '23514'],
    ['an uncheck without who unchecked it is refused', `${NEW_TASK('daily')}; ${tick()} UPDATE public.${CHECKS_T} SET unchecked_at = now() WHERE task_id IN (SELECT id FROM public.${TASKS} WHERE owner_email = ${OWNER});`, '23514'],
    ['a tick created already unchecked is refused', `${NEW_TASK('daily')}; INSERT INTO public.${CHECKS_T} (task_id, period_key, checked_by, unchecked_at, unchecked_by) SELECT id, '2026-10-08', ${BY}, now(), ${BY} FROM public.${TASKS} WHERE owner_email = ${OWNER};`, '23514'],
  ];
  for (const [label, sql, code] of NEGATIVE) {
    const r = await attempt(sql);
    const ok = r.rejected && r.code === code;
    report(ok, label, r.rejected ? (ok ? '' : `refused for another reason: ${r.code} ${r.message}`) : 'it was ACCEPTED');
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the task tables are live. Deploy the code now.');
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

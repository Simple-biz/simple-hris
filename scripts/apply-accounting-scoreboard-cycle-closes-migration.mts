/**
 * [Accounting Scoreboard: a pay cycle's close set by hand, for Payroll Timing]  2026-10-09, Open item 437
 * Applies references/sql/create/2026-10-09_accounting_scoreboard_cycle_closes.sql.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-cycle-closes-migration.mts            # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-cycle-closes-migration.mts --dry      # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-cycle-closes-migration.mts --apply
 *   node --import tsx scripts/apply-accounting-scoreboard-cycle-closes-migration.mts --verify
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The migration creates one
 * new table and inserts ONE row (Kane's ruled close for Sep 27 – Oct 3), so nothing existing is changed and there is
 * nothing to back up. It never touches audit_log. Every control runs inside a SAVEPOINT that is rolled back.
 *
 * The board read (readBoard) and the History read select this table: apply it BEFORE the code is pushed, or every
 * board read answers 503 "not set up yet".
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Payroll Timing fills itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
// tsx loads the .ts modules as CommonJS, so a named import fails here; take the namespace off the default.
import cycleModule from '../src/lib/accounting-scoreboard/payroll-cycle';
import weekModule from '../src/lib/accounting-scoreboard/week';

const { PAYROLL_EVENT_ACTIONS, cycleWeek, firstClosedPeriodEnd, payrollEventsFrom } =
  cycleModule as unknown as typeof import('../src/lib/accounting-scoreboard/payroll-cycle');
const { formatEasternDateTime } = weekModule as unknown as typeof import('../src/lib/accounting-scoreboard/week');
type PayrollAuditRow = import('../src/lib/accounting-scoreboard/payroll-cycle').PayrollAuditRow;
type CycleCloseRecord = import('../src/lib/accounting-scoreboard/payroll-cycle').CycleCloseRecord;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-09_accounting_scoreboard_cycle_closes.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const T = 'accounting_scoreboard_cycle_closes';
const GUARD = 'acct_sb_cycle_closes_guard';
/** The ruled close the migration seeds (item 437). */
const RULED = { cycleStart: '2026-09-27', processingWeek: '2026-10-04', closedAt: '2026-10-09T15:55:00.000Z' } as const;

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

const COLUMNS = ['id', 'cycle_start', 'closed_at', 'reason', 'set_by', 'set_at'];
const CHECKS: Array<[string, string]> = [
  [`${T} exists`, `SELECT to_regclass('public.${T}') IS NOT NULL AS ok`],
  [
    `${T} has its ${COLUMNS.length} columns`,
    `SELECT count(*) = ${COLUMNS.length} AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${T}'
       AND column_name IN (${COLUMNS.map((c) => `'${c}'`).join(',')})`,
  ],
  [`${T}: the ${GUARD} trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${T}') AND tgname='${GUARD}' AND NOT tgisinternal) AS ok`],
  [`${T}: the acct_sb_cycle_closes_cycle index exists`, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${T}' AND indexname='acct_sb_cycle_closes_cycle') AS ok`],
  [`${T}: row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${T}')), false) AS ok`],
  [`${T}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${T}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${T}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${T}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${T}: anon and authenticated cannot EXECUTE ${GUARD}()`,
    `SELECT NOT has_function_privilege('anon', 'public.${GUARD}()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.${GUARD}()', 'EXECUTE') AS ok`,
  ],
  [`${T}: not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${T}') AS ok`],
];

const BY = "'acct-sb-control@simple.biz'";
const insert = (cycle: string, closedAt: string, reason = "'Control'", by = BY, setAt = 'now()') =>
  `INSERT INTO public.${T} (cycle_start, closed_at, reason, set_by, set_at) VALUES (DATE '${cycle}', ${closedAt}, ${reason}, ${by}, ${setAt});`;

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

/** Payroll Timing for the ruled week, through the board's own functions and both of its sources. */
async function boardReading() {
  const audit = await client.query<PayrollAuditRow>(
    `SELECT action, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, resource_id,
            details->>'source_file' AS src, details->'cycle'->>'source_file' AS csrc, details->'cycle'->>'period_start' AS cps
       FROM public.audit_log WHERE action = ANY($1::text[]) AND created_at >= '2026-09-13T04:00:00Z' ORDER BY created_at, id`,
    [[...PAYROLL_EVENT_ACTIONS]],
  );
  const closes = await client.query<Pick<PayrollAuditRow, 'src' | 'resource_id'>>(
    `SELECT resource_id, details->>'source_file' AS src FROM public.audit_log WHERE action = 'payment_cycle.closed'`,
  );
  const hand = await client.query<CycleCloseRecord>(
    `SELECT cycle_start::text AS cycle_start,
            to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at, set_by, reason,
            to_char(set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS set_at
       FROM public.${T} ORDER BY set_at, id`,
  );
  const events = payrollEventsFrom(audit.rows, hand.rows);
  return cycleWeek(events, RULED.processingWeek, new Date().toISOString(), firstClosedPeriodEnd(closes.rows));
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: Payroll Timing closes set by hand`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check passes. It creates one table and inserts the one ruled close.',
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

  console.log("\nThe board's own read (server.ts readBoard + the History read):");
  const read = await attempt(`SELECT cycle_start, closed_at, set_by, reason, set_at FROM public.${T} ORDER BY set_at, id LIMIT 1;`);
  report(!read.rejected, `${T}: the board's select answers`, read.message);

  console.log('\nThe anon role is refused (42501; rolled back):');
  const anon = await attempt(`SET LOCAL ROLE anon; SELECT id FROM public.${T} LIMIT 1;`);
  report(anon.rejected && anon.code === '42501', `anon SELECT on ${T} is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');

  if (!verifyOnly) {
    // A check of what the DATA STEP did runs on dry/apply only (item 399): a later hand-set row is normal use.
    console.log('\nThe ruled close (data step):');
    const seeded = await client.query<{ n: number; ok: boolean }>(
      `SELECT count(*)::int AS n, bool_and(closed_at = $2::timestamptz AND set_by = 'kaner@simple.biz') AS ok
         FROM public.${T} WHERE cycle_start = $1::date`,
      [RULED.cycleStart, RULED.closedAt],
    );
    report(seeded.rows[0]?.n === 1 && seeded.rows[0]?.ok === true, `one row for the Sep 27 – Oct 3 cycle: closed ${formatEasternDateTime(RULED.closedAt)} ET, set by kaner@`);
  }

  console.log('\nWhat the board will show for Sep 27 – Oct 3 (its own functions, both sources):');
  const w = await boardReading();
  console.log(
    `  ....  started ${w.startedAt ? formatEasternDateTime(w.startedAt) : '—'} (${w.start}) · closed ${w.closedAt ? formatEasternDateTime(w.closedAt) : '—'} (${w.close})` +
      `${w.closeSetByHand ? ' · from the hand-set row' : ''}${w.reopened ? ' · REOPENED' : ''} · score ${w.score ?? '—'}`,
  );
  report(w.closedAt === RULED.closedAt && w.close === 'on_time' && w.closeSetByHand !== null && !w.reopened, 'closed 11:55 AM ET, on time, flagged closeSetByHand in the data');

  console.log('\nPositive controls (rolled back):');
  const life = await attempt(`
    ${insert('2026-09-20', "'2026-10-02 11:00:00-04'")}
    ${insert('2026-09-20', 'NULL')}
    SELECT count(*)::int AS n FROM public.${T} WHERE set_by = ${BY};
  `);
  report(!life.rejected && (life.rows[0] as { n?: number } | undefined)?.n === 2, 'set a time, then clear it with a new row (both kept)', life.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['an UPDATE is refused (append-only)', `${insert('2026-09-20', "'2026-10-02 11:00:00-04'")} UPDATE public.${T} SET closed_at = now() WHERE set_by = ${BY};`, '23514'],
    ['a DELETE is refused (append-only)', `${insert('2026-09-20', "'2026-10-02 11:00:00-04'")} DELETE FROM public.${T} WHERE set_by = ${BY};`, '23514'],
    ['a cycle that is not a Sunday is refused', insert('2026-09-21', "'2026-10-02 11:00:00-04'"), '23514'],
    ['a close before the paid week ended is refused', insert('2026-09-20', "'2026-09-26 23:59:00-04'"), '23514'],
    ['a close in the future is refused', insert('2026-09-20', "now() + interval '1 hour'"), '23514'],
    ['a blank reason is refused', insert('2026-09-20', "'2026-10-02 11:00:00-04'", "'   '"), '23514'],
    ['a setter that is not a lower-case address is refused', insert('2026-09-20', "'2026-10-02 11:00:00-04'", "'Control'", "'Kane@simple.biz'"), '23514'],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the table is live with the ruled close. Push the code now.');
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

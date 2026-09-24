/**
 * [GIFT-ORDERS]
 * Applies references/sql/create/2026-09-23_gift_orders.sql — the two tables and
 * three functions (lock, reopen, delete) behind Gift Tracker → Orders — then verifies they landed, that
 * RLS is on with no policies, that neither table joined supabase_realtime, that
 * anon/authenticated cannot EXECUTE the functions, and that the double-invoice
 * guard actually bites.
 *
 *   node --import tsx scripts/apply-gift-orders-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-gift-orders-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-gift-orders-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-gift-orders-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always
 * rolled back. Needs DATABASE_URL (the SESSION POOLER) in .env.local — see
 * scripts/apply-employee-support-migration.mts for the format.
 *
 * Run order does NOT matter: GET /api/gift-orders answers `migrated: false`
 * while the tables are absent, and the Orders tab says so instead of erroring.
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

const SQL_RELATIVE = 'references/sql/create/2026-09-23_gift_orders.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

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
  console.error('DATABASE_URL is not set — add the SESSION POOLER URI to .env.local.');
  process.exit(1);
}

const TABLES = ['gift_orders', 'gift_order_lines'];
const FUNCS = [
  'public.gift_order_lock(text, bigint, jsonb, jsonb)',
  'public.gift_order_reopen(uuid, text, text)',
  'public.gift_order_delete(uuid)',
];

const CHECKS: Array<[string, string]> = [
  ...TABLES.map((t): [string, string] => [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`]),
  ...TABLES.map((t): [string, string] => [
    `${t} has row level security ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`,
  ]),
  ...TABLES.map((t): [string, string] => [
    `${t} has NO policies`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  ...TABLES.map((t): [string, string] => [
    `${t} is NOT in supabase_realtime`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${t}') AS ok`,
  ]),
  [
    'the one-live-order guard is a PARTIAL unique index on (submission_id, item)',
    `SELECT COALESCE((SELECT indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%released_at IS NULL%'
       FROM pg_indexes WHERE schemaname='public' AND indexname='gift_order_lines_one_live_order'), false) AS ok`,
  ],
  ...FUNCS.flatMap((f): Array<[string, string]> => [
    [`${f} exists`, `SELECT to_regprocedure('${f}') IS NOT NULL AS ok`],
    [
      `anon CANNOT execute ${f}`,
      `SELECT NOT has_function_privilege('anon', to_regprocedure('${f}'), 'EXECUTE') AS ok`,
    ],
    [
      `authenticated CANNOT execute ${f}`,
      `SELECT NOT has_function_privilege('authenticated', to_regprocedure('${f}'), 'EXECUTE') AS ok`,
    ],
  ]),
];

const client = new Client({ connectionString });

/** Runs inside a savepoint; returns the error text ('' = succeeded). */
async function attempt(sql: string, params: unknown[] = []): Promise<{ err: string; rows: Record<string, unknown>[] }> {
  await client.query('SAVEPOINT ctl');
  try {
    const { rows } = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT ctl');
    return { err: '', rows };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT ctl');
    await client.query('RELEASE SAVEPOINT ctl');
    return { err: (e as Error).message, rows: [] };
  }
}

async function main() {
  console.log(
    `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Gift Orders\n\n  SQL : ${SQL_PATH}\n` +
      (verifyOnly
        ? '  Nothing is written.\n'
        : dryRun
          ? '  Runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.\n'
          : '  Will be COMMITTED to the database DATABASE_URL points at.\n'),
  );
  await client.connect();

  if (dryRun) {
    await client.query('BEGIN');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    console.log('  applied.\n');
  }

  let failed = 0;
  console.log('Verifying objects:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  // Behavioural controls, all inside one rolled-back transaction. They need a
  // real approved submission to point at; a synthetic one is inserted and
  // discarded with everything else.
  console.log('\nVerifying the guards bite (rolled back):');
  if (!dryRun) await client.query('BEGIN');
  const sub = await attempt(
    `INSERT INTO public.employee_gift_shipping_details
       (personal_email, milestone_index, milestone_date, status)
     VALUES ('control.gift-orders@example.invalid', 1, current_date, 'approved')
     RETURNING id`,
  );
  if (sub.err) {
    console.log(`  SKIP  behavioural controls — could not stage a control submission: ${sub.err}`);
  } else {
    const sid = sub.rows[0].id as string;
    const line = (unit: number) =>
      JSON.stringify([
        { submission_id: sid, personal_email: 'control.gift-orders@example.invalid', milestone_index: 1, item: 'Tshirt', size: 'M', unit_centavos: unit, qty: 1 },
      ]);
    const lockSql = `SELECT * FROM public.gift_order_lock('control@simple.biz', $1, '{}'::jsonb, $2::jsonb)`;

    const ok1 = await attempt(lockSql, [43000, line(43000)]);
    const report = (label: string, pass: boolean, why = '') => {
      if (!pass) failed++;
      console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${label}${pass ? '' : why}`);
    };
    report('a legal lock is ACCEPTED (positive control)', !ok1.err, ` — ${ok1.err}`);
    const dup = await attempt(lockSql, [43000, line(43000)]);
    report('locking the SAME gift twice is REJECTED', dup.err !== '', ' — accepted a double invoice');
    const bad = await attempt(lockSql, [99, line(43000)]);
    report('a total that disagrees with its lines is REJECTED', bad.err !== '', ' — accepted');
    const zero = await attempt(lockSql, [0, line(0)]);
    report('a ₱0 line is REJECTED', zero.err !== '', ' — accepted');
    const empty = await attempt(lockSql, [0, '[]']);
    report('an empty order is REJECTED', empty.err !== '', ' — accepted');

    if (!ok1.err) {
      const oid = ok1.rows[0].id as string;
      const re = await attempt(`SELECT public.gift_order_reopen($1, 'control@simple.biz', 'control')`, [oid]);
      report('reopening a locked order is ACCEPTED', !re.err, ` — ${re.err}`);
      const again = await attempt(lockSql, [43000, line(43000)]);
      report('after a reopen the gift can be locked AGAIN', !again.err, ` — ${again.err}`);
      const twice = await attempt(`SELECT public.gift_order_reopen($1, 'control@simple.biz', null)`, [oid]);
      report('reopening an already-reopened order is REJECTED', twice.err !== '', ' — accepted');
      const kept = await attempt(`SELECT count(*)::int AS n FROM public.gift_orders WHERE id = $1`, [oid]);
      report('the reopened invoice is KEPT, not deleted', kept.rows[0]?.n === 1);
    }
    // Delete: the live order from the re-lock above is removed with its lines,
    // and the gift is free again.
    const live = await attempt(
      `SELECT order_id FROM public.gift_order_lines WHERE submission_id = $1 AND released_at IS NULL LIMIT 1`,
      [sid],
    );
    const liveId = live.rows[0]?.order_id as string | undefined;
    if (liveId) {
      const del = await attempt(`SELECT public.gift_order_delete($1)`, [liveId]);
      report('deleting an order is ACCEPTED', !del.err, ` — ${del.err}`);
      const gone = await attempt(
        `SELECT (SELECT count(*) FROM public.gift_orders WHERE id = $1)
              + (SELECT count(*) FROM public.gift_order_lines WHERE order_id = $1) AS n`,
        [liveId],
      );
      report('the deleted order AND its lines are gone', Number(gone.rows[0]?.n) === 0);
      const relock = await attempt(lockSql, [43000, line(43000)]);
      report('after a delete the gift can be locked again', !relock.err, ` — ${relock.err}`);
    } else {
      report('a live order existed to delete', false, ' — none found');
    }
    const missingDel = await attempt(`SELECT public.gift_order_delete(gen_random_uuid())`);
    report('deleting an order that does not exist is REJECTED', missingDel.err !== '', ' — accepted');

    await attempt(`UPDATE public.employee_gift_shipping_details SET status='pending' WHERE id=$1`, [sid]);
    const notApproved = await attempt(lockSql, [43000, line(43000)]);
    report('a submission that is no longer approved is REJECTED', notApproved.err !== '', ' — accepted');
  }
  await client.query('ROLLBACK');
  await client.end();

  console.log(
    failed === 0
      ? `\nAll checks passed.${dryRun ? ' Nothing was committed — re-run with --apply.' : ''}`
      : `\n${failed} check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nFailed:', (e as Error).message);
  try {
    await client.query('ROLLBACK');
  } catch {
    /* connection may already be gone */
  }
  await client.end().catch(() => {});
  process.exit(1);
});

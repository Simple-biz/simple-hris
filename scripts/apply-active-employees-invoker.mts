/**
 * [SECURITY-ADVISOR-VIEW]
 * Applies references/sql/alter/2026-09-29_active_employees_security_invoker.sql:
 * public.active_employees runs as the CALLER (security_invoker = true), closing
 * the Supabase Advisor's "Security Definer View" error. Kane's (b), 2026-09-29.
 *
 * The 2026-08-03 incident is the reason this checks more than reloptions. An
 * invoker view that reads a table the caller cannot see returns a SILENT EMPTY
 * set with HTTP 200, so the proof is a per-role count, not a flag:
 *   1. catalog: security_invoker=true, the view reads ONLY global_master_list,
 *      and no view in `public` is left running as its owner;
 *   2. as anon, authenticated and service_role, in a transaction that is always
 *      rolled back: the view shows each role exactly what
 *      global_master_list WHERE off_boarded_at IS NULL shows it (fewer rows =
 *      the silent empty, more rows = a lockdown bypass), `SELECT *` reads every
 *      column, and the roster is not empty;
 *   3. over PostgREST with the real keys (after --apply / --verify only): the
 *      same equality for the anon key and the service key.
 *
 *   node --import tsx scripts/apply-active-employees-invoker.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-active-employees-invoker.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-active-employees-invoker.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-active-employees-invoker.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run, inside a transaction that is always
 * rolled back. No row is ever written. The long-running regression guard is
 * scripts/verify-active-employees-roster.mjs (check 4), which needs no DATABASE_URL.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url). An `@` in the password MUST be %40.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const SQL_RELATIVE = 'references/sql/alter/2026-09-29_active_employees_security_invoker.sql';
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

const VIEW_COUNT = 'SELECT count(*)::int AS n FROM public.active_employees';
const BASE_COUNT = 'SELECT count(*)::int AS n FROM public.global_master_list WHERE off_boarded_at IS NULL';
/** The active roster was 1,270 on 2026-09-29. Well under that catches "blank". */
const MIN_ROSTER = 500;

const CHECKS: Array<[string, string]> = [
  ['active_employees exists', `SELECT to_regclass('public.active_employees') IS NOT NULL AS ok`],
  [
    'active_employees is security_invoker = true',
    `SELECT COALESCE((SELECT c.reloptions::text LIKE '%security_invoker=true%'
       FROM pg_class c WHERE c.oid = to_regclass('public.active_employees')), false) AS ok`,
  ],
  // The half of the 2026-08-03 rule a catalog can check: a second table is
  // what made the view go silently empty.
  [
    'active_employees reads ONLY global_master_list',
    `SELECT NOT EXISTS (
       SELECT 1 FROM pg_rewrite r
       JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                       AND d.refclassid = 'pg_class'::regclass
       WHERE r.ev_class = 'public.active_employees'::regclass
         AND d.refobjid <> r.ev_class
         AND d.refobjid <> 'public.global_master_list'::regclass) AS ok`,
  ],
  // The Advisor's own condition, across the schema.
  [
    'no view in public runs as its owner (security definer)',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v'
         AND NOT COALESCE(c.reloptions::text LIKE '%security_invoker=true%', false)) AS ok`,
  ],
];

const client = new Client({ connectionString });
let failed = 0;
const report = (ok: boolean, label: string, why = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
};

/** Run `fn` as `role` inside a savepoint that is always rolled back. */
async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await client.query('SAVEPOINT r');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT r');
    await client.query('RELEASE SAVEPOINT r');
  }
}

async function one(sql: string): Promise<number> {
  const { rows } = await client.query(sql);
  return rows[0].n as number;
}

function equality(label: string, view: number, base: number) {
  const why =
    view === base
      ? ` (${view})`
      : view < base
        ? ` — view ${view} < base ${base}: SILENT EMPTY, the view reads something this role cannot see`
        : ` — view ${view} > base ${base}: BYPASS, the view shows more than this role may read`;
  report(view === base, label, why);
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — active_employees as security_invoker`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the view is only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL will be COMMITTED to the database DATABASE_URL points at.',
      '',
    ].join('\n'),
  );

  await client.connect();
  // ALTER VIEW takes an ACCESS EXCLUSIVE lock on a view ~40 routes read. Never
  // queue behind a long reader and stall the app behind us.
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '30s'");

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

  console.log('Catalog:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    report(rows[0]?.ok === true, label);
  }

  console.log('\nAs each role (always rolled back):');
  if (!dryRun) await client.query('BEGIN');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const { view, base, allColumns } = await asRole(role, async () => ({
      view: await one(VIEW_COUNT),
      base: await one(BASE_COUNT),
      // Column-level grants fail loud (42501) rather than empty; prove none bite.
      allColumns: await one('SELECT count(*)::int AS n FROM (SELECT * FROM public.active_employees) x'),
    }));
    equality(`${role}: the view shows exactly what global_master_list shows`, view, base);
    report(allColumns === view, `${role}: SELECT * reads every column`);
    if (role === 'service_role') {
      report(view >= MIN_ROSTER, `service_role: the roster is not blank (>= ${MIN_ROSTER})`, ` (${view})`);
    }
  }
  await client.query('ROLLBACK');
  if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
  await client.end();

  if (!dryRun) {
    console.log('\nOver PostgREST, with the real keys:');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !anonKey || !svcKey) {
      report(false, 'NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are all needed');
    } else {
      for (const [label, key] of [
        ['anon key', anonKey],
        ['service key', svcKey],
      ]) {
        const sb = createClient(url, key, { auth: { persistSession: false } });
        const v = await sb.from('active_employees').select('*', { count: 'exact', head: true });
        const b = await sb
          .from('global_master_list')
          .select('*', { count: 'exact', head: true })
          .is('off_boarded_at', null);
        // An error or a null count is not a zero (memory postgrest-head-true-hides-missing-table).
        if (v.error || b.error || v.count == null || b.count == null) {
          report(false, `${label}: counts did not resolve`, ` — ${v.error?.code ?? b.error?.code ?? 'null count'}`);
        } else {
          equality(`${label}: the view shows exactly what global_master_list shows`, v.count, b.count);
        }
      }
    }
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log(dryRun || verifyOnly ? '\nAll checks passed.' : '\nAll checks passed — active_employees runs as the caller.');
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

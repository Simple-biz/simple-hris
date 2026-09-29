/**
 * [SECURITY-ADVISOR-RLS]
 * Applies references/sql/alter/2026-09-29_enable_rls_advisor_tables.sql: row
 * level security ON, zero policies, for the three `public` tables the Supabase
 * Advisor flagged "RLS Disabled in Public" on 2026-09-29:
 *
 *   penny_employee_usage · bonus_catalog_bonus_history · bonus_catalog_assignment_history
 *
 * Then it proves the lock three ways:
 *   1. the catalog: relrowsecurity on, 0 policies, and NO table in `public` left
 *      with RLS off (the Advisor's own condition, so a new open table fails here);
 *   2. as each role, in a transaction that is always rolled back: service_role
 *      still reads every row (the app's path), anon and authenticated read 0,
 *      the planner reduces their UPDATE and DELETE to `One-Time Filter: false`,
 *      and an anon INSERT is refused;
 *   3. over PostgREST with the real keys (after --apply / --verify only): the
 *      public anon key reads 0 rows, the service key reads them all.
 *
 *   node --import tsx scripts/apply-rls-advisor-tables.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-rls-advisor-tables.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-rls-advisor-tables.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-rls-advisor-tables.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The ENABLE lines run inside a
 * transaction that is always rolled back, so production is left as it was.
 * No row is ever changed. The only write attempted is the anon INSERT
 * negative control, inside a savepoint that is always rolled back.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * An `@` in the password MUST be percent-encoded as %40.
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

const SQL_RELATIVE = 'references/sql/alter/2026-09-29_enable_rls_advisor_tables.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLES = [
  'penny_employee_usage',
  'bonus_catalog_bonus_history',
  'bonus_catalog_assignment_history',
] as const;
type Table = (typeof TABLES)[number];

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
  ...TABLES.flatMap((t): Array<[string, string]> => [
    [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`],
    [
      `${t}: row level security is ENABLED`,
      `SELECT COALESCE((SELECT relrowsecurity FROM pg_class
         WHERE oid = to_regclass('public.${t}')), false) AS ok`,
    ],
    // A policy re-opens the table to whichever role it names. Every reader is
    // the service role, which needs none.
    [
      `${t}: ZERO policies (service role only)`,
      `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = '${t}') AS ok`,
    ],
  ]),
  // The Advisor's own condition. Fails the day someone creates a public table
  // without an ENABLE line, which is how all three of these got here.
  [
    'no table in public has RLS off',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity) AS ok`,
  ],
];

/** A legal row per table, so a refused INSERT is refused by RLS and not by a constraint. */
function legalInsert(t: Table, bonusId: string | null): string | null {
  switch (t) {
    case 'penny_employee_usage':
      return `INSERT INTO public.penny_employee_usage (session_email, subject_email, manila_day)
              VALUES ('rls-control@simple.biz', 'rls-control@simple.biz', current_date)`;
    case 'bonus_catalog_bonus_history':
      if (!bonusId) return null;
      return `INSERT INTO public.bonus_catalog_bonus_history (bonus_id, version, name, kind, effective_from)
              VALUES ('${bonusId.replace(/'/g, "''")}', 2147483000, 'rls-control', 'flat', current_date)`;
    case 'bonus_catalog_assignment_history':
      if (!bonusId) return null;
      return `INSERT INTO public.bonus_catalog_assignment_history
                (bonus_id, assignment_id, event, scope, department_key, effective_from)
              VALUES ('${bonusId.replace(/'/g, "''")}', 'rls-control', 'added', 'department', 'rls-control', current_date)`;
  }
}

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

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — RLS on the Advisor's three public tables`,
      '',
      `  SQL    : ${SQL_PATH}`,
      `  Tables : ${TABLES.join(', ')}`,
      '',
      verifyOnly
        ? '  Nothing is written; the tables are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL will be COMMITTED to the database DATABASE_URL points at.',
      '',
    ].join('\n'),
  );

  await client.connect();
  // ENABLE ROW LEVEL SECURITY takes an ACCESS EXCLUSIVE lock. Never queue
  // behind a long reader and stall the app's own queries behind us.
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '30s'");

  const ownerCount: Record<string, number> = {};
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
    ownerCount[t] = rows[0].n;
  }
  const { rows: bonusRows } = await client.query(
    'SELECT id FROM public.bonus_catalog_bonuses ORDER BY created_at LIMIT 1',
  );
  const bonusId: string | null = bonusRows[0]?.id ?? null;

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
  for (const t of TABLES) {
    // POSITIVE CONTROL: without it, "anon reads 0" could be passing because the
    // role switch itself broke, not because RLS works.
    const svc = await asRole('service_role', async () => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
      return rows[0].n as number;
    });
    report(svc === ownerCount[t], `${t}: service_role reads all ${ownerCount[t]} rows (the app's path)`, svc === ownerCount[t] ? '' : ` — got ${svc}`);
    if (ownerCount[t] === 0) {
      report(false, `${t}: table is empty, so "anon reads 0" would prove nothing`);
      continue;
    }

    for (const role of ['anon', 'authenticated']) {
      const n = await asRole(role, async () => {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
        return rows[0].n as number;
      });
      report(n === 0, `${t}: ${role} reads 0 of ${ownerCount[t]}`, n === 0 ? '' : ` — got ${n}`);
    }

    // EXPLAIN never executes, so this proves DELETE and UPDATE are blocked
    // without attempting either against a live table.
    const textCol = t === 'penny_employee_usage' ? 'refund_reason' : 'note';
    for (const [verb, sql] of [
      ['DELETE', `EXPLAIN DELETE FROM public.${t}`],
      ['UPDATE', `EXPLAIN UPDATE public.${t} SET ${textCol} = ${textCol}`],
    ]) {
      const plan = await asRole('anon', async () => {
        const { rows } = await client.query(sql);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      report(plan.includes('One-Time Filter: false'), `${t}: anon ${verb} is planned as One-Time Filter: false (touches no row)`);
    }

    const insert = legalInsert(t, bonusId);
    if (!insert) {
      report(false, `${t}: no bonus_catalog_bonuses row to build a legal INSERT from`);
      continue;
    }
    let refusedBy = '';
    await asRole('anon', async () => {
      try {
        await client.query(insert);
      } catch (e) {
        refusedBy = (e as { code?: string }).code ?? 'error';
      }
    });
    // 42501 = insufficient_privilege, which is what an RLS WITH CHECK refusal raises.
    report(refusedBy === '42501', `${t}: anon INSERT is refused by RLS (42501)`, refusedBy === '42501' ? '' : ` — got ${refusedBy || 'ACCEPTED'}`);
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
      const anon = createClient(url, anonKey, { auth: { persistSession: false } });
      const svc = createClient(url, svcKey, { auth: { persistSession: false } });
      for (const t of TABLES) {
        const a = await anon.from(t).select('*', { count: 'exact', head: true });
        const s = await svc.from(t).select('*', { count: 'exact', head: true });
        // An error is not a pass: PGRST205 (table missing from the schema cache)
        // would also read as "anon sees nothing".
        report(!a.error && a.count === 0, `${t}: the public anon key reads 0`, a.error ? ` — error ${a.error.code}` : a.count === 0 ? '' : ` — got ${a.count}`);
        report(!s.error && (s.count ?? -1) >= ownerCount[t], `${t}: the service key reads ${ownerCount[t]}+`, s.error ? ` — error ${s.error.code}` : ` (got ${s.count})`);
      }
    }
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log(dryRun || verifyOnly ? '\nAll checks passed.' : '\nAll checks passed — RLS is on for all three.');
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

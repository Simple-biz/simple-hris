/**
 * [GML-ONE-DEFINITION] Step 5 of the 2026-09-21 Global Master List reconcile.
 *
 * Applies references/sql/alter/2026-09-21_active_employees_drop_upload_gate.sql
 * — the migration that makes `active_employees` mean the same thing the external
 * API means, so Admin → Integrations and HR → Global Master List can never again
 * report two different rosters.
 *
 *   node --import tsx scripts/apply-active-employees-one-definition.mts          # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-active-employees-one-definition.mts --dry    # same, explicitly
 *   node --import tsx scripts/apply-active-employees-one-definition.mts --apply  # COMMIT
 *   node --import tsx scripts/apply-active-employees-one-definition.mts --verify # verify only
 *   node --import tsx scripts/apply-active-employees-one-definition.mts --revert # PUT THE GATE BACK
 *
 * SAFE BY DEFAULT: no flag is a dry run. Postgres DDL is transactional, so the
 * rehearsal applies the SQL, runs every check, and rolls back — proving the
 * migration parses and the counts converge while leaving production untouched.
 *
 * *** THIS REFUSES TO RUN BEFORE THE DATA RECONCILE. ***
 * The SQL's own pre-flight raises if more than 60 unstamped rows are off the
 * current upload. Until scripts/reconcile-gml-active-only.mts has run with
 * --apply, that number is 508, and this migration would publish 483 dead rows
 * to the ~40 readers of active_employees at once.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER on 5432, not the direct
 * host (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * Kane asked for a flip-back: `--revert` applies the paired
 * 2026-09-21_active_employees_restore_upload_gate.sql. It restores the gate and
 * un-stamps nobody; to undo the stamps use
 * references/backups/2026-09-21-gml-reconcile/revert-plan.csv.
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

const FORWARD = 'references/sql/alter/2026-09-21_active_employees_drop_upload_gate.sql';
const BACKWARD = 'references/sql/alter/2026-09-21_active_employees_restore_upload_gate.sql';

const wantVerify = process.argv.includes('--verify');
const wantApply = process.argv.includes('--apply');
const wantDry = process.argv.includes('--dry');
const wantRevert = process.argv.includes('--revert');
if ([wantVerify, wantApply, wantDry].filter(Boolean).length > 1) {
  console.error('Pass exactly one of --dry / --apply / --verify (the default is --dry).');
  process.exit(1);
}
const verifyOnly = wantVerify;
const dryRun = wantDry || (!wantVerify && !wantApply);

const sqlRelative = wantRevert ? BACKWARD : FORWARD;
const sqlPath = path.join(REPO_ROOT, ...sqlRelative.split('/'));
if (!existsSync(sqlPath)) {
  console.error(`Migration SQL not found at ${sqlPath}`);
  process.exit(1);
}

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

/** What the view must equal after the forward migration. */
const CHECKS: Array<[string, string]> = [
  ['active_employees still exists', `SELECT to_regclass('public.active_employees') IS NOT NULL AS ok`],
  [
    'the view is NOT security_invoker (definer semantics preserved)',
    `SELECT COALESCE((SELECT NOT (c.reloptions::text LIKE '%security_invoker=true%')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'active_employees'), true) AS ok`,
  ],
  [
    // NOT a search for `last_seen_upload_id`: the view is `SELECT *`, so that
    // column name appears in the expanded select list whether or not the gate
    // exists. The gate itself is the sub-select on master_list_uploads, and
    // that is what must be gone.
    'the view is no longer gated on the current upload',
    `SELECT pg_get_viewdef('public.active_employees'::regclass, true) NOT LIKE '%master_list_uploads%' AS ok`,
  ],
  [
    'active_employees now EQUALS the unstamped set (one definition)',
    `SELECT (SELECT count(*) FROM public.active_employees)
          = (SELECT count(*) FROM public.global_master_list WHERE off_boarded_at IS NULL) AS ok`,
  ],
  ['the roster is not empty', `SELECT (SELECT count(*) FROM public.active_employees) > 0 AS ok`],
];

async function counts(client: Client) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM public.active_employees) AS view_rows,
            (SELECT count(*) FROM public.global_master_list WHERE off_boarded_at IS NULL) AS unstamped`,
  );
  return { view: Number(rows[0].view_rows), unstamped: Number(rows[0].unstamped) };
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  let failed = 0;
  try {
    const before = await counts(client);
    console.log(`before: active_employees ${before.view} · unstamped ${before.unstamped} · gap ${before.unstamped - before.view}`);

    if (verifyOnly) {
      for (const [label, sql] of CHECKS) {
        const { rows } = await client.query(sql);
        const ok = rows[0]?.ok === true;
        if (!ok) failed++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }

    const sql = readFileSync(sqlPath, 'utf8');
    console.log(`\n${wantRevert ? 'REVERTING' : 'applying'} ${sqlRelative}${dryRun ? ' (dry run — will roll back)' : ''}\n`);

    await client.query('BEGIN');
    try {
      await client.query(sql);

      if (!wantRevert) {
        for (const [label, check] of CHECKS) {
          const { rows } = await client.query(check);
          const ok = rows[0]?.ok === true;
          if (!ok) failed++;
          console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
        }
      }

      const after = await counts(client);
      console.log(`\nafter:  active_employees ${after.view} · unstamped ${after.unstamped} · gap ${after.unstamped - after.view}`);

      if (failed) {
        await client.query('ROLLBACK');
        console.error(`\n${failed} check(s) failed — rolled back, nothing changed.`);
        process.exitCode = 1;
        return;
      }
      if (dryRun) {
        await client.query('ROLLBACK');
        console.log('\ndry run — rolled back. Production is exactly as it was. Re-run with --apply to commit.');
        return;
      }
      await client.query('COMMIT');
      console.log(`\nCOMMITTED. ${wantRevert ? 'The upload gate is back.' : 'One definition of "active" — the API and the HR screen are now the same query.'}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

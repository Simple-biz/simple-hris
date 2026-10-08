/**
 * [PAYOUT-SAFETY]
 * Applies references/sql/alter/2026-10-07_bank_update_history_safety.sql — one
 * nullable `jsonb` column, `bank_update_history.safety`, where both self-service
 * bank save routes record what the employee attested (notice version, flags,
 * confirmations). Then verifies the column landed with the right type and that a
 * history row carrying an attestation actually inserts.
 *
 *   node --import tsx scripts/apply-bank-update-history-safety-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-bank-update-history-safety-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-bank-update-history-safety-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-bank-update-history-safety-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled
 * back (Postgres DDL is transactional). Needs DATABASE_URL in .env.local: the
 * SESSION POOLER on 5432, user `postgres.<ref>`, `@` in the password as %40
 * (memory/migration-apply-needs-database-url).
 *
 * Order does not matter for safety: the code writes the column only when it
 * exists (a missing column retries the history insert without it, and the
 * attestation stays on the audit_log row), and reads with `select('*')`. Until
 * this runs, the non-clearable copy of every attestation is simply not kept.
 *
 * Reverse: ALTER TABLE public.bank_update_history DROP COLUMN safety;
 * (this discards every recorded attestation — do not, without Kane).
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-07_bank_update_history_safety.sql';
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
const dryRun = wantDry || (!wantVerify && !wantApply);

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    'DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local:\n' +
      '  DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres',
  );
  process.exit(1);
}

const CHECKS: Array<[string, string]> = [
  [
    'bank_update_history.safety exists as jsonb',
    `SELECT COALESCE((SELECT data_type = 'jsonb' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='bank_update_history' AND column_name='safety'), false) AS ok`,
  ],
  [
    'safety is NULLABLE (staff edits and old rows carry none)',
    `SELECT COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='bank_update_history' AND column_name='safety'), false) AS ok`,
  ],
  [
    'column comment carries the [PAYOUT-SAFETY] tag',
    `SELECT COALESCE((SELECT col_description(to_regclass('public.bank_update_history'), a.attnum) LIKE '[PAYOUT-SAFETY]%'
       FROM pg_attribute a WHERE a.attrelid = to_regclass('public.bank_update_history') AND a.attname = 'safety'), false) AS ok`,
  ],
];

// A history row carrying an attestation must insert, and a staff row without one
// must still insert. Both rolled back.
const CONTROLS: Array<[string, string]> = [
  [
    'a row WITH an attestation is accepted and reads back',
    `INSERT INTO public.bank_update_history (work_email, fields, changes, via, safety)
     VALUES ('control@simple.biz', '[]'::jsonb, '[]'::jsonb, 'external_link',
       '{"notice_version":"2026-10-07","flags":["holder_not_employee"],"holder_confirmed":true}'::jsonb)
     RETURNING (safety->>'notice_version' = '2026-10-07') AS ok`,
  ],
  [
    'a staff row WITHOUT one is still accepted (safety NULL)',
    `INSERT INTO public.bank_update_history (work_email, fields, changes, via)
     VALUES ('control@simple.biz', '[]'::jsonb, '[]'::jsonb, 'people_tab')
     RETURNING (safety IS NULL) AS ok`,
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    `${wantVerify ? 'VERIFY ONLY' : dryRun ? 'DRY RUN (rolled back)' : 'APPLY'} — bank_update_history.safety\n  SQL: ${SQL_PATH}\n`,
  );
  await client.connect();

  const sql = readFileSync(SQL_PATH, 'utf8');
  if (dryRun) {
    await client.query('BEGIN');
    await client.query(sql);
  } else if (wantApply) {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('  applied.\n');
  }

  let failed = 0;
  for (const [label, q] of CHECKS) {
    const { rows } = await client.query(q);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  if (!dryRun) await client.query('BEGIN');
  for (const [label, q] of CONTROLS) {
    await client.query('SAVEPOINT c');
    let ok = false;
    let why = '';
    try {
      const { rows } = await client.query(q);
      ok = rows[0]?.ok === true;
    } catch (e) {
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT c');
    await client.query('RELEASE SAVEPOINT c');
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${why}`);
  }
  await client.query('ROLLBACK');
  if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');

  await client.end();
  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(async (e) => {
  console.error('\nFAILED:', (e as Error).message);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

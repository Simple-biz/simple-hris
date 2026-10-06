/**
 * [Proof of Residential Address letter]
 * Applies references/sql/alter/2026-10-06_document_requests_address_type.sql — widens
 * `document_requests_document_type_check` to admit 'address' — then verifies the constraint
 * accepts every old type plus 'address' and still refuses an unknown one, and that no existing
 * row changed.
 *
 *   node --import tsx scripts/apply-address-letter-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-address-letter-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-address-letter-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-address-letter-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The SQL runs inside a transaction that is always rolled
 * back, so production stays exactly as it was. --apply commits only when every check passed.
 * Every control insert runs inside a SAVEPOINT that is rolled back, so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url).
 *
 * Safe to run BEFORE or AFTER deploying the code. Until it lands, Generate → Proof of Address
 * answers "needs a one-time database update" and removes the PDFs it uploaded.
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-06_document_requests_address_type.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLE = 'public.document_requests';
const CONSTRAINT = 'document_requests_document_type_check';

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

const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Inserts one control row of `type` in its own savepoint; reports whether Postgres refused it. */
async function tryType(type: string): Promise<{ rejected: boolean; message: string }> {
  await client.query('SAVEPOINT ctl');
  let result: { rejected: boolean; message: string };
  try {
    await client.query(
      `INSERT INTO ${TABLE} (employee_email, document_type, file_path, status)
       VALUES ('__control__address@simple.biz', $1, '__control__/original.pdf', 'signed')`,
      [type],
    );
    result = { rejected: false, message: '' };
  } catch (e) {
    result = { rejected: true, message: (e as Error).message };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl');
  await client.query('RELEASE SAVEPOINT ctl');
  return result;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — document_requests 'address' type`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the constraint is only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check below passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');

  const before = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Constraint:');
  const { rows: defRows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '${TABLE}'::regclass AND conname = '${CONSTRAINT}'`,
  );
  report(defRows.length === 1, `${CONSTRAINT} exists`);
  report(/'address'/.test(defRows[0]?.def ?? ''), `${CONSTRAINT} admits 'address'`, defRows[0]?.def ?? '');

  console.log('\nControls (each rolled back):');
  for (const type of ['paystub', 'coe', 'award', 'other', 'address']) {
    const r = await tryType(type);
    report(!r.rejected, `a '${type}' row is accepted`, r.message);
  }
  const unknown = await tryType('passport');
  report(
    unknown.rejected && unknown.message.includes(CONSTRAINT),
    "an unknown type ('passport') is still refused",
    unknown.rejected ? '' : 'it was ACCEPTED',
  );

  const after = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
  report(after.rows[0].n === before.rows[0].n, 'no row was added or removed', `${before.rows[0].n} → ${after.rows[0].n}`);

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
  console.log(
    verifyOnly || dryRun
      ? '\nAll checks passed.'
      : '\nAll checks passed — Proof of Address letters can now be issued.',
  );
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  try {
    await client.query('ROLLBACK');
  } catch {
    /* connection may already be gone */
  }
  try {
    await client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

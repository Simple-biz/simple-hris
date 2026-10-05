/**
 * [MESA request archive]
 * Applies references/sql/alter/2026-10-05_add_mesa_request_archive.sql — `archived_at` /
 * `archived_by` on `mesa_requests` and the two CHECKs that keep an archived row COMPLETED — then
 * verifies every object landed, that no existing row was archived, AND that each CHECK refuses what
 * it exists to refuse.
 *
 *   node --import tsx scripts/apply-mesa-request-archive-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-mesa-request-archive-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-mesa-request-archive-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-mesa-request-archive-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The SQL runs inside a transaction that is always rolled
 * back (Postgres DDL is transactional), so production stays exactly as it was. --apply commits only
 * when every check passed. Every control runs inside a SAVEPOINT that is rolled back, so even
 * --apply writes no rows. No existing row is modified — both columns default to NULL.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * Safe to run BEFORE or AFTER deploying the code (docs/features/mesa.md § Archive).
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-05_add_mesa_request_archive.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLE = 'mesa_requests';
const CONSTRAINTS = ['mesa_requests_archive_pair_chk', 'mesa_requests_archive_only_completed_chk'];

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

const column = (name: string): [string, string] => [
  `${TABLE}.${name} exists`,
  `SELECT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='${TABLE}' AND column_name='${name}') AS ok`,
];

const CHECKS: Array<[string, string]> = [
  column('archived_at'),
  column('archived_by'),
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ['no existing request is archived by the migration', `SELECT NOT EXISTS (SELECT 1 FROM public.${TABLE} WHERE archived_at IS NOT NULL) AS ok`],
];

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

/** Runs `sql` in its OWN savepoint and reports whether Postgres refused it. */
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

const CTL_EMAIL = "'__control__mesa-archive@simple.biz'";
const BY = "'archive-control@simple.biz'";

/** A control request row, optionally archived. */
function request(
  type: string,
  status: string,
  opts: { dispatched?: boolean; archived?: boolean; archivedBy?: boolean } = {},
): string {
  const archived = opts.archived ?? false;
  const archivedBy = opts.archivedBy ?? archived;
  return `INSERT INTO public.${TABLE}
            (work_email, full_name, department, request_type, status, amount_needed, dispatched_at, archived_at, archived_by)
          VALUES (${CTL_EMAIL}, '__control__', '__control__dept', '${type}', '${status}',
                  ${type === 'disbursement' || type === 'return' ? '100' : 'NULL'},
                  ${opts.dispatched ? 'now()' : 'NULL'},
                  ${archived ? 'now()' : 'NULL'},
                  ${archivedBy ? BY : 'NULL'})`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — MESA request archive`,
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

  console.log('Objects and existing rows:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query<{ ok: boolean }>(sql);
    report(Boolean(rows[0]?.ok), label);
  }

  console.log('\nPositive controls (rolled back):');
  const POSITIVE: Array<[string, string | string[]]> = [
    ['a denied disbursement can be archived', request('disbursement', 'denied', { archived: true })],
    ['an approved opt-out can be archived', request('opt_out', 'approved', { archived: true })],
    ['an approved, PAID disbursement can be archived', request('disbursement', 'approved', { dispatched: true, archived: true })],
    ['an unarchived pending request still writes', request('disbursement', 'pending')],
  ];
  for (const [label, sql] of POSITIVE) {
    const r = await inSavepoint('pc', () => rejects(sql));
    report(!r.rejected, label, r.rejected ? `REFUSED: ${r.message}` : '');
  }

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const archivedPaidThen = (change: string): string[] => [
    request('disbursement', 'approved', { dispatched: true, archived: true }),
    `UPDATE public.${TABLE} SET ${change} WHERE work_email = ${CTL_EMAIL}`,
  ];
  const NEGATIVE: Array<[string, string | string[], string]> = [
    ['a PENDING request cannot be archived', request('disbursement', 'pending', { archived: true }), 'mesa_requests_archive_only_completed_chk'],
    ['an approved but UNPAID disbursement cannot be archived', request('disbursement', 'approved', { archived: true }), 'mesa_requests_archive_only_completed_chk'],
    ['an approved RETURN cannot be archived (no paycheck handling yet)', request('return', 'approved', { archived: true }), 'mesa_requests_archive_only_completed_chk'],
    ['archived_at without archived_by is refused', request('opt_out', 'approved', { archived: true, archivedBy: false }), 'mesa_requests_archive_pair_chk'],
    ['revoking an archived row (status -> pending) is refused', archivedPaidThen(`status = 'pending'`), 'mesa_requests_archive_only_completed_chk'],
    ['undoing an archived payout (dispatched_at -> NULL) is refused', archivedPaidThen('dispatched_at = NULL'), 'mesa_requests_archive_only_completed_chk'],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — MESA request archive is live.');
}

main().catch(async (e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  await client.end().catch(() => {});
  process.exit(1);
});

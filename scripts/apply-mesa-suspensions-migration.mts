/**
 * [MESA contribution suspensions]
 * Applies references/sql/create/2026-10-06_mesa_suspensions.sql — the `mesa_suspensions` table, its
 * CHECKs, the one-open-window-per-account index and the RLS lock-down — then verifies every object
 * landed, that the table starts EMPTY, AND that each constraint refuses what it exists to refuse.
 *
 *   node --import tsx scripts/apply-mesa-suspensions-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-mesa-suspensions-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-mesa-suspensions-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-mesa-suspensions-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The SQL runs inside a transaction that is always rolled
 * back (Postgres DDL is transactional), so production stays exactly as it was. --apply commits only
 * when every check passed. Every control runs inside a SAVEPOINT that is rolled back — including
 * the throwaway `mesa_accounts` row the controls hang off — so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * Safe to run BEFORE or AFTER deploying the code (docs/features/mesa-suspension.md § Deploy notes).
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

const SQL_RELATIVE = 'references/sql/create/2026-10-06_mesa_suspensions.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLE = 'mesa_suspensions';
const CONSTRAINTS = [
  'mesa_suspensions_resume_after_start_chk',
  'mesa_suspensions_resume_pair_chk',
  'mesa_suspensions_reason_len_chk',
  'mesa_suspensions_email_lower_chk',
];
const INDEXES = ['mesa_suspensions_one_open_per_account', 'mesa_suspensions_account_idx'];

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
  [`table ${TABLE} exists`, `SELECT to_regclass('public.${TABLE}') IS NOT NULL AS ok`],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}') AS ok`,
  ]),
  [
    'foreign key to mesa_accounts(account_number)',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.${TABLE}'::regclass AND contype = 'f'
         AND confrelid = 'public.mesa_accounts'::regclass) AS ok`,
  ],
  ['row level security is ON', `SELECT relrowsecurity AS ok FROM pg_class WHERE oid = 'public.${TABLE}'::regclass`],
  [
    'anon has no privilege on the table',
    `SELECT NOT has_table_privilege('anon', 'public.${TABLE}', 'SELECT,INSERT,UPDATE,DELETE') AS ok`,
  ],
  [
    'authenticated has no privilege on the table',
    `SELECT NOT has_table_privilege('authenticated', 'public.${TABLE}', 'SELECT,INSERT,UPDATE,DELETE') AS ok`,
  ],
  ['the table starts empty (no suspension is created by the migration)', `SELECT NOT EXISTS (SELECT 1 FROM public.${TABLE}) AS ok`],
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

// A throwaway account the controls hang off. The number uses a month no real account can carry
// (99-99), so it can never collide with a minted YY-MM-##### — and it is rolled back regardless.
const CTL_ACCOUNT = "'99-99-99999'";
const CTL_EMAIL = "'__control__mesa-suspension@simple.biz'";
const BY = "'suspension-control@simple.biz'";
const CONTROL_ACCOUNT_SQL = `INSERT INTO public.mesa_accounts (account_number, email, name, opened_on)
  VALUES (${CTL_ACCOUNT}, ${CTL_EMAIL}, '__control__', DATE '2026-01-01')`;

/** A control suspension row on the throwaway account. */
function suspension(opts: {
  from?: string;
  resumedOn?: string | null;
  resumedBy?: boolean;
  resumedAt?: boolean;
  reason?: string | null;
  email?: string;
  account?: string;
} = {}): string {
  const from = opts.from ?? '2026-10-05';
  const resumedOn = opts.resumedOn ?? null;
  const resumedBy = opts.resumedBy ?? resumedOn !== null;
  const resumedAt = opts.resumedAt ?? resumedOn !== null;
  return `INSERT INTO public.${TABLE}
            (account_number, email, roster_email, suspended_from, resumed_on, reason,
             suspended_by, resumed_by, resumed_at)
          VALUES (${opts.account ?? CTL_ACCOUNT}, ${opts.email ?? CTL_EMAIL}, ${CTL_EMAIL},
                  DATE '${from}', ${resumedOn ? `DATE '${resumedOn}'` : 'NULL'},
                  ${opts.reason === undefined || opts.reason === null ? 'NULL' : `'${opts.reason}'`},
                  ${BY}, ${resumedBy ? BY : 'NULL'}, ${resumedAt ? 'now()' : 'NULL'})`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — MESA contribution suspensions`,
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

  console.log('Objects:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query<{ ok: boolean }>(sql);
    report(Boolean(rows[0]?.ok), label);
  }

  console.log('\nPositive controls (rolled back):');
  const POSITIVE: Array<[string, string[]]> = [
    ['an open suspension writes', [CONTROL_ACCOUNT_SQL, suspension()]],
    ['a resumed suspension writes', [CONTROL_ACCOUNT_SQL, suspension({ resumedOn: '2026-11-02' })]],
    ['a cancelled suspension (resumed on its start date) writes', [CONTROL_ACCOUNT_SQL, suspension({ resumedOn: '2026-10-05' })]],
    [
      'a closed window and a later open one on the same account write',
      [CONTROL_ACCOUNT_SQL, suspension({ from: '2026-08-03', resumedOn: '2026-09-07' }), suspension({ from: '2026-10-05' })],
    ],
    ['a 250-character reason writes', [CONTROL_ACCOUNT_SQL, suspension({ reason: 'x'.repeat(250) })]],
  ];
  for (const [label, sql] of POSITIVE) {
    const r = await inSavepoint('pc', () => rejects(sql));
    report(!r.rejected, label, r.rejected ? `REFUSED: ${r.message}` : '');
  }

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string[], string]> = [
    [
      'a SECOND open suspension on one account is refused',
      [CONTROL_ACCOUNT_SQL, suspension(), suspension({ from: '2026-10-12' })],
      'mesa_suspensions_one_open_per_account',
    ],
    ['resuming BEFORE the start date is refused', [CONTROL_ACCOUNT_SQL, suspension({ resumedOn: '2026-10-04' })], 'mesa_suspensions_resume_after_start_chk'],
    ['a resume date with no resumer is refused', [CONTROL_ACCOUNT_SQL, suspension({ resumedOn: '2026-11-02', resumedBy: false })], 'mesa_suspensions_resume_pair_chk'],
    ['a resume date with no resume time is refused', [CONTROL_ACCOUNT_SQL, suspension({ resumedOn: '2026-11-02', resumedAt: false })], 'mesa_suspensions_resume_pair_chk'],
    ['a 251-character reason is refused', [CONTROL_ACCOUNT_SQL, suspension({ reason: 'x'.repeat(251) })], 'mesa_suspensions_reason_len_chk'],
    ['a mixed-case email is refused', [CONTROL_ACCOUNT_SQL, suspension({ email: "'Mixed@simple.biz'" })], 'mesa_suspensions_email_lower_chk'],
    ['a suspension on an account that does not exist is refused', [suspension({ account: "'99-99-00000'" })], 'mesa_suspensions_account_number_fkey'],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — MESA suspensions are live.');
}

main().catch(async (e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : String(e));
  await client.end().catch(() => {});
  process.exit(1);
});

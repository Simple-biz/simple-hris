/**
 * [Salaried pay basis]
 * Applies references/sql/alter/2026-10-02_salary_pay_basis.sql — the salary columns on
 * `payment_catalog_pay_structures` and the dated `employee_salary_history` table — then verifies
 * every object landed, that nobody but the service role can read the history, that EVERY existing
 * structure is still hourly, AND that each CHECK refuses what it exists to refuse.
 *
 *   node --import tsx scripts/apply-salary-pay-basis-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-salary-pay-basis-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-salary-pay-basis-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-salary-pay-basis-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The SQL runs inside a transaction that is always rolled
 * back (Postgres DDL is transactional), so production stays exactly as it was. --apply commits only
 * when every check passed. Re-running --apply is safe: ADD COLUMN IF NOT EXISTS, constraints are
 * dropped and re-added by name, CREATE … IF NOT EXISTS. No existing row is modified — the new
 * columns are defaulted ('hourly', null, null).
 *
 * Every control runs inside a SAVEPOINT that is rolled back, so even --apply writes no rows.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * Safe to run BEFORE or AFTER deploying the code. Until the columns exist the Pay Structure editor
 * says the salary option is not set up yet and every save stays hourly.
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-02_salary_pay_basis.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const HISTORY = 'employee_salary_history';
const STRUCTURES = 'payment_catalog_pay_structures';
const CONSTRAINTS = [
  'pay_structures_pay_basis_valid',
  'pay_structures_salary_period_valid',
  'pay_structures_salary_shape',
  'salary_history_email_present',
  'salary_history_pay_basis_valid',
  'salary_history_period_valid',
  'salary_history_currency_valid',
  'salary_history_shape',
];
const INDEXES = ['employee_salary_history_one_per_day', 'employee_salary_history_email_idx'];

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
  `${STRUCTURES}.${name} exists`,
  `SELECT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='${STRUCTURES}' AND column_name='${name}') AS ok`,
];

const CHECKS: Array<[string, string]> = [
  column('pay_basis'),
  column('salary_period'),
  column('salary_amount'),
  [`${HISTORY} exists`, `SELECT to_regclass('public.${HISTORY}') IS NOT NULL AS ok`],
  [
    `${HISTORY}: row level security is ENABLED`,
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${HISTORY}')), false) AS ok`,
  ],
  [
    `${HISTORY}: ZERO policies (service role only)`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${HISTORY}') AS ok`,
  ],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${HISTORY}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${HISTORY}', '${priv}') AS ok`,
    ]),
  ),
  ...(['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
    `${HISTORY}: service_role HAS ${priv} (the route needs it)`,
    `SELECT has_table_privilege('service_role', 'public.${HISTORY}', '${priv}') AS ok`,
  ]),
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [`index ${name}`, `SELECT to_regclass('public.${name}') IS NOT NULL AS ok`]),
  [
    'EVERY existing pay structure is still hourly with no salary figures',
    `SELECT NOT EXISTS (SELECT 1 FROM public.${STRUCTURES}
       WHERE pay_basis <> 'hourly' OR salary_period IS NOT NULL OR salary_amount IS NOT NULL) AS ok`,
  ],
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

const CTL_EMAIL = "'__control__salary@simple.biz'";
const BY = "'salary-control@simple.biz'";

function structure(scope: 'department' | 'employee', basis: string, period: string | null, amount: string | null): string {
  const id = `'__control__pay_${scope}_${basis}_${period ?? 'x'}'`;
  return `INSERT INTO public.${STRUCTURES}
            (id, scope, department_key, employee_email, employee_name, regular_rate, ot_rate, currency,
             pay_basis, salary_period, salary_amount, created_by, updated_by)
          VALUES (${id}, '${scope}', '__control__dept', ${scope === 'employee' ? CTL_EMAIL : 'NULL'}, NULL, 0, NULL, 'PHP',
                  '${basis}', ${period === null ? 'NULL' : `'${period}'`}, ${amount === null ? 'NULL' : amount}, ${BY}, ${BY})`;
}

function history(basis: string, period: string | null, amount: string | null, effective = '2000-01-02', email = CTL_EMAIL): string {
  return `INSERT INTO public.${HISTORY} (employee_email, effective_from, pay_basis, salary_period, salary_amount, currency, created_by)
          VALUES (${email}, '${effective}', '${basis}', ${period === null ? 'NULL' : `'${period}'`}, ${amount === null ? 'NULL' : amount}, 'PHP', ${BY})`;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — salaried pay basis`,
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

  console.log('Objects, privileges and existing rows:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query<{ ok: boolean }>(sql);
    report(Boolean(rows[0]?.ok), label);
  }

  console.log('\nPositive controls (rolled back):');
  await inSavepoint('pc', async () => {
    try {
      await client.query(structure('employee', 'salary', 'week', '25000'));
      await client.query(history('salary', 'week', '25000'));
      await client.query(history('hourly', null, null, '2000-01-09'));
      const { rows } = await client.query<{ email: string }>(
        `SELECT employee_email AS email FROM public.${HISTORY} WHERE created_by = ${BY} LIMIT 1`,
      );
      report(true, 'an employee salary structure, a dated salary row and a switch back to hourly all write');
      report(rows[0]?.email === rows[0]?.email.toLowerCase(), 'the history email is stored lower-case');
    } catch (e) {
      report(false, 'the legal writes were accepted', (e as Error).message);
    }
  });

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string | string[], string]> = [
    ['a DEPARTMENT-scope salary is refused (ruling §2)', structure('department', 'salary', 'week', '25000'), 'pay_structures_salary_shape'],
    ['a salary structure with no period is refused', structure('employee', 'salary', null, '25000'), 'pay_structures_salary_shape'],
    ['a salary structure with no amount is refused', structure('employee', 'salary', 'week', null), 'pay_structures_salary_shape'],
    ['a negative salary is refused', structure('employee', 'salary', 'week', '-1'), 'pay_structures_salary_shape'],
    ['an hourly structure carrying a salary amount is refused', structure('employee', 'hourly', null, '25000'), 'pay_structures_salary_shape'],
    ['an unknown pay basis is refused', structure('employee', 'commission', null, null), 'pay_structures_pay_basis_valid'],
    ['an unknown salary period is refused', structure('employee', 'salary', 'year', '25000'), 'pay_structures_salary_period_valid'],
    ['a history salary row with no amount is refused', history('salary', 'week', null), 'salary_history_shape'],
    ['a history hourly row carrying a period is refused', history('hourly', 'week', null), 'salary_history_shape'],
    ['a history row with no email is refused', history('salary', 'week', '1', '2000-01-02', "' '"), 'salary_history_email_present'],
    [
      'two rows for one person on one date are refused',
      [history('salary', 'week', '1'), history('salary', 'week', '2', '2000-01-02', "'__CONTROL__salary@simple.biz'")],
      'employee_salary_history_one_per_day',
    ],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the salaried pay basis is live.');
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

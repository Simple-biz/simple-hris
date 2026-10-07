/**
 * [Accounting Scoreboard: a custom section shown inside a built-in tab]
 * Applies references/sql/create/2026-10-07_accounting_scoreboard_custom_section_host.sql. Carla,
 * 2026-10-07: "Sales - Projects Onboarded" on the Sales Onboarding tab. It adds
 * accounting_scoreboard_custom_sections.host_section_key and its CHECK, then verifies the column, that
 * the live CHECK lists exactly HOST_SECTION_KEYS from sections.ts, that the table is still
 * service-role only, and that the guard refuses what it exists to refuse.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-custom-host-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-custom-host-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-custom-host-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-custom-host-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. There are no
 * data steps, so there is nothing to back up: no existing row is UPDATEd (every section created before
 * this keeps null, a tab of its own). Every control runs inside a SAVEPOINT that is rolled back, on
 * titles starting `__control__`, so the controls write no rows even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply BEFORE the code is deployed: the board selects host_section_key, and until the column exists it
 * answers "not set up yet" (server.ts isMissingTable).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Custom sections.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
// tsx loads the .ts module as CommonJS, so a named import fails here; take the namespace off the default.
import sectionsModule from '../src/lib/accounting-scoreboard/sections';

const { HOST_SECTION_KEYS } = sectionsModule as unknown as typeof import('../src/lib/accounting-scoreboard/sections');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-07_accounting_scoreboard_custom_section_host.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const TABLE = 'accounting_scoreboard_custom_sections';

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
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}

const CHECKS: Array<[string, string]> = [
  [
    `${TABLE}.host_section_key exists, text, nullable`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${TABLE}'
       AND column_name='host_section_key' AND data_type='text' AND is_nullable='YES') AS ok`,
  ],
  ['constraint acct_sb_custom_host_valid', `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acct_sb_custom_host_valid') AS ok`],
  [`${TABLE}: row level security is still ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${TABLE}')), false) AS ok`],
  [`${TABLE}: still ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${TABLE}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${TABLE}: ${role} still has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${TABLE}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${TABLE}: anon and authenticated have NO column privilege on host_section_key`,
    `SELECT NOT has_column_privilege('anon', 'public.${TABLE}', 'host_section_key', 'SELECT')
        AND NOT has_column_privilege('authenticated', 'public.${TABLE}', 'host_section_key', 'SELECT') AS ok`,
  ],
  [
    `${TABLE} is still not in supabase_realtime`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public' AND tablename = '${TABLE}') AS ok`,
  ],
  [
    'every live section is still in a tab of its own or a valid host (no data step ran)',
    `SELECT NOT EXISTS (SELECT 1 FROM public.${TABLE} WHERE host_section_key IS NOT NULL
       AND host_section_key NOT IN (${HOST_SECTION_KEYS.map((k) => `'${k}'`).join(', ')})) AS ok`,
  ],
];

const BY = "'acct-sb-control@simple.biz'";
const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Runs `sql` inside a savepoint that is ALWAYS rolled back. Reports whether Postgres refused it, and why. */
async function attempt(sql: string): Promise<{ rejected: boolean; message: string }> {
  let result: { rejected: boolean; message: string };
  try {
    await client.query(`SAVEPOINT ctl; ${sql}`);
    result = { rejected: false, message: '' };
  } catch (e) {
    result = { rejected: true, message: (e as Error).message };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl; RELEASE SAVEPOINT ctl;');
  return result;
}

const insert = (title: string, host: string | null) =>
  `INSERT INTO public.${TABLE} (title, kind, host_section_key, created_by, updated_by)
     VALUES ('${title}', 'daily', ${host === null ? 'NULL' : `'${host}'`}, ${BY}, ${BY});`;

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: custom section shown in a built-in tab`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  No data step: no existing row changes. The SQL is COMMITTED when every check passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  // Never queue the ALTER behind a long board read, and never make the board wait on us for long.
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{
    rows: Array<{ ok: boolean }>;
  }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));

  // The live CHECK must list exactly the code's hosts: a key the code offers but the CHECK refuses
  // would fail in production at the first save; one the CHECK allows but the code never reads would
  // be stored and silently ignored.
  const def = await client.query<{ def: string | null }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'acct_sb_custom_host_valid'`,
  );
  const listed = [...(def.rows[0]?.def ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  report(
    JSON.stringify(listed) === JSON.stringify([...HOST_SECTION_KEYS].sort()),
    'the live CHECK lists exactly HOST_SECTION_KEYS (sections.ts)',
    `CHECK: ${listed.join(', ') || '(none)'}`,
  );

  console.log('\nPositive control (rolled back):');
  const positive = await attempt(`
    ${insert('__control__ Own tab', null)}
    ${insert('__control__ Hosted', 'onboarding')}
    UPDATE public.${TABLE} SET host_section_key = 'chargebacks' WHERE title = '__control__ Hosted';
    UPDATE public.${TABLE} SET host_section_key = NULL WHERE title = '__control__ Hosted';
    ${HOST_SECTION_KEYS.map((k, i) => insert(`__control__ Host ${i}`, k)).join('\n')}
  `);
  report(
    !positive.rejected,
    'a section with its own tab, one under Sales Onboarding, moving it and moving it back, and one under every host all write',
    positive.message,
  );

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['inside Outcomes (itself shown inside Chargebacks) is refused', insert('__control__ X', 'chargeback_outcomes'), 'acct_sb_custom_host_valid'],
    ["inside 'custom' (not a built-in) is refused", insert('__control__ X', 'custom'), 'acct_sb_custom_host_valid'],
    ['an unknown section is refused', insert('__control__ X', 'sales_onboarding'), 'acct_sb_custom_host_valid'],
    ['a tab label instead of a key is refused', insert('__control__ X', 'Sales Onboarding'), 'acct_sb_custom_host_valid'],
  ];
  for (const [label, sql, expect] of NEGATIVE) {
    const r = await attempt(sql);
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — custom sections can be shown inside a built-in tab.');
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

/**
 * [Accounting Scoreboard: hide a section from the Overview]
 * Applies references/sql/create/2026-10-07_accounting_scoreboard_overview_visibility.sql. Carla, 2026-10-07
 * meeting (Open item 391): "I don't want this one on the overview, but I don't have a hide option." It adds
 * show_on_overview (boolean NOT NULL DEFAULT true) to accounting_scoreboard_sections and
 * accounting_scoreboard_custom_sections, then verifies both columns, that every existing row reads true,
 * that both tables are still service-role only (the anon role is refused with 42501), that the board's
 * exact selects answer, and that a NULL is refused.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. There are no
 * data steps, so there is nothing to back up: no existing row is UPDATEd (every row reads the column's
 * default, true, which is what the board already shows). Every control runs inside a SAVEPOINT that is
 * rolled back, on a custom section titled `__control__ …` and on the built-in switch rows as they stand,
 * so the controls write no rows even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply BEFORE the code is deployed: the board selects show_on_overview on both tables, and until the
 * columns exist every board read answers "not set up yet" (server.ts isMissingTable).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Hidden from the Overview.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-07_accounting_scoreboard_overview_visibility.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const SECTIONS = 'accounting_scoreboard_sections';
const CUSTOM = 'accounting_scoreboard_custom_sections';
const TABLES = [SECTIONS, CUSTOM] as const;
/** The board's own selects (server.ts SECTION_COLS and CUSTOM_COLS): if these answer, the board reads. */
const BOARD_SELECTS: Record<(typeof TABLES)[number], string> = {
  [SECTIONS]: 'section_key, enabled, goal, show_on_overview',
  [CUSTOM]: 'id, title, kind, goal, goal_direction, enabled, show_on_overview, sort_order, archived_at, host_section_key',
};

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

const CHECKS: Array<[string, string]> = TABLES.flatMap((t): Array<[string, string]> => [
  [
    `${t}.show_on_overview exists, boolean, NOT NULL, DEFAULT true`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'
       AND column_name='show_on_overview' AND data_type='boolean' AND is_nullable='NO' AND column_default='true') AS ok`,
  ],
  // Only while the column is being added: after that, a manager hiding a section is exactly what it is for.
  ...(verifyOnly
    ? []
    : ([
        [`${t}: every existing row reads true (no data step ran)`, `SELECT NOT EXISTS (SELECT 1 FROM public.${t} WHERE show_on_overview IS DISTINCT FROM true) AS ok`],
      ] as Array<[string, string]>)),
  [`${t}: row level security is still ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`],
  [`${t}: still ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${t}: ${role} still has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${t}: anon and authenticated have NO column privilege on show_on_overview`,
    `SELECT NOT has_column_privilege('anon', 'public.${t}', 'show_on_overview', 'SELECT')
        AND NOT has_column_privilege('authenticated', 'public.${t}', 'show_on_overview', 'SELECT') AS ok`,
  ],
  [
    `${t} is still not in supabase_realtime`,
    `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public' AND tablename = '${t}') AS ok`,
  ],
]);

const BY = "'acct-sb-control@simple.biz'";
const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Runs `sql` inside a savepoint that is ALWAYS rolled back. Reports whether Postgres refused it, how, and why. */
async function attempt(sql: string): Promise<{ rejected: boolean; code: string; message: string; rows: unknown[] }> {
  let result: { rejected: boolean; code: string; message: string; rows: unknown[] };
  try {
    const res = (await client.query(`SAVEPOINT ctl; ${sql}`)) as unknown;
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    result = { rejected: false, code: '', message: '', rows: (last as { rows?: unknown[] })?.rows ?? [] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    result = { rejected: true, code: err.code ?? '', message: err.message ?? String(e), rows: [] };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl; RELEASE SAVEPOINT ctl;');
  return result;
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: hide a section from the Overview`,
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
  // Never queue the ALTERs behind a long board read, and never make the board wait on us for long.
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{
    rows: Array<{ ok: boolean }>;
  }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));

  const counts = await client.query<{ sections: string; custom: string; hidden: string }>(
    `SELECT (SELECT count(*) FROM public.${SECTIONS}) AS sections, (SELECT count(*) FROM public.${CUSTOM}) AS custom,
       (SELECT count(*) FROM public.${SECTIONS} WHERE NOT show_on_overview)
         + (SELECT count(*) FROM public.${CUSTOM} WHERE NOT show_on_overview AND archived_at IS NULL) AS hidden`,
  );
  const c = counts.rows[0];
  console.log(`  ....  rows as they stand: ${c?.sections} built-in switch rows, ${c?.custom} custom sections, ${c?.hidden} hidden from the Overview`);

  console.log("\nThe board's own selects (server.ts SECTION_COLS / CUSTOM_COLS):");
  for (const t of TABLES) {
    const r = await attempt(`SELECT ${BOARD_SELECTS[t]} FROM public.${t} LIMIT 1;`);
    report(!r.rejected, `${t}: the board's select answers`, r.message);
  }

  console.log('\nThe anon role is refused (42501; rolled back):');
  for (const t of TABLES) {
    const r = await attempt(`SET LOCAL ROLE anon; SELECT show_on_overview FROM public.${t} LIMIT 1;`);
    report(r.rejected && r.code === '42501', `${t}: anon SELECT of show_on_overview is refused`, r.rejected ? (r.code === '42501' ? '' : `refused with ${r.code}: ${r.message}`) : 'it was ACCEPTED');
  }

  console.log('\nPositive controls (rolled back):');
  const builtIn = await attempt(`
    INSERT INTO public.${SECTIONS} (section_key, enabled, goal, show_on_overview, updated_by)
      VALUES ('compliance', true, NULL, false, ${BY})
      ON CONFLICT (section_key) DO UPDATE SET show_on_overview = false, updated_by = ${BY};
    SELECT show_on_overview FROM public.${SECTIONS} WHERE section_key = 'compliance';
  `);
  report(
    !builtIn.rejected && (builtIn.rows[0] as { show_on_overview?: boolean } | undefined)?.show_on_overview === false,
    'a built-in switch row takes show_on_overview = false (the upsert patchSection makes)',
    builtIn.message,
  );
  const customHidden = await attempt(`
    INSERT INTO public.${CUSTOM} (title, kind, host_section_key, show_on_overview, created_by, updated_by)
      VALUES ('__control__ Hidden', 'daily', 'onboarding', false, ${BY}, ${BY});
    UPDATE public.${CUSTOM} SET show_on_overview = true WHERE title = '__control__ Hidden';
    UPDATE public.${CUSTOM} SET show_on_overview = false WHERE title = '__control__ Hidden';
    SELECT show_on_overview FROM public.${CUSTOM} WHERE title = '__control__ Hidden';
  `);
  report(
    !customHidden.rejected && (customHidden.rows[0] as { show_on_overview?: boolean } | undefined)?.show_on_overview === false,
    'a custom section is created hidden, shown, and hidden again (the PATCH patchCustomSection makes)',
    customHidden.message,
  );
  const customDefault = await attempt(`
    INSERT INTO public.${CUSTOM} (title, kind, created_by, updated_by) VALUES ('__control__ Default', 'daily', ${BY}, ${BY});
    SELECT show_on_overview FROM public.${CUSTOM} WHERE title = '__control__ Default';
  `);
  report(
    !customDefault.rejected && (customDefault.rows[0] as { show_on_overview?: boolean } | undefined)?.show_on_overview === true,
    'a custom section created without the column is shown (createCustomSection never sends it)',
    customDefault.message,
  );

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string]> = [
    [
      `${SECTIONS}: show_on_overview = NULL is refused (absence is never stored)`,
      `INSERT INTO public.${SECTIONS} (section_key, enabled, show_on_overview, updated_by) VALUES ('compliance', true, NULL, ${BY})
         ON CONFLICT (section_key) DO UPDATE SET show_on_overview = NULL;`,
    ],
    [
      `${CUSTOM}: show_on_overview = NULL is refused`,
      `INSERT INTO public.${CUSTOM} (title, kind, show_on_overview, created_by, updated_by) VALUES ('__control__ Null', 'daily', NULL, ${BY}, ${BY});`,
    ],
  ];
  for (const [label, sql] of NEGATIVE) {
    const r = await attempt(sql);
    // 23502 = not_null_violation
    const ok = r.rejected && r.code === '23502';
    report(ok, label, r.rejected ? (ok ? '' : `refused for another reason: ${r.code} ${r.message}`) : 'it was ACCEPTED');
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — a section can be hidden from the Overview.');
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

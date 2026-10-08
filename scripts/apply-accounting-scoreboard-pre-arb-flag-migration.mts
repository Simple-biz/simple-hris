/**
 * [Accounting Scoreboard: a Chargeback Outcomes line can be flagged Pre-arb]
 * Applies references/sql/create/2026-10-07_accounting_scoreboard_pre_arb_flag.sql (Carla, 2026-10-07, Open item
 * 392: wins positive, Pre-arb and Losses negative; Kane's W0.1: Pre-arb counts as a loss), then its data step:
 * flag the ONE live "Pre-arb" Outcomes line `pre_arb`. Then it verifies the CHECK in force lists exactly OUTCOMES
 * from sections.ts, that the table is still service-role only (the anon role is refused with 42501), and that the
 * guard accepts and refuses what it must.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts --apply   # backup, then COMMIT
 *   node --import tsx scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back.
 * THE DATA STEP selects the live Outcomes lines labelled exactly "Pre-arb" and REFUSES (nothing is committed)
 * unless exactly ONE matches. A line already flagged `pre_arb` is left alone (re-runnable); one a manager marked
 * win or loss is refused, never overwritten. --apply writes that row to docs/audits/backups/ (gitignored) BEFORE
 * the UPDATE (CLAUDE.md: a bulk UPDATE needs a SELECT backup on disk first), and the UPDATE touches that one id.
 * Every control runs inside a SAVEPOINT that is rolled back, on labels starting `__control__`.
 *
 * A check of what the data step did runs on a dry run and --apply only. Afterwards a manager may re-mark any line
 * in Setup → Rows, so --verify checks what stays true instead (Open item 399's rule).
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply BEFORE the push: until the CHECK takes 'pre_arb', Setup's "Counts as Pre-arb" is refused by the database.
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Chargebacks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';
// tsx loads the .ts module as CommonJS, so a named import fails here; take the namespace off the default.
import sectionsModule from '../src/lib/accounting-scoreboard/sections';

const { OUTCOMES } = sectionsModule as unknown as typeof import('../src/lib/accounting-scoreboard/sections');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SQL_RELATIVE = 'references/sql/create/2026-10-07_accounting_scoreboard_pre_arb_flag.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const ROWS = 'accounting_scoreboard_rows';
const PRE_ARB_LABEL = 'Pre-arb';

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

/** True for good: checked in every mode. */
const CHECKS: Array<[string, string]> = [
  ['constraint acct_sb_rows_outcome_valid', `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acct_sb_rows_outcome_valid') AS ok`],
  [
    'no line outside Chargeback Outcomes carries an outcome',
    `SELECT NOT EXISTS (SELECT 1 FROM public.${ROWS} WHERE outcome IS NOT NULL AND section_key <> 'chargeback_outcomes') AS ok`,
  ],
  [`${ROWS}: row level security is still ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${ROWS}')), false) AS ok`],
  [`${ROWS}: still ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${ROWS}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${ROWS}: ${role} still has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${ROWS}', '${priv}') AS ok`,
    ]),
  ),
];

/** What the data step did: dry run and --apply only. */
const SEED_CHECKS: Array<[string, string]> = [
  [
    `the one live "${PRE_ARB_LABEL}" Outcomes line counts as Pre-arb`,
    `SELECT (SELECT count(*) FROM public.${ROWS} WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL
       AND label = '${PRE_ARB_LABEL}' AND outcome = 'pre_arb') = 1 AS ok`,
  ],
  [
    'the live "Wins" and "Losses" lines are unchanged (win, loss)',
    `SELECT EXISTS (SELECT 1 FROM public.${ROWS} WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL AND label = 'Wins' AND outcome = 'win')
        AND EXISTS (SELECT 1 FROM public.${ROWS} WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL AND label = 'Losses' AND outcome = 'loss') AS ok`,
  ],
  [
    'nothing but that line was flagged Pre-arb',
    `SELECT (SELECT count(*) FROM public.${ROWS} WHERE outcome = 'pre_arb') = 1 AS ok`,
  ],
];

const BY = "'acct-sb-control@simple.biz'";
const client = new Client({ connectionString });
let failed = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Runs `sql` inside a savepoint that is ALWAYS rolled back. Reports whether Postgres refused it, how, and why. */
async function attempt(sql: string): Promise<{ rejected: boolean; code: string; message: string }> {
  let result: { rejected: boolean; code: string; message: string };
  try {
    await client.query(`SAVEPOINT ctl; ${sql}`);
    result = { rejected: false, code: '', message: '' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    result = { rejected: true, code: err.code ?? '', message: err.message ?? String(e) };
  }
  await client.query('ROLLBACK TO SAVEPOINT ctl; RELEASE SAVEPOINT ctl;');
  return result;
}

/** Control fixtures in a temp table: an Outcomes line and a bucket. */
const FIXTURES_SQL = `
  CREATE TEMP TABLE IF NOT EXISTS acct_sb_pa (k text primary key, id uuid) ON COMMIT DROP;
  DELETE FROM acct_sb_pa;
  WITH outcome AS (
    INSERT INTO public.${ROWS} (section_key, label, created_by) VALUES ('chargeback_outcomes', '__control__ Outcome', ${BY}) RETURNING id
  ), bucket AS (
    INSERT INTO public.${ROWS} (section_key, label, created_by) VALUES ('buckets', '__control__ Bucket', ${BY}) RETURNING id
  )
  INSERT INTO acct_sb_pa (k, id) SELECT 'outcome', id FROM outcome UNION ALL SELECT 'bucket', id FROM bucket;`;
const id = (k: string) => `(SELECT id FROM acct_sb_pa WHERE k = '${k}')`;

type RowRecord = { id: string; label: string; outcome: string | null } & Record<string, unknown>;

/**
 * The data step. Refuses unless exactly one live "Pre-arb" Outcomes line exists; leaves it alone when it is already
 * flagged; refuses when a manager marked it win or loss; otherwise backs it up (--apply) and flags that one id.
 */
async function flagPreArb(): Promise<{ ok: boolean; note: string }> {
  const { rows } = await client.query<RowRecord>(
    `SELECT * FROM public.${ROWS} WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL AND label = $1 ORDER BY id`,
    [PRE_ARB_LABEL],
  );
  if (rows.length !== 1) return { ok: false, note: `REFUSED: ${rows.length} live "${PRE_ARB_LABEL}" Outcomes lines match; exactly one is required` };
  const line = rows[0];
  if (line.outcome === 'pre_arb') return { ok: true, note: `already flagged Pre-arb (${line.id}); nothing to change` };
  if (line.outcome !== null) {
    return { ok: false, note: `REFUSED: "${PRE_ARB_LABEL}" (${line.id}) is marked ${line.outcome} by a manager; it is never overwritten` };
  }
  let backup = 'no backup on a dry run (nothing is committed)';
  if (!dryRun) {
    const dir = path.join(REPO_ROOT, 'docs', 'audits', 'backups');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `accounting-scoreboard-pre-arb-row-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), sql: SQL_RELATIVE, rows }, null, 2));
    backup = `backup ${path.relative(REPO_ROOT, file)} (1 row)`;
  }
  const res = await client.query(`UPDATE public.${ROWS} SET outcome = 'pre_arb' WHERE id = $1 AND outcome IS NULL`, [line.id]);
  if (res.rowCount !== 1) return { ok: false, note: `REFUSED: the UPDATE touched ${res.rowCount} rows, not 1` };
  return { ok: true, note: `flagged ${line.id} Pre-arb; ${backup}` };
}

async function main(): Promise<void> {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: a Pre-arb flag on Chargeback Outcomes`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL and the data step run inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The one Pre-arb line is backed up first. The SQL and the data step are COMMITTED when every check passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  // Never queue the ALTER behind a long board read, and never make the board wait on us for long.
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) {
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    console.log('Data step:');
    const step = await flagPreArb();
    report(step.ok, `flag the one live "${PRE_ARB_LABEL}" Outcomes line`, step.note);
    console.log('');
  }

  console.log('Objects, privileges and data:');
  const all = [...CHECKS, ...(verifyOnly ? [] : SEED_CHECKS)];
  const results = (await client.query(all.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{ rows: Array<{ ok: boolean }> }>;
  all.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));

  // The CHECK in force must list exactly the code's OUTCOMES: a value the code offers but the CHECK refuses fails
  // at the first save; one the CHECK allows but the code never reads would be stored and silently ignored.
  const def = await client.query<{ def: string | null }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'acct_sb_rows_outcome_valid'`,
  );
  const listed = [...(def.rows[0]?.def ?? '').matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((v) => v !== 'chargeback_outcomes')
    .sort();
  report(JSON.stringify(listed) === JSON.stringify([...OUTCOMES].sort()), 'the live outcome CHECK lists exactly OUTCOMES (sections.ts)', `CHECK: ${listed.join(', ') || '(none)'}`);

  const now = await client.query<{ label: string; outcome: string | null }>(
    `SELECT label, outcome FROM public.${ROWS} WHERE section_key = 'chargeback_outcomes' AND archived_at IS NULL ORDER BY sort_order, label`,
  );
  console.log(`  ....  live Outcomes lines: ${now.rows.map((r) => `${r.label} = ${r.outcome ?? 'not counted'}`).join(' · ')}`);

  console.log('\nThe anon role is refused (42501; rolled back):');
  const anon = await attempt(`SET LOCAL ROLE anon; SELECT outcome FROM public.${ROWS} LIMIT 1;`);
  report(anon.rejected && anon.code === '42501', `${ROWS}: anon SELECT of outcome is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');

  console.log('\nPositive control (rolled back):');
  const positive = await attempt(`
    ${FIXTURES_SQL}
    UPDATE public.${ROWS} SET outcome = 'pre_arb' WHERE id = ${id('outcome')};
    UPDATE public.${ROWS} SET outcome = 'win' WHERE id = ${id('outcome')};
    UPDATE public.${ROWS} SET outcome = 'loss' WHERE id = ${id('outcome')};
    UPDATE public.${ROWS} SET outcome = NULL WHERE id = ${id('outcome')};
  `);
  report(!positive.rejected, 'an Outcomes line marked Pre-arb, then win, then loss, then not counted, all write', positive.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string]> = [
    ['Pre-arb on a non-Outcomes line (a bucket) is refused', `UPDATE public.${ROWS} SET outcome = 'pre_arb' WHERE id = ${id('bucket')}`],
    ["an outcome other than win / loss / pre_arb is refused ('draw')", `UPDATE public.${ROWS} SET outcome = 'draw' WHERE id = ${id('outcome')}`],
    ["a label as the outcome is refused ('Pre-arb')", `UPDATE public.${ROWS} SET outcome = 'Pre-arb' WHERE id = ${id('outcome')}`],
  ];
  for (const [label, sql] of NEGATIVE) {
    const r = await attempt(`${FIXTURES_SQL} ${sql};`);
    const ok = r.rejected && r.message.includes('acct_sb_rows_outcome_valid');
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — Pre-arb lines can be flagged, and the live one is.');
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

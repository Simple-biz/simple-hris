/**
 * [Accounting Scoreboard: scheduled progress posts to Google Chat]  2026-10-08
 * Applies references/sql/create/2026-10-08_accounting_scoreboard_chat_posts.sql.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-posts-migration.mts            # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-posts-migration.mts --dry      # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-posts-migration.mts --apply
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-posts-migration.mts --verify
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The migration creates one
 * empty table and writes no data, so there is nothing to back up. Every control runs inside a SAVEPOINT that is rolled
 * back, so the controls write nothing even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Until this table exists the scheduled route claims nothing and posts nothing (it answers 503 "not set up"); the
 * Admin's Post to Chat click never touches it.
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § Scheduled posts.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-08_accounting_scoreboard_chat_posts.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const POSTS = 'accounting_scoreboard_chat_posts';
const GUARD = 'acct_sb_chat_posts_guard';

const argv = process.argv.slice(2);
const wantVerify = argv.includes('--verify');
const wantApply = argv.includes('--apply');
const wantDry = argv.includes('--dry');
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

const COLUMNS = ['id', 'slot_date', 'slot_hour', 'frequencies', 'status', 'message', 'progress', 'detail', 'schedule', 'claimed_at', 'finished_at'];

const CHECKS: Array<[string, string]> = [
  [`${POSTS} exists`, `SELECT to_regclass('public.${POSTS}') IS NOT NULL AS ok`],
  [
    `${POSTS} has its ${COLUMNS.length} columns`,
    `SELECT count(*) = ${COLUMNS.length} AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${POSTS}'
       AND column_name IN (${COLUMNS.map((c) => `'${c}'`).join(',')})`,
  ],
  [`${POSTS}: the ${GUARD} trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${POSTS}') AND tgname='${GUARD}' AND NOT tgisinternal) AS ok`],
  [`${POSTS}: one post per slot (acct_sb_chat_posts_one_per_slot)`, `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.${POSTS}') AND conname='acct_sb_chat_posts_one_per_slot' AND contype='u') AS ok`],
  [`${POSTS}: row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${POSTS}')), false) AS ok`],
  [`${POSTS}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${POSTS}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${POSTS}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${POSTS}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${POSTS}: anon and authenticated cannot EXECUTE ${GUARD}()`,
    `SELECT NOT has_function_privilege('anon', 'public.${GUARD}()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.${GUARD}()', 'EXECUTE') AS ok`,
  ],
  [`${POSTS}: not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${POSTS}') AS ok`],
];

/** A control slot far in the past, so it can never collide with a real one even under --apply (and it is rolled back). */
const SLOT = "'1999-01-06', 15";
const CLAIM = (freqs = "ARRAY['daily']") => `INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies, schedule) VALUES (${SLOT}, ${freqs}, '0 19 * * *')`;
const WHERE_SLOT = `WHERE slot_date = '1999-01-06' AND slot_hour = 15`;
const FINISH = (status = 'posted') =>
  `UPDATE public.${POSTS} SET status = '${status}', finished_at = now(), message = 'Current progress: control.', progress = '[]'::jsonb ${WHERE_SLOT}`;

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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: scheduled Chat posts`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check passes. It creates one empty table; no data is written.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) await client.query(readFileSync(SQL_PATH, 'utf8'));

  console.log('Objects and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{ rows: Array<{ ok: boolean }> }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));
  const counts = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${POSTS}`);
  console.log(`  ....  rows: ${counts.rows[0]?.n} post(s)`);

  console.log('\nThe anon role is refused (42501; rolled back):');
  const anon = await attempt(`SET LOCAL ROLE anon; SELECT id FROM public.${POSTS} LIMIT 1;`);
  report(anon.rejected && anon.code === '42501', `anon SELECT on ${POSTS} is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');

  console.log('\nPositive controls (rolled back):');
  const life = await attempt(`
    ${CLAIM("ARRAY['weekly','monthly']")};
    ${FINISH('posted')};
    SELECT (SELECT status FROM public.${POSTS} ${WHERE_SLOT}) AS s;
  `);
  report(!life.rejected && (life.rows[0] as { s?: string } | undefined)?.s === 'posted', 'claim (sending) → stamp posted, once', life.message);
  for (const status of ['skipped', 'refused', 'unreachable', 'timed_out', 'failed']) {
    const r = await attempt(`${CLAIM()}; ${FINISH(status)}; SELECT 1 AS ok;`);
    report(!r.rejected, `claim → stamp ${status}`, r.message);
  }
  const sameDay = await attempt(`
    ${CLAIM()};
    INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies) VALUES ('1999-01-06', 9, ARRAY['weekly']);
    SELECT 1 AS ok;
  `);
  report(!sameDay.rejected, 'a morning and an afternoon slot on the same day are two posts', sameDay.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['a second claim on the same slot is refused (the duplicate-delivery guard)', `${CLAIM()}; ${CLAIM()};`, '23505'],
    ['a post DELETE is refused (history)', `${CLAIM()}; DELETE FROM public.${POSTS} ${WHERE_SLOT};`, '23514'],
    ['a claim inserted already finished is refused', `INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies, status, finished_at) VALUES (${SLOT}, ARRAY['daily'], 'posted', now());`, '23514'],
    ['a claim inserted with a message is refused (claim before send)', `INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies, message) VALUES (${SLOT}, ARRAY['daily'], 'x');`, '23514'],
    ['stamping a finished post again is refused (the outcome is final)', `${CLAIM()}; ${FINISH('refused')}; ${FINISH('posted')};`, '23514'],
    ['a stamp back to sending is refused', `${CLAIM()}; UPDATE public.${POSTS} SET status = 'sending' ${WHERE_SLOT};`, '23514'],
    ['moving a post to another slot is refused', `${CLAIM()}; UPDATE public.${POSTS} SET slot_hour = 9, status = 'posted', finished_at = now() ${WHERE_SLOT};`, '23514'],
    ["changing a post's frequencies is refused", `${CLAIM()}; UPDATE public.${POSTS} SET frequencies = ARRAY['weekly'], status = 'posted', finished_at = now() ${WHERE_SLOT};`, '23514'],
    ['a finished status without finished_at is refused', `${CLAIM()}; UPDATE public.${POSTS} SET status = 'posted' ${WHERE_SLOT};`, '23514'],
    ['a frequency the schedule never posts (bi-weekly) is refused', `${CLAIM("ARRAY['biweekly']")};`, '23514'],
    ['an empty frequency list is refused', `${CLAIM("ARRAY[]::text[]")};`, '23514'],
    ['an hour outside 0–23 is refused', `INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies) VALUES ('1999-01-06', 24, ARRAY['daily']);`, '23514'],
    ['a status outside the seven is refused', `${CLAIM()}; UPDATE public.${POSTS} SET status = 'sent', finished_at = now() ${WHERE_SLOT};`, '23514'],
  ];
  for (const [label, sql, code] of NEGATIVE) {
    const r = await attempt(sql);
    const ok = r.rejected && r.code === code;
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the posts table is live. Push the code now.');
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

/**
 * [Accounting Scoreboard: Setup → Scheduled Posts]  2026-10-09
 * Applies references/sql/create/2026-10-09_accounting_scoreboard_chat_schedules.sql.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-schedules-migration.mts            # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-schedules-migration.mts --dry      # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-schedules-migration.mts --apply
 *   node --import tsx scripts/apply-accounting-scoreboard-chat-schedules-migration.mts --verify
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The migration creates one
 * table, seeds it with the three posts that run today (only when it is empty), and widens two checks on the posts
 * table; it changes no existing row, so there is nothing to back up. Every control runs inside a SAVEPOINT that is
 * rolled back, so the controls write nothing even under --apply.
 *
 * Apply it BEFORE the push: the new code reads the schedules table, and without it every slot answers 503 "not set
 * up" and posts nothing. The code from before it keeps posting under the widened checks, so applying early is safe.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-09_accounting_scoreboard_chat_schedules.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const SCHEDULES = 'accounting_scoreboard_chat_schedules';
const POSTS = 'accounting_scoreboard_chat_posts';
const GUARD = 'acct_sb_chat_sched_guard';
const POSTS_GUARD = 'acct_sb_chat_posts_guard';

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

const COLUMNS = [
  'id', 'label', 'repeat', 'weekdays', 'month_days', 'post_hour', 'frequencies', 'template', 'paused',
  'timing_changed_at', 'created_by', 'created_at', 'updated_by', 'updated_at', 'archived_by', 'archived_at',
];

const CHECKS: Array<[string, string]> = [
  [`${SCHEDULES} exists`, `SELECT to_regclass('public.${SCHEDULES}') IS NOT NULL AS ok`],
  [
    `${SCHEDULES} has its ${COLUMNS.length} columns`,
    `SELECT count(*) = ${COLUMNS.length} AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${SCHEDULES}'
       AND column_name IN (${COLUMNS.map((c) => `'${c}'`).join(',')})`,
  ],
  [`${SCHEDULES}: the ${GUARD} trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${SCHEDULES}') AND tgname='${GUARD}' AND NOT tgisinternal) AS ok`],
  [`${SCHEDULES}: one live post per name (acct_sb_chat_sched_live_label)`, `SELECT to_regclass('public.acct_sb_chat_sched_live_label') IS NOT NULL AS ok`],
  [`${SCHEDULES}: row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${SCHEDULES}')), false) AS ok`],
  [`${SCHEDULES}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${SCHEDULES}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${SCHEDULES}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${SCHEDULES}', '${priv}') AS ok`,
    ]),
  ),
  ...[GUARD, POSTS_GUARD].map((fn): [string, string] => [
    `anon and authenticated cannot EXECUTE ${fn}()`,
    `SELECT NOT has_function_privilege('anon', 'public.${fn}()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.${fn}()', 'EXECUTE') AS ok`,
  ]),
  [`${SCHEDULES}: not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${SCHEDULES}') AS ok`],
  [`${POSTS}.schedule_ids exists (uuid[])`, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${POSTS}' AND column_name='schedule_ids' AND udt_name='_uuid') AS ok`],
  [`${POSTS}: still one post per slot`, `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.${POSTS}') AND conname='acct_sb_chat_posts_one_per_slot' AND contype='u') AS ok`],
  [`${POSTS}: still ZERO policies`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${POSTS}') AS ok`],
  [`${POSTS}: anon still has NO SELECT`, `SELECT NOT has_table_privilege('anon', 'public.${POSTS}', 'SELECT') AS ok`],
];

const DEFAULT_TEMPLATE = 'Current progress: {progress} have been completed. As you complete your tasks, remember to check them off.';
/** A control label no real post would carry; every control is rolled back anyway. */
const L = "'zz control post'";
const NEW = (cols = 'label, repeat, weekdays, post_hour, frequencies, template, created_by', vals = `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], 'x {progress}', 'control@'`) =>
  `INSERT INTO public.${SCHEDULES} (${cols}) VALUES (${vals})`;
const WHERE_L = `WHERE label = ${L}`;
const EDIT = (set: string) => `UPDATE public.${SCHEDULES} SET ${set}, updated_by = 'control@', updated_at = clock_timestamp() ${WHERE_L}`;
const SLOT = "'1999-01-06', 15";
const CLAIM = (freqs = "ARRAY['daily']", ids = "ARRAY[gen_random_uuid()]") =>
  `INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies, schedule_ids) VALUES (${SLOT}, ${freqs}, ${ids})`;
const WHERE_SLOT = `WHERE slot_date = '1999-01-06' AND slot_hour = 15`;

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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: Setup → Scheduled Posts`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check passes. It seeds the three posts (empty table only); no existing row changes.',
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

  const seeded = await client.query<{ label: string; repeat: string; weekdays: string[]; month_days: number[]; post_hour: number; frequencies: string[]; template: string; paused: boolean }>(
    `SELECT label, repeat, weekdays, month_days, post_hour, frequencies, template, paused FROM public.${SCHEDULES} WHERE archived_at IS NULL ORDER BY post_hour, label`,
  );
  console.log(`  ....  live posts: ${seeded.rows.length}`);
  for (const r of seeded.rows) {
    console.log(`        ${r.label}: ${r.repeat} ${r.weekdays.join(',') || ''}${r.month_days.join(',') || ''} at ${r.post_hour}:00 ET, counts ${r.frequencies.join('+')}${r.paused ? ' (paused)' : ''}`);
  }
  if (!verifyOnly) {
    const want = ['Daily', 'Monthly', 'Weekly'];
    const got = seeded.rows.map((r) => r.label).sort();
    report(got.length >= 3 && want.every((w) => got.includes(w)), 'the three posts are seeded (Daily, Weekly, Monthly)', got.join(', '));
    report(seeded.rows.filter((r) => want.includes(r.label)).every((r) => r.template === DEFAULT_TEMPLATE), "the seeded words are today's, word for word");
  }

  console.log('\nThe anon role is refused (42501; rolled back):');
  const anon = await attempt(`SET LOCAL ROLE anon; SELECT id FROM public.${SCHEDULES} LIMIT 1;`);
  report(anon.rejected && anon.code === '42501', `anon SELECT on ${SCHEDULES} is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');

  console.log('\nPositive controls (rolled back):');
  const life = await attempt(`
    ${NEW()};
    CREATE TEMP TABLE ctl_t ON COMMIT DROP AS SELECT timing_changed_at AS t0 FROM public.${SCHEDULES} ${WHERE_L};
    ${EDIT("template = 'y {progress}', label = 'zz control post'")};
    SELECT (SELECT timing_changed_at FROM public.${SCHEDULES} ${WHERE_L}) = (SELECT t0 FROM ctl_t) AS same_after_words;
  `);
  report(!life.rejected && (life.rows[0] as { same_after_words?: boolean } | undefined)?.same_after_words === true, 'editing the words or the name keeps timing_changed_at', life.message);
  const retime = await attempt(`
    ${NEW()};
    CREATE TEMP TABLE ctl_r ON COMMIT DROP AS SELECT timing_changed_at AS t0 FROM public.${SCHEDULES} ${WHERE_L};
    ${EDIT('post_hour = 10')};
    SELECT (SELECT timing_changed_at FROM public.${SCHEDULES} ${WHERE_L}) > (SELECT t0 FROM ctl_r) AS moved;
  `);
  report(!retime.rejected && (retime.rows[0] as { moved?: boolean } | undefined)?.moved === true, 'changing the hour moves timing_changed_at', retime.message);
  const forged = await attempt(`
    ${NEW()};
    ${EDIT("template = 'z {progress}', timing_changed_at = '2000-01-01'")};
    SELECT (SELECT timing_changed_at FROM public.${SCHEDULES} ${WHERE_L}) > '2000-01-02' AS kept;
  `);
  report(!forged.rejected && (forged.rows[0] as { kept?: boolean } | undefined)?.kept === true, 'the app cannot set timing_changed_at', forged.message);
  const pause = await attempt(`${NEW()}; ${EDIT('paused = true')}; ${EDIT('paused = false')}; SELECT 1 AS ok;`);
  report(!pause.rejected, 'pause, then resume', pause.message);
  const kinds = await attempt(`
    ${NEW('label, repeat, post_hour, frequencies, template, created_by', `${L}, 'every_day', 0, ARRAY['daily'], 'a', 'control@'`)};
    INSERT INTO public.${SCHEDULES} (label, repeat, month_days, post_hour, frequencies, template, created_by)
      VALUES ('zz control post 2', 'month_days', ARRAY[1, 15, 31]::smallint[], 23, ARRAY['biweekly', 'quarterly', 'annually'], 'b', 'control@');
    SELECT 1 AS ok;
  `);
  report(!kinds.rejected, 'every day at midnight; days 1, 15, 31 at 11 PM counting bi-weekly + quarterly + annual', kinds.message);
  const archive = await attempt(`
    ${NEW()};
    UPDATE public.${SCHEDULES} SET archived_at = now(), archived_by = 'control@' ${WHERE_L};
    ${NEW()};
    SELECT count(*)::int AS n FROM public.${SCHEDULES} ${WHERE_L};
  `);
  report(!archive.rejected && (archive.rows[0] as { n?: number } | undefined)?.n === 2, 'archive, then a new post with the same name', archive.message);
  const claim = await attempt(`
    ${CLAIM("ARRAY['weekly', 'biweekly', 'monthly']", 'ARRAY[gen_random_uuid(), gen_random_uuid()]')};
    UPDATE public.${POSTS} SET status = 'posted', finished_at = now(), message = 'm', progress = '[]'::jsonb ${WHERE_SLOT};
    SELECT 1 AS ok;
  `);
  report(!claim.rejected, 'a claim carrying two schedules and a bi-weekly count, stamped posted', claim.message);
  const legacy = await attempt(`INSERT INTO public.${POSTS} (slot_date, slot_hour, frequencies, schedule) VALUES (${SLOT}, ARRAY['daily'], '0 19 * * *'); SELECT 1 AS ok;`);
  report(!legacy.rejected, "the code from before this migration still claims (no schedule_ids)", legacy.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['a post DELETE is refused (archived, never deleted)', `${NEW()}; DELETE FROM public.${SCHEDULES} ${WHERE_L};`, '23514'],
    ['a post created already archived is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by, archived_at, archived_by', `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], 'x', 'c@', now(), 'c@'`)};`, '23514'],
    ['editing an archived post is refused (final)', `${NEW()}; UPDATE public.${SCHEDULES} SET archived_at = now(), archived_by = 'c@' ${WHERE_L}; ${EDIT("template = 'q'")};`, '23514'],
    ['archiving and editing in one write is refused', `${NEW()}; UPDATE public.${SCHEDULES} SET archived_at = now(), archived_by = 'c@', template = 'q' ${WHERE_L};`, '23514'],
    ['an edit without who and when is refused', `${NEW()}; UPDATE public.${SCHEDULES} SET template = 'q' ${WHERE_L};`, '23514'],
    ['changing who created a post is refused', `${NEW()}; ${EDIT("created_by = 'someone@'")};`, '23514'],
    ['a second live post with the same name, any case, is refused', `${NEW()}; ${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `'ZZ CONTROL POST', 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23505'],
    ['every day with weekdays is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'every_day', ARRAY['wed'], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['weekdays with none picked is refused', `${NEW('label, repeat, post_hour, frequencies, template, created_by', `${L}, 'weekdays', 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['a 32nd of the month is refused', `${NEW('label, repeat, month_days, post_hour, frequencies, template, created_by', `${L}, 'month_days', ARRAY[32]::smallint[], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['a day 0 is refused', `${NEW('label, repeat, month_days, post_hour, frequencies, template, created_by', `${L}, 'month_days', ARRAY[0]::smallint[], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['a weekday that is not one is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wednesday'], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['an hour of 24 is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wed'], 24, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ['counting as-needed tasks is refused (never counted)', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY['as_needed'], 'x', 'c@'`)};`, '23514'],
    ['counting nothing is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY[]::text[], 'x', 'c@'`)};`, '23514'],
    ['blank words are refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], '   ', 'c@'`)};`, '23514'],
    ['words over 1,000 characters are refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `${L}, 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], repeat('x', 1001), 'c@'`)};`, '23514'],
    ['a name with spaces around it is refused', `${NEW('label, repeat, weekdays, post_hour, frequencies, template, created_by', `' zz control post', 'weekdays', ARRAY['wed'], 9, ARRAY['weekly'], 'x', 'c@'`)};`, '23514'],
    ["a claim's schedules never change", `${CLAIM()}; UPDATE public.${POSTS} SET schedule_ids = ARRAY[gen_random_uuid()], status = 'posted', finished_at = now() ${WHERE_SLOT};`, '23514'],
    ['a claim carrying an empty schedule list is refused', `${CLAIM("ARRAY['daily']", 'ARRAY[]::uuid[]')};`, '23514'],
    ['a claim counting as-needed is refused', `${CLAIM("ARRAY['as_needed']")};`, '23514'],
    ['a second claim on the same slot is still refused', `${CLAIM()}; ${CLAIM()};`, '23505'],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — Scheduled Posts is live in the database. Push the code now.');
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

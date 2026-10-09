/**
 * [Accounting Scoreboard: Keys, the paid platforms each person holds a seat on]  2026-10-09, Open item 424
 * Applies references/sql/create/2026-10-09_accounting_scoreboard_keys.sql.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-keys-migration.mts            # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-keys-migration.mts --dry      # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-keys-migration.mts --apply
 *   node --import tsx scripts/apply-accounting-scoreboard-keys-migration.mts --verify
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The migration creates two
 * empty tables and writes no data, so there is nothing to back up. Every control runs inside a SAVEPOINT that is
 * rolled back, so the controls write nothing even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * The board read (readBoard) never touches these tables: until they exist only Setup → Keys says "not set up yet".
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard-keys.md.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-09_accounting_scoreboard_keys.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const KEYS = 'accounting_scoreboard_keys';
const SEATS = 'accounting_scoreboard_key_seats';

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

const tableChecks = (t: string, columns: string[], guard: string): Array<[string, string]> => [
  [`${t} exists`, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`],
  [
    `${t} has its ${columns.length} columns`,
    `SELECT count(*) = ${columns.length} AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'
       AND column_name IN (${columns.map((c) => `'${c}'`).join(',')})`,
  ],
  [`${t}: the ${guard} trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${t}') AND tgname='${guard}' AND NOT tgisinternal) AS ok`],
  [`${t}: row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${t}')), false) AS ok`],
  [`${t}: ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${t}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${t}: ${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${t}', '${priv}') AS ok`,
    ]),
  ),
  [
    `${t}: anon and authenticated cannot EXECUTE ${guard}()`,
    `SELECT NOT has_function_privilege('anon', 'public.${guard}()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.${guard}()', 'EXECUTE') AS ok`,
  ],
  [`${t}: not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${t}') AS ok`],
];

const CHECKS: Array<[string, string]> = [
  ...tableChecks(KEYS, ['id', 'label', 'created_by', 'created_at', 'archived_by', 'archived_at'], 'acct_sb_keys_guard'),
  ...tableChecks(SEATS, ['id', 'key_id', 'email', 'given_by', 'given_at', 'removed_by', 'removed_at'], 'acct_sb_key_seats_guard'),
  [`one live key per name (acct_sb_keys_one_live_label)`, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${KEYS}' AND indexname='acct_sb_keys_one_live_label') AS ok`],
  [`one live seat per key per person (acct_sb_key_seats_one_live)`, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${SEATS}' AND indexname='acct_sb_key_seats_one_live') AS ok`],
];

const BY = "'acct-sb-control@simple.biz'";
const LABEL = "'Control key'";
const NEW_KEY = `INSERT INTO public.${KEYS} (label, created_by) VALUES (${LABEL}, ${BY})`;
const KEY_ID = `(SELECT id FROM public.${KEYS} WHERE label = ${LABEL} AND archived_at IS NULL)`;
const give = (email = "'acct-sb-holder@simple.biz'") =>
  `INSERT INTO public.${SEATS} (key_id, email, given_by) VALUES (${KEY_ID}, ${email}, ${BY});`;
const removeSeats = `UPDATE public.${SEATS} SET removed_at = now(), removed_by = ${BY} WHERE key_id IN (SELECT id FROM public.${KEYS} WHERE label = ${LABEL}) AND removed_at IS NULL;`;
const archiveKey = `UPDATE public.${KEYS} SET archived_at = now(), archived_by = ${BY} WHERE label = ${LABEL} AND archived_at IS NULL;`;

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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: Keys`,
      '',
      `  SQL : ${SQL_PATH}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL is COMMITTED when every check passes. It creates two empty tables; no data is written.',
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
  const counts = await client.query<{ keys: number; seats: number }>(
    `SELECT (SELECT count(*)::int FROM public.${KEYS}) AS keys, (SELECT count(*)::int FROM public.${SEATS}) AS seats`,
  );
  console.log(`  ....  rows: ${counts.rows[0]?.keys} key(s), ${counts.rows[0]?.seats} seat(s)`);

  console.log("\nSetup → Keys' own reads (server.ts readKeys):");
  const keysRead = await attempt(`SELECT id, label, created_by, created_at, archived_at FROM public.${KEYS} ORDER BY id LIMIT 1;`);
  report(!keysRead.rejected, `${KEYS}: the keys select answers`, keysRead.message);
  const seatsRead = await attempt(
    `SELECT id, key_id, email, given_by, given_at, removed_by, removed_at FROM public.${SEATS} ORDER BY id LIMIT 1;`,
  );
  report(!seatsRead.rejected, `${SEATS}: the seats select answers`, seatsRead.message);

  console.log('\nThe anon role is refused (42501; rolled back):');
  for (const t of [KEYS, SEATS]) {
    const anon = await attempt(`SET LOCAL ROLE anon; SELECT id FROM public.${t} LIMIT 1;`);
    report(anon.rejected && anon.code === '42501', `anon SELECT on ${t} is refused`, anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');
  }

  console.log('\nPositive controls (rolled back):');
  const life = await attempt(`
    ${NEW_KEY};
    ${give()}
    ${give("'acct-sb-holder2@simple.biz'")}
    ${removeSeats}
    ${give()}
    ${removeSeats}
    ${archiveKey}
    SELECT (SELECT count(*)::int FROM public.${SEATS} WHERE key_id IN (SELECT id FROM public.${KEYS} WHERE label = ${LABEL})) AS n;
  `);
  report(
    !life.rejected && (life.rows[0] as { n?: number } | undefined)?.n === 3,
    'create → give two seats → remove → give again (history kept) → remove → archive once nobody holds it',
    life.message,
  );
  const sameNameLater = await attempt(`${NEW_KEY}; ${archiveKey} ${NEW_KEY}; SELECT 1 AS ok;`);
  report(!sameNameLater.rejected, 'a name can be used again once its old key is archived', sameNameLater.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['a key DELETE is refused (archived, never deleted)', `${NEW_KEY}; DELETE FROM public.${KEYS} WHERE label = ${LABEL};`, '23514'],
    ["renaming a key in place is refused", `${NEW_KEY}; UPDATE public.${KEYS} SET label = 'Renamed' WHERE label = ${LABEL};`, '23514'],
    ['archiving a key while someone holds a seat on it is refused', `${NEW_KEY}; ${give()} ${archiveKey}`, '23514'],
    ['a key created already archived is refused', `INSERT INTO public.${KEYS} (label, created_by, archived_at, archived_by) VALUES (${LABEL}, ${BY}, now(), ${BY});`, '23514'],
    ['archiving twice is refused (the stamp is final)', `${NEW_KEY}; ${archiveKey} UPDATE public.${KEYS} SET archived_at = now(), archived_by = 'someone@simple.biz' WHERE label = ${LABEL};`, '23514'],
    ['an archive stamp without who archived it is refused', `${NEW_KEY}; UPDATE public.${KEYS} SET archived_at = now() WHERE label = ${LABEL};`, '23514'],
    ['a blank key name is refused', `INSERT INTO public.${KEYS} (label, created_by) VALUES ('   ', ${BY});`, '23514'],
    ['a key name over 40 characters is refused', `INSERT INTO public.${KEYS} (label, created_by) VALUES (repeat('x', 41), ${BY});`, '23514'],
    ['a second LIVE key with the same name in another case is refused', `${NEW_KEY}; INSERT INTO public.${KEYS} (label, created_by) VALUES ('CONTROL KEY', ${BY});`, '23505'],
    ['a second LIVE seat for the same key and person is refused', `${NEW_KEY}; ${give()} ${give()}`, '23505'],
    ['a seat on an archived key is refused', `${NEW_KEY}; ${archiveKey} INSERT INTO public.${SEATS} (key_id, email, given_by) SELECT id, 'acct-sb-holder@simple.biz', ${BY} FROM public.${KEYS} WHERE label = ${LABEL};`, '23514'],
    ['a seat DELETE is refused (removed, never deleted)', `${NEW_KEY}; ${give()} DELETE FROM public.${SEATS} WHERE email = 'acct-sb-holder@simple.biz';`, '23514'],
    ['removing a seat twice is refused (the stamp is final)', `${NEW_KEY}; ${give()} ${removeSeats} UPDATE public.${SEATS} SET removed_at = now(), removed_by = 'someone@simple.biz' WHERE email = 'acct-sb-holder@simple.biz';`, '23514'],
    ['moving a seat to another person is refused', `${NEW_KEY}; ${give()} UPDATE public.${SEATS} SET email = 'someone@simple.biz' WHERE email = 'acct-sb-holder@simple.biz';`, '23514'],
    ['a removal without who removed it is refused', `${NEW_KEY}; ${give()} UPDATE public.${SEATS} SET removed_at = now() WHERE email = 'acct-sb-holder@simple.biz';`, '23514'],
    ['a seat created already removed is refused', `${NEW_KEY}; INSERT INTO public.${SEATS} (key_id, email, given_by, removed_at, removed_by) VALUES (${KEY_ID}, 'acct-sb-holder@simple.biz', ${BY}, now(), ${BY});`, '23514'],
    ['a holder that is not a lower-case, trimmed address is refused', `${NEW_KEY}; ${give("' Acct-SB-Holder@simple.biz'")}`, '23514'],
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
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — the Keys tables are live. Deploy the code now.');
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

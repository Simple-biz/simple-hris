/**
 * [Accounting Scoreboard: board-local roles — Admin / Assistant / Team member]  2026-10-08, Open item 393
 * Applies references/sql/create/2026-10-08_accounting_scoreboard_roles.sql and seeds the board's two Admin grants.
 *
 *   node --import tsx scripts/apply-accounting-scoreboard-roles-migration.mts --admin carla@simple.biz [--admin <second>]
 *                                                                                       # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-accounting-scoreboard-roles-migration.mts --dry --admin … --admin …   # same, explicitly
 *   node --import tsx scripts/apply-accounting-scoreboard-roles-migration.mts --apply --admin carla@simple.biz --admin <second>
 *   node --import tsx scripts/apply-accounting-scoreboard-roles-migration.mts --verify
 *
 * --apply REFUSES without exactly two distinct Admin emails (Carla, and the second Admin she names: plan W0.6,
 * "in case I get kicked off the team"). A dry run seeds whatever it is given and says what is missing.
 *
 * It prints, READ-ONLY and as COUNTS, never names, what the change does to the HRIS `accounting` holders
 * (Kane, 2026-10-07, item 393: "HRIS accounting alone no longer makes a scoreboard manager"): how many stay
 * Admin, how many lose Setup and keep access as a Team member or Assistant, and how many lose access entirely
 * (on neither a live person row nor the member list, with no grant). Kane sees those before --apply.
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back. The only data step is
 * the Admin seed (INSERT, no UPDATE of existing rows), so there is nothing to back up. Every control runs inside
 * a SAVEPOINT that is rolled back, so the controls write nothing even under --apply.
 *
 * Needs DATABASE_URL in .env.local: the SESSION POOLER (memory/migration-apply-needs-database-url).
 * Apply BEFORE the code is deployed: every board request by anyone who is not an HRIS admin reads this table,
 * and until it exists those requests answer "not set up yet" (server.ts isMissingTable).
 * Do not double-click this file: Windows opens .mts as video.
 * Governing doc: docs/features/accounting-scoreboard.md § Who may open it.
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

const SQL_RELATIVE = 'references/sql/create/2026-10-08_accounting_scoreboard_roles.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}

const T = 'accounting_scoreboard_roles';
const SEEDED_BY = 'migration 2026-10-08 (item 393)';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const admins: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--admin') continue;
  const v = (argv[i + 1] ?? '').trim().toLowerCase();
  if (!EMAIL.test(v)) {
    console.error(`--admin needs a work email, got "${argv[i + 1] ?? ''}"`);
    process.exit(1);
  }
  if (!admins.includes(v)) admins.push(v);
}
if (wantApply && admins.length !== 2) {
  console.error(
    `--apply needs exactly two distinct Admin emails (--admin carla@simple.biz --admin <second Admin>); got ${admins.length}.\n` +
      'The second Admin is Carla\'s to name (plan W0.6). Nothing was written.',
  );
  process.exit(1);
}
if (verifyOnly && admins.length) {
  console.error('--verify takes no --admin: it seeds nothing.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add the SESSION POOLER URI to .env.local (memory/migration-apply-needs-database-url).');
  process.exit(1);
}

const CHECKS: Array<[string, string]> = [
  [`${T} exists`, `SELECT to_regclass('public.${T}') IS NOT NULL AS ok`],
  [
    `${T} has the board's columns`,
    `SELECT count(*) = 7 AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${T}'
       AND column_name IN ('id','email','role','granted_by','granted_at','revoked_by','revoked_at')`,
  ],
  [`one live grant per address (acct_sb_roles_one_live)`, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='${T}' AND indexname='acct_sb_roles_one_live') AS ok`],
  [`the append-only + last-Admin trigger is attached`, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.${T}') AND tgname='acct_sb_roles_guard' AND NOT tgisinternal) AS ok`],
  [`row level security is ENABLED`, `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.${T}')), false) AS ok`],
  [`ZERO policies (service role only)`, `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${T}') AS ok`],
  ...(['anon', 'authenticated'] as const).flatMap((role) =>
    (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).map((priv): [string, string] => [
      `${role} has NO ${priv} privilege`,
      `SELECT NOT has_table_privilege('${role}', 'public.${T}', '${priv}') AS ok`,
    ]),
  ),
  [
    `anon and authenticated cannot EXECUTE the guard function`,
    `SELECT NOT has_function_privilege('anon', 'public.acct_sb_roles_guard()', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.acct_sb_roles_guard()', 'EXECUTE') AS ok`,
  ],
  [`not in supabase_realtime`, `SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='${T}') AS ok`],
  [`the board keeps at least one live Admin grant`, `SELECT EXISTS (SELECT 1 FROM public.${T} WHERE role='admin' AND revoked_at IS NULL) AS ok`],
];

/**
 * What the change does to the HRIS `accounting` holders, COUNTS ONLY. An address's aliases are its live master
 * row's three work emails (the identity bridge `expandWorkEmailAliases` uses).
 */
const IMPACT_SQL = `
WITH acct AS (
  SELECT DISTINCT lower(btrim(work_email)) AS e FROM public.employee_roles
   WHERE role = 'accounting' AND revoked_at IS NULL AND btrim(coalesce(work_email, '')) <> ''
), gml AS (
  SELECT array_remove(ARRAY[lower(btrim("Work Email")), lower(btrim("Alternate Work Email")), lower(btrim("Alternate Work Email 2"))], NULL) AS addrs
    FROM public.global_master_list WHERE off_boarded_at IS NULL
), al AS (
  SELECT a.e, x AS alias FROM acct a JOIN gml g ON a.e = ANY (g.addrs) CROSS JOIN LATERAL unnest(g.addrs) AS x WHERE x <> ''
  UNION SELECT e, e FROM acct
), per AS (
  SELECT al.e,
    bool_or(EXISTS (SELECT 1 FROM public.employee_roles r WHERE r.role = 'admin' AND r.revoked_at IS NULL AND lower(btrim(r.work_email)) = al.alias)) AS hris_admin,
    bool_or(EXISTS (SELECT 1 FROM public.${T} g WHERE g.revoked_at IS NULL AND g.role = 'admin' AND g.email = al.alias)) AS grant_admin,
    bool_or(EXISTS (SELECT 1 FROM public.${T} g WHERE g.revoked_at IS NULL AND g.role = 'assistant' AND g.email = al.alias)) AS grant_assistant,
    bool_or(EXISTS (SELECT 1 FROM public.accounting_scoreboard_rows w WHERE w.archived_at IS NULL AND lower(btrim(w.work_email)) = al.alias)
         OR EXISTS (SELECT 1 FROM public.accounting_scoreboard_members m WHERE m.removed_at IS NULL AND lower(btrim(m.work_email)) = al.alias)) AS on_member_list
    FROM al GROUP BY al.e
)
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE hris_admin)::int AS hris_admin,
       count(*) FILTER (WHERE NOT hris_admin AND grant_admin)::int AS granted_admin,
       count(*) FILTER (WHERE NOT (hris_admin OR grant_admin))::int AS lose_manager,
       count(*) FILTER (WHERE NOT (hris_admin OR grant_admin) AND grant_assistant)::int AS become_assistant,
       count(*) FILTER (WHERE NOT (hris_admin OR grant_admin OR grant_assistant) AND on_member_list)::int AS become_member,
       count(*) FILTER (WHERE NOT (hris_admin OR grant_admin OR grant_assistant OR on_member_list))::int AS lose_access
  FROM per`;

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
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Accounting Scoreboard: board-local roles (Admin / Assistant / Team member)`,
      '',
      `  SQL    : ${SQL_PATH}`,
      verifyOnly ? '' : `  Admins : ${admins.length ? admins.join(', ') : '(none given)'}${admins.length < 2 ? '   ← the second Admin is MISSING (plan W0.6); --apply will refuse' : ''}`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL and the Admin seed run inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL and the Admin seed are COMMITTED when every check passes.',
      '',
    ].join('\n'),
  );

  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  if (!verifyOnly) {
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    console.log('Seed (INSERT only; an address that already holds a live grant keeps it):');
    for (const email of admins) {
      const r = await client.query<{ role: string; seeded: boolean }>(
        `WITH ins AS (
           INSERT INTO public.${T} (email, role, granted_by) VALUES ($1, 'admin', $2)
           ON CONFLICT (email) WHERE revoked_at IS NULL DO NOTHING RETURNING role
         )
         SELECT COALESCE((SELECT role FROM ins), (SELECT role FROM public.${T} WHERE email = $1 AND revoked_at IS NULL)) AS role,
                EXISTS (SELECT 1 FROM ins) AS seeded`,
        [email, SEEDED_BY],
      );
      const row = r.rows[0];
      report(row?.role === 'admin', `${email} holds a live Admin grant`, row?.seeded ? 'seeded now' : `already held: ${row?.role ?? 'nothing'}`);
    }
    console.log('');
  }

  console.log('Objects and privileges:');
  const results = (await client.query(CHECKS.map(([, sql]) => `${sql};`).join('\n'))) as unknown as Array<{ rows: Array<{ ok: boolean }> }>;
  CHECKS.forEach(([label], i) => report(Boolean(results[i]?.rows[0]?.ok), label));
  const live = await client.query<{ admins: number; assistants: number }>(
    `SELECT count(*) FILTER (WHERE role='admin')::int AS admins, count(*) FILTER (WHERE role='assistant')::int AS assistants
       FROM public.${T} WHERE revoked_at IS NULL`,
  );
  console.log(`  ....  live grants: ${live.rows[0]?.admins} Admin, ${live.rows[0]?.assistants} Assistant`);

  console.log("\nThe board's own reads (server.ts):");
  const read = await attempt(`SELECT email, role FROM public.${T} WHERE revoked_at IS NULL AND email IN ('carla@simple.biz') LIMIT 1;`);
  report(!read.rejected, `${T}: the access check's select answers`, read.message);
  const list = await attempt(`SELECT id, email, role, granted_by, granted_at FROM public.${T} WHERE revoked_at IS NULL ORDER BY id LIMIT 1;`);
  report(!list.rejected, `${T}: the Access area's select answers`, list.message);

  console.log('\nThe anon role is refused (42501; rolled back):');
  const anon = await attempt(`SET LOCAL ROLE anon; SELECT email FROM public.${T} LIMIT 1;`);
  report(anon.rejected && anon.code === '42501', 'anon SELECT is refused', anon.rejected ? (anon.code === '42501' ? '' : `refused with ${anon.code}: ${anon.message}`) : 'it was ACCEPTED');

  console.log('\nPositive controls (rolled back):');
  const grantRevoke = await attempt(`
    INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY});
    UPDATE public.${T} SET revoked_at = now(), revoked_by = ${BY} WHERE email = 'acct-sb-control@simple.biz' AND revoked_at IS NULL;
    INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'admin', ${BY});
    SELECT count(*)::int AS n FROM public.${T} WHERE email = 'acct-sb-control@simple.biz';
  `);
  report(
    !grantRevoke.rejected && (grantRevoke.rows[0] as { n?: number } | undefined)?.n === 2,
    'grant Assistant → revoke → grant Admin (a role change is a revoke and a new grant; history kept)',
    grantRevoke.message,
  );
  const secondAdmin = await attempt(`
    INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'admin', ${BY});
    UPDATE public.${T} SET revoked_at = now(), revoked_by = ${BY} WHERE email = 'acct-sb-control@simple.biz' AND revoked_at IS NULL;
    SELECT 1 AS ok;
  `);
  report(!secondAdmin.rejected, 'an Admin grant can be revoked while another live Admin grant remains', secondAdmin.message);

  console.log('\nNegative controls (each must be REFUSED; rolled back):');
  const NEGATIVE: Array<[string, string, string]> = [
    ['revoking EVERY live Admin grant is refused (the board keeps one Admin)', `UPDATE public.${T} SET revoked_at = now(), revoked_by = ${BY} WHERE role = 'admin' AND revoked_at IS NULL;`, '23514'],
    ['a DELETE is refused (revoked, never deleted)', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}); DELETE FROM public.${T} WHERE email = 'acct-sb-control@simple.biz';`, '23514'],
    ['changing a live grant\'s role in place is refused', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}); UPDATE public.${T} SET role = 'admin' WHERE email = 'acct-sb-control@simple.biz';`, '23514'],
    ['revoking twice is refused (the stamp is final)', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}); UPDATE public.${T} SET revoked_at = now(), revoked_by = ${BY} WHERE email = 'acct-sb-control@simple.biz'; UPDATE public.${T} SET revoked_at = now(), revoked_by = 'someone@simple.biz' WHERE email = 'acct-sb-control@simple.biz';`, '23514'],
    ['a grant created already revoked is refused', `INSERT INTO public.${T} (email, role, granted_by, revoked_at, revoked_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}, now(), ${BY});`, '23514'],
    ['a second LIVE grant for one address is refused', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}), ('acct-sb-control@simple.biz', 'admin', ${BY});`, '23505'],
    ['a role outside admin / assistant is refused', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'manager', ${BY});`, '23514'],
    ['an address that is not lower-case and trimmed is refused', `INSERT INTO public.${T} (email, role, granted_by) VALUES (' Acct-SB-Control@simple.biz', 'assistant', ${BY});`, '23514'],
    ['a revoke without who revoked it is refused', `INSERT INTO public.${T} (email, role, granted_by) VALUES ('acct-sb-control@simple.biz', 'assistant', ${BY}); UPDATE public.${T} SET revoked_at = now() WHERE email = 'acct-sb-control@simple.biz';`, '23514'],
  ];
  for (const [label, sql, code] of NEGATIVE) {
    const r = await attempt(sql);
    const ok = r.rejected && r.code === code;
    report(ok, label, r.rejected ? (ok ? '' : `refused for another reason: ${r.code} ${r.message}`) : 'it was ACCEPTED');
  }

  console.log('\nWhat it does to the HRIS `accounting` holders (READ-ONLY, counts, never names):');
  const imp = (await client.query(IMPACT_SQL)).rows[0] as Record<string, number> | undefined;
  if (imp) {
    console.log(`  ${imp.total} hold HRIS accounting today, and every one of them manages the board today.`);
    console.log(`  ${imp.hris_admin} also hold HRIS admin            → stay board Admin (break glass)`);
    console.log(`  ${imp.granted_admin} hold an Admin grant             → stay board Admin`);
    console.log(`  ${imp.lose_manager} LOSE manager rights (Setup, deleting or unchecking anyone's line):`);
    console.log(`     ${imp.become_assistant} hold an Assistant grant         → Assistant (Setup read-only)`);
    console.log(`     ${imp.become_member} are on the member list           → Team member`);
    console.log(`     ${imp.lose_access} LOSE ACCESS ENTIRELY (no person row, not a member, no grant) — add them under Setup → Members to keep them`);
  }

  if (!dryRun && !verifyOnly && failed === 0) {
    await client.query('COMMIT');
  } else {
    await client.query('ROLLBACK');
    if (dryRun) console.log('\nRolled back — production is unchanged. Re-run with --apply and both --admin emails to commit.');
    if (!dryRun && !verifyOnly && failed) console.log('\nRolled back because a check failed — nothing was committed.');
  }
  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log(verifyOnly || dryRun ? '\nAll checks passed.' : '\nAll checks passed — board-local roles are live. Deploy the code now.');
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

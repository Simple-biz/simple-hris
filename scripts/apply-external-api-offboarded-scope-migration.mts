/**
 * [EXTERNAL-API-OFFBOARDED-SCOPE]
 * Applies references/sql/alter/2026-10-07_external_api_offboarded_scope.sql — widens the
 * external_api_clients_scopes_known CHECK to admit 'offboarded.read' (the leavers list,
 * GET /api/external/v1/offboarded + the MCP tool query_offboarded) — then proves the CHECK
 * accepts exactly the two known scopes and still refuses everything else.
 *
 *   node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run inside a transaction that is always rolled back.
 * The SQL touches no row: every existing client keeps the scopes it has (printed before and
 * after, and the run FAILS if any changed).
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER on 5432
 * (memory/migration-apply-needs-database-url).
 *
 * Until this runs, ticking "Offboarded" on a client is refused by the CHECK; the admin route
 * turns that into a 503 naming this script, and no key can reach /api/external/v1/offboarded.
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

const SQL_RELATIVE = 'references/sql/alter/2026-10-07_external_api_offboarded_scope.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const CLIENTS = 'public.external_api_clients';

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
  ['external_api_clients exists', `SELECT to_regclass('${CLIENTS}') IS NOT NULL AS ok`],
  [
    'constraint external_api_clients_scopes_known exists',
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_api_clients_scopes_known') AS ok`,
  ],
  [
    'the CHECK names offboarded.read',
    `SELECT COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%offboarded.read%'
                        FROM pg_constraint WHERE conname = 'external_api_clients_scopes_known'), false) AS ok`,
  ],
  [
    'the CHECK still names global_master_list.read',
    `SELECT COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%global_master_list.read%'
                        FROM pg_constraint WHERE conname = 'external_api_clients_scopes_known'), false) AS ok`,
  ],
  [
    'the CHECK is an ENUMERATION (<@ array), not a pattern',
    `SELECT COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%<@%' AND pg_get_constraintdef(oid) NOT LIKE '%~%'
                        FROM pg_constraint WHERE conname = 'external_api_clients_scopes_known'), false) AS ok`,
  ],
  [
    'row level security is still ENABLED with NO policies',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${CLIENTS}')), false)
        AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='external_api_clients') AS ok`,
  ],
  [
    'the scopes column default is still roster-only',
    `SELECT COALESCE((SELECT column_default LIKE '%global_master_list.read%' AND column_default NOT LIKE '%offboarded%'
                        FROM information_schema.columns
                       WHERE table_schema='public' AND table_name='external_api_clients' AND column_name='scopes'), false) AS ok`,
  ],
];

const HASH_A = "'" + 'a'.repeat(64) + "'";
const LEGAL_CLIENT: Record<string, string> = {
  id: "'00000000-0000-4000-8000-0000000000aa'",
  name: "'Control client'",
  system: "'control-suite'",
  key_prefix: "'hris_live_abc123'",
  key_hash: HASH_A,
  scopes: "array['global_master_list.read']",
  created_by: "'control@simple.biz'",
};
function insertClient(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_CLIENT, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${CLIENTS} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const POSITIVE_CONTROLS: Array<[string, string]> = [
  ['a roster-only client is ACCEPTED (unchanged)', insertClient()],
  ['an offboarded-only client is ACCEPTED', insertClient({ scopes: "array['offboarded.read']" })],
  ['a client holding both scopes is ACCEPTED', insertClient({ scopes: "array['global_master_list.read','offboarded.read']" })],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['an unknown scope is rejected', insertClient({ scopes: "array['offboarded.write']" })],
  ['a known scope beside an unknown one is rejected', insertClient({ scopes: "array['offboarded.read','bank_info.read']" })],
  ['a typo of the new scope is rejected', insertClient({ scopes: "array['offboard.read']" })],
  ['an empty scope list is rejected', insertClient({ scopes: 'array[]::text[]' })],
];

type ScopeRow = { id: string; name: string; scopes: string[] };

const client = new Client({ connectionString });

async function readScopes(): Promise<ScopeRow[]> {
  const { rows } = await client.query<ScopeRow>(`SELECT id::text, name, scopes FROM ${CLIENTS} ORDER BY created_at`);
  return rows;
}

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — External API offboarded.read scope`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Controls : ${POSITIVE_CONTROLS.length} positive, ${NEGATIVE_CONTROLS.length} negative`,
      '',
      verifyOnly
        ? '  Nothing is written; the CHECK is only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL will be COMMITTED to the database DATABASE_URL points at.',
      '',
    ].join('\n'),
  );

  await client.connect();

  const before = await readScopes();
  console.log(`Clients before (${before.length}):`);
  for (const r of before) console.log(`  ${r.name.padEnd(32)} ${JSON.stringify(r.scopes)}`);
  console.log('');

  if (dryRun) {
    await client.query('BEGIN');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    console.log('  applied.\n');
  }

  let failed = 0;
  console.log('Verifying:');
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  const after = await readScopes();
  const changed = after.filter((a) => {
    const b = before.find((x) => x.id === a.id);
    return !b || JSON.stringify(b.scopes) !== JSON.stringify(a.scopes);
  });
  const sameRows = after.length === before.length && changed.length === 0;
  if (!sameRows) failed++;
  console.log(`  ${sameRows ? 'OK  ' : 'MISS'}  every existing client kept exactly its scopes (${after.length} rows)`);

  console.log('\nVerifying the CHECK bites:');
  if (!dryRun) await client.query('BEGIN');
  for (const [label, sql] of POSITIVE_CONTROLS) {
    await client.query('SAVEPOINT pc');
    let accepted = true;
    try {
      await client.query(sql);
    } catch {
      accepted = false;
    }
    await client.query('ROLLBACK TO SAVEPOINT pc');
    if (!accepted) failed++;
    console.log(`  ${accepted ? 'OK  ' : 'MISS'}  ${label}`);
  }
  for (const [label, sql] of NEGATIVE_CONTROLS) {
    await client.query('SAVEPOINT nc');
    let rejected = false;
    try {
      await client.query(sql);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT nc');
    if (!rejected) failed++;
    console.log(`  ${rejected ? 'OK  ' : 'MISS'}  ${label}`);
  }
  await client.query('ROLLBACK');
  if (dryRun) console.log('\nDRY RUN — rolled back. Production is unchanged.');

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll checks passed.${dryRun ? ' Re-run with --apply to commit.' : ''}`);
  }
}

main()
  .catch((err: unknown) => {
    console.error('\nMigration script failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));

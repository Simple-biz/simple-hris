/**
 * [EXTERNAL-API-CLIENTS]
 * Applies references/sql/create/2026-09-16_external_api_clients.sql — the per-client
 * key registry and the per-call request log behind /api/external/v1/* and /api/external/mcp
 * (Admin → Webhooks & Integrations → Integrations) — then verifies both tables, their comments, indexes,
 * CHECK constraints and row-level security landed, AND that each constraint actually
 * rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-external-api-clients-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-external-api-clients-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-external-api-clients-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-external-api-clients-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The dry run applies the SQL and runs every
 * check inside a transaction it always rolls back; Postgres DDL is transactional, so
 * this proves the migration parses, the tables build and the CHECKs bite while leaving
 * production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER on 5432, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The SQL is idempotent and touches no row data, so a re-run is a no-op. Run it BEFORE
 * an admin creates the first client; until then the Integrations tab reads
 * "table not applied yet" and /api/external/v1/* + /api/external/mcp answer 503.
 *
 * 2026-09-17: the SQL was amended IN PLACE before it was ever applied — per-client
 * granted_columns (NULL = whole table), expires_at (NULL = never) and rate_limit_per_minute
 * (1..600, default 60); the request log admits POST (the MCP route).
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

const SQL_RELATIVE = 'references/sql/create/2026-09-16_external_api_clients.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const CLIENTS = 'public.external_api_clients';
const REQUESTS = 'public.external_api_requests';

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

const CONSTRAINTS = [
  'external_api_clients_name_present',
  'external_api_clients_system_present',
  'external_api_clients_key_hash_hex',
  'external_api_clients_key_hash_unique',
  'external_api_clients_prefix_shape',
  'external_api_clients_scopes_known',
  'external_api_clients_granted_columns_nonempty',
  'external_api_clients_rate_limit_range',
  'external_api_clients_revoked_shape',
  'external_api_requests_status_range',
  'external_api_requests_method_known',
  'external_api_requests_outcome_shape',
];
const INDEXES = [
  'external_api_clients_live_idx',
  'external_api_requests_client_time_idx',
  'external_api_requests_time_idx',
];

function rlsChecks(table: string, bare: string): Array<[string, string]> {
  return [
    [`${bare} table exists`, `SELECT to_regclass('${table}') IS NOT NULL AS ok`],
    [
      `${bare} row level security is ENABLED`,
      `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${table}')), false) AS ok`,
    ],
    [
      `${bare} has NO policies (anon/authenticated get zero rows)`,
      `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${bare}') AS ok`,
    ],
  ];
}

const CHECKS: Array<[string, string]> = [
  ...rlsChecks(CLIENTS, 'external_api_clients'),
  ...rlsChecks(REQUESTS, 'external_api_requests'),
  [
    'clients comment says the key is NEVER stored',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${CLIENTS}'), 'pg_class') LIKE '%NEVER stored%'), false) AS ok`,
  ],
  [
    'requests comment says APPEND-ONLY',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${REQUESTS}'), 'pg_class') LIKE '%APPEND-ONLY%'), false) AS ok`,
  ],
  [
    'clients.id is uuid with a default',
    `SELECT COALESCE(
       (SELECT data_type = 'uuid' AND column_default IS NOT NULL
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='external_api_clients' AND column_name='id'), false) AS ok`,
  ],
  [
    'clients.rate_limit_per_minute defaults to 60',
    `SELECT COALESCE(
       (SELECT column_default LIKE '60%'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='external_api_clients' AND column_name='rate_limit_per_minute'), false) AS ok`,
  ],
  [
    'clients.granted_columns and expires_at are NULLABLE (NULL = whole table / never expires)',
    `SELECT COALESCE(
       (SELECT bool_and(is_nullable = 'YES')
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='external_api_clients'
           AND column_name IN ('granted_columns', 'expires_at')), false) AS ok`,
  ],
  [
    'requests.client_id references clients with ON DELETE RESTRICT (history is kept)',
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('${REQUESTS}') AND contype = 'f' AND confdeltype = 'r'
     ) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
];

const HASH_A = "'" + 'a'.repeat(64) + "'";

/** The ONE legal client row every control deviates from by exactly one field. */
const LEGAL_CLIENT: Record<string, string> = {
  id: "'00000000-0000-4000-8000-000000000001'",
  name: "'Control client'",
  system: "'control-suite'",
  contact_email: "'control@simple.biz'",
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

/** A legal SUCCESS request row (needs the control client to exist first). */
const LEGAL_REQUEST: Record<string, string> = {
  client_id: LEGAL_CLIENT.id,
  key_prefix: "'hris_live_abc123'",
  method: "'GET'",
  path: "'/api/external/v1/global-master-list'",
  query: `'{"limit":100}'::jsonb`,
  status: '200',
  row_count: '100',
  denial: 'NULL',
  ip: "'203.0.113.7'",
  user_agent: "'control/1.0'",
  duration_ms: '42',
};

function insertRequest(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_REQUEST, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${REQUESTS} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const POSITIVE_CONTROLS: Array<[string, string]> = [
  ['a legal client row is ACCEPTED (proves the suite can pass)', insertClient()],
  [
    'a legal REVOKED client (revoked_at + revoked_by) is ACCEPTED',
    insertClient({ revoked_at: 'now()', revoked_by: "'admin@simple.biz'" }),
  ],
  [
    'a client scoped to some columns, expiring, with a custom limit is ACCEPTED',
    insertClient({
      granted_columns: "array['Name','Work Email','Department']",
      expires_at: "now() + interval '15 days'",
      rate_limit_per_minute: '120',
    }),
  ],
  ['a POST (MCP) request row is ACCEPTED', `${insertClient()}; ${insertRequest({ method: "'POST'", path: "'/api/external/mcp'" })}`],
  ['a legal SUCCESS request row is ACCEPTED', `${insertClient()}; ${insertRequest()}`],
  [
    'a legal DENIED request row (no client, a reason) is ACCEPTED',
    insertRequest({ client_id: 'NULL', status: '401', row_count: 'NULL', denial: "'unknown'" }),
  ],
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['a blank client name is rejected', insertClient({ name: "'  '" })],
  ['a blank system is rejected (we must know WHAT is calling)', insertClient({ system: "''" })],
  ['a key_hash that is not 64 hex chars is rejected', insertClient({ key_hash: "'not-a-hash'" })],
  [
    'a plaintext-looking key in key_hash is rejected',
    insertClient({ key_hash: "'hris_live_abc123defghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN'" }),
  ],
  [
    'two clients with the SAME key_hash are rejected',
    `${insertClient()}; ${insertClient({ id: "'00000000-0000-4000-8000-000000000002'", key_hash: HASH_A })}`,
  ],
  ['a key_prefix of the wrong shape is rejected', insertClient({ key_prefix: "'sk-ant-abc'" })],
  [
    'an unknown scope is rejected (the API is read-only by construction)',
    insertClient({ scopes: "array['global_master_list.write']" }),
  ],
  ['an empty scope list is rejected', insertClient({ scopes: 'array[]::text[]' })],
  ['revoked_at WITHOUT revoked_by is rejected', insertClient({ revoked_at: 'now()' })],
  ['an EMPTY granted_columns list is rejected (NULL means whole table; [] means nothing to anyone)', insertClient({ granted_columns: 'array[]::text[]' })],
  ['a rate limit of 0 is rejected', insertClient({ rate_limit_per_minute: '0' })],
  ['a rate limit above 600 is rejected', insertClient({ rate_limit_per_minute: '601' })],
  ['a request with a method other than GET/POST is rejected', `${insertClient()}; ${insertRequest({ method: "'DELETE'" })}`],
  ['a request status outside 100-599 is rejected', `${insertClient()}; ${insertRequest({ status: '42' })}`],
  ['a SUCCESS request with no client_id is rejected', insertRequest({ client_id: 'NULL' })],
  ['a SUCCESS request carrying a denial is rejected', `${insertClient()}; ${insertRequest({ denial: "'unknown'" })}`],
  ['a DENIED request with no denial reason is rejected', insertRequest({ client_id: 'NULL', status: '401', denial: 'NULL' })],
  [
    'deleting a client that has requests is rejected (history is kept)',
    `${insertClient()}; ${insertRequest()}; DELETE FROM ${CLIENTS} WHERE id = ${LEGAL_CLIENT.id}`,
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — External API clients migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${CLIENTS}, ${REQUESTS}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : ${POSITIVE_CONTROLS.length} positive, ${NEGATIVE_CONTROLS.length} negative`,
      '',
      verifyOnly
        ? '  Nothing is written; the objects are only re-checked.'
        : dryRun
          ? '  The SQL runs inside a transaction that is ALWAYS rolled back. Re-run with --apply to commit.'
          : '  The SQL will be COMMITTED to the database DATABASE_URL points at.',
      '',
    ].join('\n'),
  );

  await client.connect();

  if (dryRun) {
    const sql = readFileSync(SQL_PATH, 'utf8');
    console.log(`Applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query('BEGIN');
    await client.query(sql);
  } else if (!verifyOnly) {
    const sql = readFileSync(SQL_PATH, 'utf8');
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(sql);
    console.log('  applied.\n');
  } else {
    console.log('Verify only — not applying.\n');
  }

  console.log('Verifying objects:');
  let failed = 0;
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  console.log('\nVerifying the constraints actually bite:');
  // SAVEPOINTs, not BEGIN/ROLLBACK: in --dry we are already inside the outer
  // transaction, where a nested BEGIN silently no-ops while its ROLLBACK would
  // discard the entire rehearsal.
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

  // The control rows were all rolled back to savepoints; nothing of theirs remains.
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

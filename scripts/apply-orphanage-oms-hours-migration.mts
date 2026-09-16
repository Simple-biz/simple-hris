/**
 * [ORPHANAGE-OMS-HOURS]
 * Applies references/sql/create/2026-09-16_orphanage_oms_hours.sql — the
 * append-only table of OMS saves behind the Payroll Wizard's Orphanage
 * Management System tab — then verifies the table, its comment, the indexes,
 * the CHECK constraints, the normalising trigger and row-level security landed,
 * AND that each constraint actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-orphanage-oms-hours-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-orphanage-oms-hours-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-orphanage-oms-hours-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-orphanage-oms-hours-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The dry run applies the SQL and runs
 * every check inside a transaction it always rolls back; Postgres DDL is
 * transactional, so this proves the migration parses, the table builds and the
 * CHECKs bite while leaving production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER on 5432, not the direct
 * host (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The SQL is idempotent and touches no row data, so a re-run is a no-op.
 * Run it BEFORE deploying the code that saves into the table; until then the
 * OMS panel's Save button reads "table not applied yet".
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

const SQL_RELATIVE = 'references/sql/create/2026-09-16_orphanage_oms_hours.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.orphanage_oms_hours';

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
  'orphanage_oms_hours_mode_check',
  'orphanage_oms_hours_saved_by_present',
  'orphanage_oms_hours_oms_email_present',
  'orphanage_oms_hours_resolution_shape',
];
const INDEXES = [
  'orphanage_oms_hours_week_saved_idx',
  'orphanage_oms_hours_save_id_idx',
  'orphanage_oms_hours_oms_email_idx',
];

const CHECKS: Array<[string, string]> = [
  ['orphanage_oms_hours table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  [
    'table comment says NOT MONEY',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${TABLE}'), 'pg_class') LIKE '%NOT MONEY%'), false) AS ok`,
  ],
  [
    'save_id is uuid NOT NULL',
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' AND data_type = 'uuid'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='orphanage_oms_hours' AND column_name='save_id'), false) AS ok`,
  ],
  [
    'week_start is a DATE (not timestamptz)',
    `SELECT COALESCE(
       (SELECT data_type = 'date'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='orphanage_oms_hours' AND column_name='week_start'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
  [
    'trigger trg_orphanage_oms_hours_normalize exists',
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('${TABLE}') AND tgname = 'trg_orphanage_oms_hours_normalize'
     ) AS ok`,
  ],
  [
    'row level security is ENABLED',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='orphanage_oms_hours') AS ok`,
  ],
];

/** The ONE legal matched row every control deviates from by exactly one field. */
const LEGAL_ROW: Record<string, string> = {
  save_id: "'00000000-0000-4000-8000-000000000001'",
  week_start: "'2026-09-13'",
  source_file: "'control.csv'",
  mode: "'test'",
  saved_by: "'control@simple.biz'",
  oms_email: "'worker@simple.biz'",
  oms_hours_raw: "'12.5'",
  oms_hours: '12.5',
  matched: 'true',
  employee_email: "'worker@simple.biz'",
  employee_name: "'Worker'",
  reg_hours: '5.8',
  ot_hours: '6.7',
  regular_rate_php: '355',
  ot_rate_php: '532.5',
  amount_php: '5626.75',
  skip_reason: 'NULL',
};

function insertRow(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_ROW, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const POSITIVE_CONTROL: [string, string] = ['a legal MATCHED row is ACCEPTED (proves the suite can pass)', insertRow()];

const UNMATCHED_CONTROL: [string, string] = [
  'a legal UNMATCHED row (reason, no key, no amount) is ACCEPTED',
  insertRow({
    matched: 'false',
    employee_email: 'NULL',
    employee_name: 'NULL',
    reg_hours: 'NULL',
    ot_hours: 'NULL',
    regular_rate_php: 'NULL',
    ot_rate_php: 'NULL',
    amount_php: 'NULL',
    skip_reason: "'No employee in this pay period matches that work email'",
  }),
];

const TRIGGER_CONTROL: [string, string] = [
  'the normalise trigger lower-cases and trims both email columns',
  `${insertRow({ oms_email: "'  Worker@Simple.Biz '", employee_email: "' WORKER@simple.biz'" })}
   RETURNING (oms_email = 'worker@simple.biz' AND employee_email = 'worker@simple.biz') AS ok`,
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ["an unknown mode ('preview') is rejected", insertRow({ mode: "'preview'" })],
  ["a mis-cased mode ('TEST') is rejected", insertRow({ mode: "'TEST'" })],
  ['a blank saved_by is rejected (every save has an author)', insertRow({ saved_by: "'  '" })],
  ['a blank oms_email is rejected', insertRow({ oms_email: "'  '" })],
  ['a matched row with NO employee key is rejected', insertRow({ employee_email: 'NULL' })],
  ['a matched row with NO amount is rejected', insertRow({ amount_php: 'NULL' })],
  ['a matched row carrying a skip_reason is rejected', insertRow({ skip_reason: "'why?'" })],
  ['an unmatched row with NO skip_reason is rejected', insertRow({ matched: 'false', employee_email: 'NULL', amount_php: 'NULL' })],
  ['an unmatched row that still carries an amount is rejected', insertRow({ matched: 'false', employee_email: 'NULL', skip_reason: "'x'" })],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Orphanage OMS hours migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : 2 positive, 1 trigger, ${NEGATIVE_CONTROLS.length} negative`,
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

  for (const [label, sql] of [POSITIVE_CONTROL, UNMATCHED_CONTROL]) {
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

  {
    const [label, sql] = TRIGGER_CONTROL;
    await client.query('SAVEPOINT tc');
    let ok = false;
    try {
      const { rows } = await client.query(sql);
      ok = rows[0]?.ok === true;
    } catch {
      ok = false;
    }
    await client.query('ROLLBACK TO SAVEPOINT tc');
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
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

  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('\nDRY RUN — rolled back. Production is unchanged.');
  } else {
    // The control rows were all rolled back to savepoints; nothing of theirs remains.
    await client.query('ROLLBACK');
  }

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

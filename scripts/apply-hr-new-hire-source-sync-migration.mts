/**
 * [HR-NEW-HIRE-SOURCE-SYNC]
 * Applies references/sql/create/2026-10-08_hr_new_hire_source_rows.sql — the
 * HRIS's own copy of the hiring database (hr_new_hire_source_rows) plus the
 * three columns the New Hire Checklist gains (origin, source_key, received_at)
 * — then verifies every object landed AND that each constraint actually rejects
 * what it exists to reject.
 *
 *   node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. The dry run applies the SQL and runs
 * every check inside a transaction it always rolls back; Postgres DDL is
 * transactional, so this proves the migration parses, the table builds and the
 * CHECKs bite while leaving production exactly as it was. (The SQL file carries
 * no BEGIN/COMMIT of its own for exactly this reason.)
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER on 5432, not the direct
 * host (memory/migration-apply-needs-database-url).
 *
 * The SQL is idempotent and changes no existing row (the new checklist columns
 * default to 'manual' / NULL). Run it BEFORE relying on the sync; until then the
 * New Hire Checklist's sync strip reads "not applied yet" and names this script.
 *
 * Doc: docs/features/new-hire-source-sync.md
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

const SQL_RELATIVE = 'references/sql/create/2026-10-08_hr_new_hire_source_rows.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.hr_new_hire_source_rows';
const CHECKLIST = 'public.hr_new_hire_checklist';

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
  'hr_new_hire_source_rows_source_key_present',
  'hr_new_hire_source_rows_hash_present',
  'hr_new_hire_source_rows_placement_check',
  'hr_new_hire_source_rows_hold_shape',
  'hr_new_hire_source_rows_hold_reason_check',
  'hr_new_hire_source_rows_placed_shape',
  'hr_new_hire_checklist_origin_check',
  'hr_new_hire_checklist_synced_shape',
];
const INDEXES = [
  'hr_new_hire_source_rows_source_key_uidx',
  'hr_new_hire_source_rows_open_idx',
  'hr_new_hire_source_rows_checklist_row_idx',
  'hr_new_hire_checklist_source_key_uidx',
];

const column = (table: string, col: string, predicate: string): string =>
  `SELECT COALESCE(
     (SELECT ${predicate} FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${table}' AND column_name='${col}'), false) AS ok`;

const CHECKS: Array<[string, string]> = [
  ['hr_new_hire_source_rows table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  [
    'table comment says NOT MONEY',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${TABLE}'), 'pg_class') LIKE '%NOT MONEY%'), false) AS ok`,
  ],
  ['source_key is text NOT NULL', column('hr_new_hire_source_rows', 'source_key', "is_nullable = 'NO' AND data_type = 'text'")],
  ['first_pulled_at is timestamptz NOT NULL', column('hr_new_hire_source_rows', 'first_pulled_at', "is_nullable = 'NO' AND data_type = 'timestamp with time zone'")],
  ['target_period_start is a DATE', column('hr_new_hire_source_rows', 'target_period_start', "data_type = 'date'")],
  ['checklist.origin is text NOT NULL default manual', column('hr_new_hire_checklist', 'origin', "is_nullable = 'NO' AND column_default LIKE '%manual%'")],
  ['checklist.source_key exists', column('hr_new_hire_checklist', 'source_key', "data_type = 'text'")],
  ['checklist.received_at is timestamptz', column('hr_new_hire_checklist', 'received_at', "data_type = 'timestamp with time zone'")],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
  [
    'checklist_row_id FK is ON DELETE SET NULL (a delete never erases the copy)',
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('${TABLE}') AND contype = 'f' AND confdeltype = 'n'
          AND confrelid = to_regclass('${CHECKLIST}')
     ) AS ok`,
  ],
  [
    'row level security is ENABLED',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='hr_new_hire_source_rows') AS ok`,
  ],
];

/** The ONE legal pending row every source-row control deviates from. */
const LEGAL_SOURCE: Record<string, string> = {
  source_key: "'control-1'",
  name: "'Control Hire'",
  personal_email: "'control.hire@example.com'",
  date_of_interview: "'2026-08-14'",
  content_hash: "'abc123'",
  target_period_start: "'2026-08-16'",
  placement: "'pending'",
  hold_reason: 'NULL',
  placed_at: 'NULL',
};

function insertSource(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_SOURCE, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/** The ONE legal SYNCED checklist row every checklist control deviates from. */
const LEGAL_CHECKLIST: Record<string, string> = {
  period_start: "'2026-08-16'",
  position: '0',
  name: "'Control Hire'",
  origin: "'synced'",
  source_key: "'control-1'",
  received_at: 'now()',
};

function insertChecklist(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_CHECKLIST, ...overrides };
  const cols = Object.keys(row).filter((c) => row[c] !== 'OMIT');
  return `INSERT INTO ${CHECKLIST} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const POSITIVE_CONTROLS: Array<[string, string]> = [
  ['a legal PENDING source row is ACCEPTED (proves the suite can pass)', insertSource()],
  ['a legal HELD row (with a reason) is ACCEPTED', insertSource({ placement: "'held'", hold_reason: "'week_locked'" })],
  ['a legal PLACED row whose checklist row is gone (NULL) is ACCEPTED', insertSource({ placement: "'placed'", placed_at: 'now()' })],
  ['a legal SYNCED checklist row is ACCEPTED', insertChecklist()],
  [
    'a checklist row inserted the old way (no origin given) is ACCEPTED as manual',
    `${insertChecklist({ origin: 'OMIT', source_key: 'OMIT', received_at: 'OMIT' })}`,
  ],
];

const RETURNING_CONTROLS: Array<[string, string]> = [
  [
    'an old-style insert defaults to origin = manual',
    `${insertChecklist({ origin: 'OMIT', source_key: 'OMIT', received_at: 'OMIT' })} RETURNING (origin = 'manual') AS ok`,
  ],
  [
    'deleting a placed checklist row NULLs the link and KEEPS placed_at (never re-placed)',
    `WITH c AS (${insertChecklist()} RETURNING id),
          s AS (INSERT INTO ${TABLE} (source_key, content_hash, placement, placed_at, checklist_row_id)
                SELECT 'control-1', 'abc123', 'placed', now(), id FROM c RETURNING id)
     SELECT 1 AS ok`,
  ],
];

const FK_FOLLOWUP =
  `DELETE FROM ${CHECKLIST} WHERE source_key = 'control-1';
   SELECT (checklist_row_id IS NULL AND placed_at IS NOT NULL) AS ok FROM ${TABLE} WHERE source_key = 'control-1'`;

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['a blank source_key is rejected', insertSource({ source_key: "'  '" })],
  ['a blank content_hash is rejected', insertSource({ content_hash: "''" })],
  ["an unknown placement ('done') is rejected", insertSource({ placement: "'done'" })],
  ['a HELD row with NO reason is rejected', insertSource({ placement: "'held'" })],
  ['a PENDING row carrying a hold reason is rejected', insertSource({ hold_reason: "'past_week'" })],
  ["an unknown hold reason ('later') is rejected", insertSource({ placement: "'held'", hold_reason: "'later'" })],
  ['a PLACED row with NO placed_at is rejected', insertSource({ placement: "'placed'" })],
  ['a PENDING row carrying placed_at is rejected', insertSource({ placed_at: 'now()' })],
  ['the same source_key twice is rejected', `${insertSource()}; ${insertSource()}`],
  ["a checklist origin of 'auto' is rejected", insertChecklist({ origin: "'auto'" })],
  ['a SYNCED checklist row with NO source_key is rejected', insertChecklist({ source_key: 'NULL' })],
  ['a SYNCED checklist row with NO received_at is rejected', insertChecklist({ received_at: 'NULL' })],
  ['a MANUAL checklist row carrying a source_key is rejected', insertChecklist({ origin: "'manual'", received_at: 'NULL' })],
  ['the same source hire listed twice on the checklist is rejected', `${insertChecklist()}; ${insertChecklist({ position: '1' })}`],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — New Hire Checklist source-sync migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Tables   : ${TABLE} (new), ${CHECKLIST} (+origin, +source_key, +received_at)`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : ${POSITIVE_CONTROLS.length} positive, ${RETURNING_CONTROLS.length} shape, ${NEGATIVE_CONTROLS.length} negative`,
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

  {
    const [label, sql] = RETURNING_CONTROLS[0]!;
    await client.query('SAVEPOINT rc');
    let ok = false;
    try {
      const { rows } = await client.query(sql);
      ok = rows[0]?.ok === true;
    } catch {
      ok = false;
    }
    await client.query('ROLLBACK TO SAVEPOINT rc');
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`);
  }

  {
    const [label, sql] = RETURNING_CONTROLS[1]!;
    await client.query('SAVEPOINT fk');
    let ok = false;
    try {
      await client.query(sql);
      // A multi-statement query returns one result per statement; the SELECT is last.
      const res = (await client.query(FK_FOLLOWUP)) as unknown;
      const results = Array.isArray(res) ? res : [res];
      const last = results[results.length - 1] as { rows?: Array<{ ok?: boolean }> };
      ok = last.rows?.[0]?.ok === true;
    } catch {
      ok = false;
    }
    await client.query('ROLLBACK TO SAVEPOINT fk');
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

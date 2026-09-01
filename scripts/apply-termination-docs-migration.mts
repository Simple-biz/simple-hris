/**
 * [TERMINATION-DOCS]
 * Applies references/sql/migrate/2026-08-31_termination_docs.sql —
 * `termination_documents`, the permanent log of generated termination letters
 * and the ONLY undo data for the blank-only global_master_list write-back —
 * then verifies the table, its comment, all five indexes, all seven CHECK
 * constraints and its row-level-security enablement landed, AND that each
 * constraint actually rejects what it exists to reject.
 *
 *   node --import tsx scripts/apply-termination-docs-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-termination-docs-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-termination-docs-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-termination-docs-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run. Unlike the older .mjs apply scripts
 * (apply-offboarded-origin-migration.mjs, apply-mesa-shortfall-migration.mjs),
 * whose no-flag default WRITES, this one requires an explicit --apply. The dry
 * run applies the SQL and runs every check inside a transaction it always rolls
 * back; Postgres DDL is transactional, so this proves the migration parses, the
 * table builds, and the CHECKs bite — while leaving production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local. For this project that is the SESSION
 * POOLER, not the direct host (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The direct db.<ref>.supabase.co host is IPv6-only here and resolves to no
 * address at all. The user is `postgres.<ref>`, not bare `postgres`, and an `@`
 * inside the password MUST be percent-encoded as %40 or the driver truncates
 * the password at the first `@` and misreads the rest as the hostname — which
 * surfaces as "password authentication failed" on a password that was fine.
 * Session mode on 5432 runs DDL; transaction mode on 6543 cannot.
 *
 * The SQL is idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
 * EXISTS, COMMENT ON, and ENABLE ROW LEVEL SECURITY on an already-enabled
 * table) and touches no row data, so a re-run is a no-op.
 *
 * Run it BEFORE deploying the code that reads the table. A deploy that lands
 * first breaks nothing else — nothing but the new tab reads it — but no
 * termination document can be generated until this runs.
 *
 * Reversed by references/sql/fix/drop_termination_docs.sql, which must itself be
 * preceded by scripts/revert-termination-doc-writebacks.mts --apply.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * Repo root, derived from THIS FILE's location — never from `cwd`. Relative
 * literals here meant `cd scripts && node --import tsx apply-...` threw ENOENT on
 * the SQL and silently read no `.env.local` at all. Resolving from the module
 * makes the script behave identically from any working directory.
 */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config();

const SQL_RELATIVE = 'references/sql/migrate/2026-08-31_termination_docs.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(
    `Migration SQL not found at ${SQL_PATH}
Expected <repo root>/${SQL_RELATIVE} — the repo root was derived from ${SCRIPT_PATH}.`,
  );
  process.exit(1);
}
const TABLE = 'public.termination_documents';

const wantVerify = process.argv.includes('--verify');
const wantApply = process.argv.includes('--apply');
const wantDry = process.argv.includes('--dry');
if ([wantVerify, wantApply, wantDry].filter(Boolean).length > 1) {
  console.error('Pass exactly one of --dry / --apply / --verify (the default is --dry).');
  process.exit(1);
}
const verifyOnly = wantVerify;
// SAFE BY DEFAULT: an operator who forgets the flag rehearses, never writes.
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
  'termination_documents_reason_key_check',
  'termination_documents_starting_rate_positive',
  'termination_documents_ending_rate_positive',
  'termination_documents_dept_label_not_slug',
  'termination_documents_off_after_start',
  'termination_documents_currency_check',
  'termination_documents_currency_present_with_rate',
];

const INDEXES = [
  'termination_documents_work_email_idx',
  'termination_documents_personal_email_idx',
  'termination_documents_generated_at_idx',
  'termination_documents_generated_by_idx',
  'termination_documents_writebacks_idx',
];

// Each row: [label, SQL returning a single boolean column named ok]
const CHECKS: Array<[string, string]> = [
  ['termination_documents table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  // The comment is the operator's only in-database warning that field_writebacks
  // has no second copy. Without it a DROP destroys the undo data silently.
  [
    'table comment names the reverse script',
    `SELECT COALESCE(
       (SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
          LIKE '%[TERMINATION-DOCS]%revert-termination-doc-writebacks.mts%'), false) AS ok`,
  ],
  // Both must be `date`, not timestamptz: a letter states a calendar day, and a
  // timestamptz reintroduces the new Date('YYYY-MM-DD') UTC-midnight day-shift
  // that reads as the previous day in Manila.
  ...['termination_date', 'start_date'].map(
    (col): [string, string] => [
      `${col} is a DATE (not timestamptz)`,
      `SELECT COALESCE(
         (SELECT data_type = 'date' FROM information_schema.columns
           WHERE table_schema='public' AND table_name='termination_documents'
             AND column_name='${col}'), false) AS ok`,
    ],
  ),
  // Every rate carrier upstream is TEXT; numeric(12,2) is where the parse is
  // forced to happen exactly once, at write time.
  ...['starting_rate', 'ending_rate'].map(
    (col): [string, string] => [
      `${col} is numeric(12,2)`,
      `SELECT COALESCE(
         (SELECT numeric_precision = 12 AND numeric_scale = 2
            FROM information_schema.columns
           WHERE table_schema='public' AND table_name='termination_documents'
             AND column_name='${col}'), false) AS ok`,
    ],
  ),
  // field_writebacks NOT NULL DEFAULT '[]' is what makes
  // `jsonb_array_length(field_writebacks) > 0` a TOTAL predicate. A NULL there
  // evaluates to NULL, so the drop script's PRE-CHECK count and the reverse
  // script's scan would both silently skip a row that still needs undoing.
  [
    "field_writebacks is NOT NULL default '[]'",
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' AND column_default LIKE '''[]''%'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='termination_documents'
           AND column_name='field_writebacks'), false) AS ok`,
  ],
  [
    'facts is NOT NULL jsonb',
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' AND data_type = 'jsonb'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='termination_documents'
           AND column_name='facts'), false) AS ok`,
  ],
  [
    'filled_by_rep is a NOT NULL text[]',
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' AND udt_name = '_text'
          FROM information_schema.columns
         WHERE table_schema='public' AND table_name='termination_documents'
           AND column_name='filled_by_rep'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = '${name}'
     ) AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = '${name}'
     ) AS ok`,
  ]),
  // The table holds worker PII, rates and a departure reason, and
  // NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle. RLS is the layer
  // that decides whether a browser can read this table at all; the house
  // precedent for a PII table is RLS ENABLED with NO policies
  // (references/sql/create/create_screening.sql:96-101).
  [
    'row level security is ENABLED',
    `SELECT COALESCE(
       (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  // No policies is the point: a policy is the only thing that could hand
  // anon/authenticated a row back, so its ABSENCE is asserted rather than
  // assumed. If a future migration adds one deliberately, this check is where
  // that decision has to be made out loud.
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='termination_documents'
     ) AS ok`,
  ],
];

/**
 * The ONE fully legal row every control below deviates from by exactly one
 * field. Building the controls from a single base is what PROVES a rejection is
 * credited to the rule under test rather than to an unrelated typo in a
 * hand-copied INSERT.
 */
const LEGAL_ROW: Record<string, string> = {
  work_email: "'control@simple.biz'",
  personal_email: "'control@example.com'",
  worker_name: "'Control Person'",
  termination_date: "'2026-08-18'",
  reason_key: "'resigned'",
  reason_label: "'Resigned'",
  ending_department_raw: "'lead_gen'",
  ending_department_label: "'Lead Generation'",
  start_date: "'2026-01-05'",
  starting_rate: '180.00',
  starting_rate_currency: "'PHP'",
  starting_rate_source: "'hr_pending'",
  ending_rate: '225.00',
  ending_rate_currency: "'PHP'",
  ending_rate_source: "'paystub_locked'",
  generated_by: "'control@simple.biz'",
  generated_by_name: "'Control Rep'",
  generated_by_title: "'Accounting'",
  file_path: "'termination/control_simple.biz/control/termination.pdf'",
  file_name: "'termination.pdf'",
};

function insertRow(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_ROW, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/**
 * POSITIVE CONTROL — a fully legal row MUST insert.
 *
 * Without this, every negative control below could be "passing" because the
 * inserts fail for some unrelated reason (a missing column, a NOT NULL
 * elsewhere), and a suite that cannot accept a good row produces a report
 * indistinguishable from one where every constraint works. This runs FIRST and
 * aborts the rest if it fails. Same lesson as the pending-migrations probe
 * (memory/migration-pending-claims-are-folklore), which reported APPLIED for a
 * table that did not exist until a control was added.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal termination row is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

/**
 * The defaults are load-bearing in a way no CHECK can express: `id` depends on
 * gen_random_uuid() resolving at all (a DDL that "succeeded" without it fails
 * every INSERT), and the three container defaults are what keep the reverse
 * script's jsonb_array_length scan total. Assert the omitted-column path lands
 * real values rather than NULLs.
 */
const DEFAULT_CONTROL: [string, string] = [
  'an INSERT omitting id/facts/filled_by_rep/field_writebacks lands real defaults',
  `INSERT INTO ${TABLE}
     (work_email, worker_name, termination_date, reason_key, reason_label,
      ending_department_label, generated_by, file_path, file_name)
   VALUES ('control@simple.biz','Control Person','2026-08-18','resigned','Resigned',
           'Lead Generation','control@simple.biz',
           'termination/control_simple.biz/defaults/termination.pdf','termination.pdf')
   RETURNING (
     id IS NOT NULL
     AND facts = '{}'::jsonb
     AND filled_by_rep = '{}'::text[]
     AND field_writebacks = '[]'::jsonb
     AND generated_at IS NOT NULL
     AND created_at IS NOT NULL
   ) AS ok`,
];

/**
 * Prove the constraints actually REJECT what they are meant to reject. A
 * constraint that exists but does not bite is indistinguishable from one that
 * works until the day it matters, so each of these inserts a deliberately
 * illegal row inside a savepoint that is always rolled back. Each violates
 * exactly ONE rule — every other field comes from LEGAL_ROW — so a pass cannot
 * be credited to the wrong constraint.
 */
const NEGATIVE_CONTROLS: Array<[string, string]> = [
  // G2, layer 4. The other three layers are the type, the resolver and the
  // route; this is the one a bug in all three cannot get past.
  [
    'a temporary_pause reason is rejected (G2 in the database)',
    insertRow({ reason_key: "'temporary_pause'" }),
  ],
  [
    "a mis-cased reason ('Resigned') is rejected — the column is free text upstream",
    insertRow({ reason_key: "'Resigned'" }),
  ],
  [
    "a synthetic non-departure ('duplicate_cleanup') is rejected",
    insertRow({ reason_key: "'duplicate_cleanup'" }),
  ],
  ['a zero starting rate is rejected', insertRow({ starting_rate: '0' })],
  ['a zero ending rate is rejected', insertRow({ ending_rate: '0' })],
  ['a negative ending rate is rejected', insertRow({ ending_rate: '-225.00' })],
  [
    'a raw hsl:* department LABEL is rejected',
    insertRow({ ending_department_label: "'hsl:intake_specialist'" }),
  ],
  [
    'a termination date EQUAL to the start date is rejected (the guard is >, not >=)',
    insertRow({ termination_date: "'2026-01-05'" }),
  ],
  [
    'a termination date BEFORE the start date is rejected (G4, the re-hire guard)',
    insertRow({ termination_date: "'2025-12-31'" }),
  ],
  ['a NULL termination date is rejected', insertRow({ termination_date: 'NULL' })],
  ["an unknown currency ('EUR') is rejected", insertRow({ starting_rate_currency: "'EUR'" })],
  ["a mis-cased currency ('php') is rejected", insertRow({ ending_rate_currency: "'php'" })],
  // Money with no unit. A `numeric` says nothing about denomination, so a rate
  // with no currency beside it is a figure a reader denominates by guessing.
  [
    'a starting rate with NO currency is rejected',
    insertRow({ starting_rate_currency: 'NULL' }),
  ],
  [
    'an ending rate with NO currency is rejected',
    insertRow({ ending_rate_currency: 'NULL' }),
  ],
  // The other direction stays LEGAL, deliberately: a BLANK rate still records
  // which carrier's currency was consulted, so a currency with no amount must
  // insert. Asserted as a positive so the constraint above cannot be tightened
  // into an equality that would refuse the app's own blank-rate row.
];

/** Rows that must be ACCEPTED even though they look partial. Same savepoint
 *  machinery as the negative controls, opposite expectation. */
const POSITIVE_SHAPES: Array<[string, string]> = [
  [
    'a BLANK rate that still records its carrier currency is ACCEPTED',
    insertRow({ starting_rate: 'NULL', starting_rate_currency: "'COP'" }),
  ],
  [
    'a non-PHP rate is ACCEPTED (risk 4: the document prints the native currency)',
    insertRow({ ending_rate: '320000.00', ending_rate_currency: "'COP'" }),
  ],
  [
    'a BLANK rate with NO currency at all is ACCEPTED (the catalog read failed, so nothing could state one)',
    insertRow({ starting_rate: 'NULL', starting_rate_currency: 'NULL' }),
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Termination Docs migration`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : 1 positive, 1 default, ${POSITIVE_SHAPES.length} accepted-shape, ${NEGATIVE_CONTROLS.length} negative`,
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
    // Rehearse the whole thing inside a transaction that is always rolled back.
    // Postgres DDL is transactional, so nothing survives this.
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
  // transaction, and a nested BEGIN there would silently no-op while the
  // ROLLBACK discarded the entire rehearsal.
  if (!dryRun) await client.query('BEGIN');

  // Positive control first — if a good row cannot land, every "rejected" below
  // is meaningless and the suite must not claim success.
  {
    const [label, sql] = POSITIVE_CONTROL;
    await client.query('SAVEPOINT pc');
    let accepted = true;
    let why = '';
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT pc');
    await client.query('RELEASE SAVEPOINT pc');
    console.log(`  ${accepted ? 'OK  ' : 'FAIL'}  ${label}${why}`);
    if (!accepted) {
      await client.query('ROLLBACK');
      await client.end();
      console.error(
        '\nPositive control failed — the negative controls below would be meaningless. Aborting.',
      );
      process.exit(1);
    }
  }

  {
    const [label, sql] = DEFAULT_CONTROL;
    await client.query('SAVEPOINT dc');
    let got: unknown = null;
    let why = '';
    try {
      const { rows } = await client.query(sql);
      got = rows[0]?.ok ?? null;
    } catch (e) {
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT dc');
    await client.query('RELEASE SAVEPOINT dc');
    const ok = got === true;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'OK  ' : 'FAIL'}  ${label}${ok ? '' : ` (got ${JSON.stringify(got)}${why})`}`,
    );
  }

  for (const [label, sql] of POSITIVE_SHAPES) {
    await client.query('SAVEPOINT ps');
    let accepted = true;
    let why = '';
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT ps');
    await client.query('RELEASE SAVEPOINT ps');
    if (!accepted) failed++;
    console.log(`  ${accepted ? 'OK  ' : 'FAIL'}  ${label}${why}`);
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
    await client.query('RELEASE SAVEPOINT nc');
    if (!rejected) failed++;
    console.log(`  ${rejected ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  if (!dryRun) await client.query('ROLLBACK');

  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('\nRolled back — production is unchanged. Re-run with --apply to commit.');
  }

  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

/**
 * [GIFT-ADDRESS]
 * Applies references/sql/migrate/2026-09-12_gift_address_external_link.sql —
 * `gift_address_otps`, the code + session store behind the PUBLIC
 * /update-gift-address page — then verifies the table, its comment, both
 * indexes, all four CHECK constraints, the normalising trigger and row-level
 * security landed, AND that each constraint actually rejects what it exists to
 * reject.
 *
 *   node --import tsx scripts/apply-gift-address-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-gift-address-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-gift-address-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-gift-address-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a
 * transaction that is always rolled back. Postgres DDL is transactional, so this
 * proves the migration parses, the table builds and the CHECKs bite while
 * leaving production exactly as it was.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host
 * (memory/migration-apply-needs-database-url):
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The user is `postgres.<ref>`, and an `@` in the password MUST be
 * percent-encoded as %40 or the driver truncates the password at the first `@`
 * and misreads the rest as the hostname — which surfaces as "password
 * authentication failed" on a password that was fine.
 *
 * Run this BEFORE deploying the code that reads the table: with it absent the
 * public page's request-otp step fails for everyone.
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

const SQL_RELATIVE = 'references/sql/migrate/2026-09-12_gift_address_external_link.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.gift_address_otps';

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
  'gift_address_otps_work_email_normalized',
  'gift_address_otps_work_email_shape',
  'gift_address_otps_attempts_sane',
  'gift_address_otps_session_pair',
];

const INDEXES = ['gift_address_otps_email_idx', 'gift_address_otps_session_idx'];

const CHECKS: Array<[string, string]> = [
  ['gift_address_otps table exists', `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  [
    'table comment says the codes and tokens are HASHED',
    `SELECT COALESCE((SELECT obj_description(to_regclass('${TABLE}'), 'pg_class')
        LIKE '%HASHED%'), false) AS ok`,
  ],
  // A nullable code_hash would let a row exist that nothing can verify against,
  // and the verify path would then compare against NULL and always fail.
  ...['work_email', 'code_hash', 'attempts', 'expires_at'].map(
    (col): [string, string] => [
      `${col} is NOT NULL`,
      `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='gift_address_otps'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  ...['expires_at', 'consumed_at', 'session_expires_at', 'created_at'].map(
    (col): [string, string] => [
      `${col} is timestamptz (an instant, not a calendar day)`,
      `SELECT COALESCE((SELECT data_type = 'timestamp with time zone'
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='gift_address_otps'
           AND column_name='${col}'), false) AS ok`,
    ],
  ),
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  ...INDEXES.map((name): [string, string] => [
    `index ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = '${name}') AS ok`,
  ]),
  [
    'trigger trg_gift_address_otps_normalize exists',
    `SELECT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('${TABLE}')
         AND tgname = 'trg_gift_address_otps_normalize') AS ok`,
  ],
  // This table is reachable from a PUBLIC page and holds session tokens.
  // NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle.
  [
    'row level security is ENABLED',
    `SELECT COALESCE((SELECT relrowsecurity FROM pg_class
       WHERE oid = to_regclass('${TABLE}')), false) AS ok`,
  ],
  [
    'row level security has NO policies (anon/authenticated get zero rows)',
    `SELECT NOT EXISTS (SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='gift_address_otps') AS ok`,
  ],
];

const LEGAL_ROW: Record<string, string> = {
  work_email: "'control@simple.biz'",
  code_hash: `'${'a'.repeat(64)}'`,
  attempts: '0',
  expires_at: "now() + interval '10 minutes'",
};

function insertRow(overrides: Record<string, string> = {}): string {
  const row = { ...LEGAL_ROW, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')})
     VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

/**
 * POSITIVE CONTROL — without it every "rejected" below could be passing for an
 * unrelated reason, and a suite that cannot accept a good row is
 * indistinguishable from one where the constraints all work.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a fully legal OTP row is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

const TRIGGER_CONTROL: [string, string] = [
  'the normalise trigger lower-cases and trims the work email',
  `INSERT INTO ${TABLE} (work_email, code_hash, expires_at)
   VALUES ('  Control@Simple.Biz  ', '${'b'.repeat(64)}', now() + interval '10 minutes')
   RETURNING (work_email = 'control@simple.biz') AS ok`,
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  ['a blank work email is rejected', insertRow({ work_email: "'   '" })],
  ['a work email with no @ is rejected', insertRow({ work_email: "'control'" })],
  ['a NULL code_hash is rejected (nothing could ever verify against it)', insertRow({ code_hash: 'NULL' })],
  ['a NULL expiry is rejected (a code that never ages out)', insertRow({ expires_at: 'NULL' })],
  ['a negative attempt count is rejected', insertRow({ attempts: '-1' })],
  [
    'a session token with NO expiry is rejected (it would never age out)',
    insertRow({ session_token: "'sometoken'" }),
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Gift address external link`,
      '',
      `  SQL      : ${SQL_PATH}`,
      `  Table    : ${TABLE}`,
      `  Indexes  : ${INDEXES.length}`,
      `  CHECKs   : ${CONSTRAINTS.length}`,
      `  Controls : 1 positive, 1 trigger, ${NEGATIVE_CONTROLS.length} negative`,
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
    console.log(`Applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query('BEGIN');
    await client.query(readFileSync(SQL_PATH, 'utf8'));
  } else if (!verifyOnly) {
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(readFileSync(SQL_PATH, 'utf8'));
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
  // discard the whole rehearsal.
  if (!dryRun) await client.query('BEGIN');

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
      console.error('\nPositive control failed — the negative controls would be meaningless. Aborting.');
      process.exit(1);
    }
  }

  {
    const [label, sql] = TRIGGER_CONTROL;
    await client.query('SAVEPOINT tc');
    let got: unknown = null;
    let why = '';
    try {
      const { rows } = await client.query(sql);
      got = rows[0]?.ok ?? null;
    } catch (e) {
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT tc');
    await client.query('RELEASE SAVEPOINT tc');
    const ok = got === true;
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${ok ? '' : ` (got ${JSON.stringify(got)}${why})`}`);
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

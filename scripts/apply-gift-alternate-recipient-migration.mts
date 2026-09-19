/**
 * [GIFT-ALT-RECIPIENT]
 * Applies references/sql/migrate/2026-09-18_gift_alternate_recipient.sql — the
 * three alternate-recipient columns on `employee_gift_shipping_details`, for
 * employees whose spouse (or anyone else) receives the tenure gift for them —
 * then verifies the columns, their comments, the three CHECK constraints and
 * the partial index landed, AND that each constraint actually rejects what it
 * exists to reject.
 *
 *   node --import tsx scripts/apply-gift-alternate-recipient-migration.mts           # rehearse, then ROLL BACK
 *   node --import tsx scripts/apply-gift-alternate-recipient-migration.mts --dry     # same, explicitly
 *   node --import tsx scripts/apply-gift-alternate-recipient-migration.mts --apply   # COMMIT
 *   node --import tsx scripts/apply-gift-alternate-recipient-migration.mts --verify  # verify only
 *
 * SAFE BY DEFAULT: no flag is a dry run — the SQL is applied inside a
 * transaction that is always rolled back. Postgres DDL is transactional, so this
 * proves the migration parses, the columns build and the CHECKs bite while
 * leaving production exactly as it was.
 *
 * READ-ONLY UNTIL --apply, AND IT TOUCHES NO EXISTING DATA EVEN THEN. Every
 * column is NOT NULL DEFAULT '', so existing rows are filled by the default and
 * nothing is rewritten. There is no backfill and no UPDATE anywhere in this
 * script: live rows hold prose naming spouses in `notes`, and that text is
 * never parsed — guessing intent out of free text redirects real parcels.
 *
 * Needs DATABASE_URL in .env.local — the SESSION POOLER, not the direct host:
 *
 *   postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 *
 * The user is `postgres.<ref>`, and an `@` in the password MUST be
 * percent-encoded as %40 or the driver truncates the password at the first `@`
 * and misreads the rest as the hostname — which surfaces as "password
 * authentication failed" on a password that was fine.
 *
 * Run this BEFORE deploying the code that reads the columns: with them absent
 * every gift-shipping read fails, because the columns are in SELECT_COLS.
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

const SQL_RELATIVE = 'references/sql/migrate/2026-09-18_gift_alternate_recipient.sql';
const SQL_PATH = path.join(REPO_ROOT, ...SQL_RELATIVE.split('/'));
if (!existsSync(SQL_PATH)) {
  console.error(`Migration SQL not found at ${SQL_PATH}`);
  process.exit(1);
}
const TABLE = 'public.employee_gift_shipping_details';
const TABLE_NAME = 'employee_gift_shipping_details';

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

const COLUMNS = ['recipient_name', 'recipient_relationship', 'recipient_contact'];

const CONSTRAINTS = [
  'egsd_recipient_all_or_nothing',
  'egsd_recipient_relationship_known',
  'egsd_recipient_lengths',
];

const CHECKS: Array<[string, string]> = [
  [`${TABLE_NAME} exists`, `SELECT to_regclass('${TABLE}') IS NOT NULL AS ok`],
  ...COLUMNS.map((col): [string, string] => [
    `column ${col} exists`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${TABLE_NAME}'
         AND column_name='${col}') AS ok`,
  ]),
  // NOT NULL DEFAULT '' is the whole reason no backfill is needed. A nullable
  // column would make "nobody said" representable twice — as NULL and as '' —
  // and the two would immediately drift apart.
  ...COLUMNS.map((col): [string, string] => [
    `${col} is NOT NULL`,
    `SELECT COALESCE((SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${TABLE_NAME}'
         AND column_name='${col}'), false) AS ok`,
  ]),
  ...COLUMNS.map((col): [string, string] => [
    `${col} defaults to the empty string (no backfill needed)`,
    `SELECT COALESCE((SELECT column_default LIKE '''''::text'
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${TABLE_NAME}'
         AND column_name='${col}'), false) AS ok`,
  ]),
  // Kane's Q1 ruling, written where the next person will find it: the courier
  // calls the employee, and recipient_contact is a fallback that never
  // substitutes. A comment is the only place the database can say so.
  [
    'recipient_contact comment says it is a FALLBACK ONLY',
    `SELECT COALESCE((
       SELECT col_description(to_regclass('${TABLE}'), ordinal_position) LIKE '%FALLBACK ONLY%'
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${TABLE_NAME}'
         AND column_name='recipient_contact'), false) AS ok`,
  ],
  [
    'recipient_name comment says blank means the employee receives it',
    `SELECT COALESCE((
       SELECT col_description(to_regclass('${TABLE}'), ordinal_position) LIKE '%Blank means the employee%'
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${TABLE_NAME}'
         AND column_name='recipient_name'), false) AS ok`,
  ],
  ...CONSTRAINTS.map((name): [string, string] => [
    `constraint ${name}`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') AS ok`,
  ]),
  [
    'partial index idx_egsd_alternate_recipient',
    `SELECT EXISTS (SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = 'idx_egsd_alternate_recipient') AS ok`,
  ],
];

/**
 * A legal row for this table. milestone_index is deliberately huge and the
 * email deliberately fake so a control row can never collide with a real
 * submission under UNIQUE (personal_email, milestone_index) — every control is
 * rolled back to a SAVEPOINT anyway, but a collision would make the suite fail
 * for a reason that has nothing to do with the constraints under test.
 */
const LEGAL_ROW: Record<string, string> = {
  personal_email: "'migration-control@example.invalid'",
  milestone_index: '99999',
  milestone_date: "'2026-01-01'",
  preferred_delivery_location: "'123 Control St, Cebu City'",
  active_contact_number: "'09170000000'",
  recipient_name: "''",
  recipient_relationship: "''",
  recipient_contact: "''",
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
 * indistinguishable from one where the constraints all do nothing.
 */
const POSITIVE_CONTROL: [string, string] = [
  'a row with NO alternate recipient is ACCEPTED (proves the suite can pass)',
  insertRow(),
];

const SECOND_POSITIVE: [string, string] = [
  'a fully named alternate recipient is ACCEPTED',
  insertRow({
    recipient_name: "'Maria Dela Cruz'",
    recipient_relationship: "'Spouse'",
    recipient_contact: "'09181234567'",
  }),
];

const THIRD_POSITIVE: [string, string] = [
  'a named recipient with NO contact number is ACCEPTED (the contact is optional — the courier calls the employee)',
  insertRow({
    recipient_name: "'Maria Dela Cruz'",
    recipient_relationship: "'Spouse'",
  }),
];

const NEGATIVE_CONTROLS: Array<[string, string]> = [
  [
    'a relationship with NO name is rejected (nobody to hand the parcel to)',
    insertRow({ recipient_relationship: "'Spouse'" }),
  ],
  [
    'a contact number with NO name is rejected (same hole, different field)',
    insertRow({ recipient_contact: "'09181234567'" }),
  ],
  [
    'a name with NO relationship is rejected',
    insertRow({ recipient_name: "'Maria Dela Cruz'" }),
  ],
  [
    'a WHITESPACE-ONLY name is rejected (it would read as "somebody else receives this" everywhere downstream)',
    insertRow({ recipient_name: "'   '", recipient_relationship: "'Spouse'" }),
  ],
  [
    'an unknown relationship is rejected, never coerced to blank',
    insertRow({ recipient_name: "'Maria Dela Cruz'", recipient_relationship: "'Landlord'" }),
  ],
  [
    'a relationship differing only in case is rejected (the list is the list)',
    insertRow({ recipient_name: "'Maria Dela Cruz'", recipient_relationship: "'spouse'" }),
  ],
  [
    'an over-long recipient name is rejected (matches the route limit)',
    insertRow({
      recipient_name: `'${'a'.repeat(121)}'`,
      recipient_relationship: "'Spouse'",
    }),
  ],
  [
    'an over-long recipient contact is rejected (matches the route limit)',
    insertRow({
      recipient_name: "'Maria Dela Cruz'",
      recipient_relationship: "'Spouse'",
      recipient_contact: `'${'9'.repeat(61)}'`,
    }),
  ],
];

const client = new Client({ connectionString });

async function main() {
  console.log(
    [
      `${verifyOnly ? 'VERIFY ONLY' : dryRun ? 'DRY RUN' : 'APPLY'} — Gift alternate recipient`,
      '',
      `  SQL        : ${SQL_PATH}`,
      `  Table      : ${TABLE}`,
      `  Columns    : ${COLUMNS.length}`,
      `  CHECKs     : ${CONSTRAINTS.length}`,
      `  Controls   : 3 positive, ${NEGATIVE_CONTROLS.length} negative`,
      '',
      '  No backfill and no UPDATE: the columns are NOT NULL DEFAULT \'\', so existing',
      '  rows read as "the employee receives it" without being rewritten.',
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

  for (const [label, sql] of [SECOND_POSITIVE, THIRD_POSITIVE]) {
    await client.query('SAVEPOINT pc2');
    let accepted = true;
    let why = '';
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${(e as Error).message}`;
    }
    await client.query('ROLLBACK TO SAVEPOINT pc2');
    await client.query('RELEASE SAVEPOINT pc2');
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

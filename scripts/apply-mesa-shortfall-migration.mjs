/**
 * Applies references/sql/migrate/2026-08-27_mesa_receipt_shortfall_and_payouts.sql
 * — `mesa_request_receipts.amount_php` (what each receipt is worth) plus the
 * `mesa_payroll_obligations` table (receipt shortfalls deducted from the next
 * paycheck, and offboard payouts credited to a leaver's final one) — then
 * verifies every object and constraint landed.
 *
 *   node scripts/apply-mesa-shortfall-migration.mjs           # apply + verify
 *   node scripts/apply-mesa-shortfall-migration.mjs --verify  # verify only
 *   node scripts/apply-mesa-shortfall-migration.mjs --dry     # rehearse, then ROLL BACK
 *
 * --dry applies the SQL and runs every check inside a transaction it always
 * rolls back. Postgres DDL is transactional, so this proves the migration
 * parses, the objects build, and the constraints actually reject bad rows —
 * while leaving production exactly as it was. Run it before the real apply.
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
 * The SQL is idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
 * DROP/ADD CONSTRAINT) and touches no row data, so a re-run is a no-op.
 *
 * Run it BEFORE deploying any code that reads or writes these objects. A deploy
 * that lands first does NOT break the existing MESA screens — nothing reads
 * these yet — but no shortfall or payout can be recorded until this runs.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH =
  "references/sql/migrate/2026-08-27_mesa_receipt_shortfall_and_payouts.sql";
const verifyOnly = process.argv.includes("--verify");
const dryRun = process.argv.includes("--dry");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add the SESSION POOLER URI to .env.local:",
      "  DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      "",
      "Percent-encode any '@' in the password as %40.",
    ].join("\n"),
  );
  process.exit(1);
}

// Each row: [label, SQL returning a single boolean column named ok]
const CHECKS = [
  [
    "mesa_request_receipts.amount_php exists",
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='mesa_request_receipts'
         AND column_name='amount_php'
     ) AS ok`,
  ],
  [
    "mesa_payroll_obligations table exists",
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='mesa_payroll_obligations'
     ) AS ok`,
  ],
  ...[
    "mesa_obligation_kind_chk",
    "mesa_obligation_direction_chk",
    "mesa_obligation_kind_direction_chk",
    "mesa_obligation_amount_positive_chk",
    "mesa_obligation_shortfall_within_request_chk",
    "mesa_obligation_settlement_atomic_chk",
    "mesa_obligation_due_week_is_saturday_chk",
    "mesa_obligation_settled_week_is_saturday_chk",
  ].map((name) => [
    `constraint ${name}`,
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = '${name}'
     ) AS ok`,
  ]),
  ...[
    "mesa_obligations_open_by_email_idx",
    "mesa_obligations_open_by_week_idx",
    "mesa_obligations_one_open_shortfall_per_request",
    "mesa_obligations_one_open_payout_per_email",
  ].map((name) => [
    `index ${name}`,
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = '${name}'
     ) AS ok`,
  ]),
];

/**
 * POSITIVE CONTROL — a fully legal row MUST insert.
 *
 * Without this, every negative control below could be "passing" because the
 * inserts fail for some unrelated reason (a typo, a missing column, a bad
 * date), and a suite that cannot accept a good row produces a report
 * indistinguishable from one where every constraint works. This runs FIRST and
 * aborts the rest if it fails. Same lesson as the pending-migrations probe
 * (memory/migration-pending-claims-are-folklore), which reported APPLIED for a
 * table that did not exist until a control was added.
 *
 * 2026-08-29 is a Saturday, so the week-model constraints must NOT fire here.
 */
const POSITIVE_CONTROL = [
  "a fully legal obligation is ACCEPTED (proves the suite can pass)",
  `INSERT INTO public.mesa_payroll_obligations
     (email, kind, direction, amount_php, requested_php, receipted_php, due_week_end)
   VALUES ('control@example.com','receipt_shortfall','deduct',458,8000,7542,'2026-08-29')`,
];

/**
 * Prove the constraints actually REJECT what they are meant to reject. A
 * constraint that exists but does not bite is indistinguishable from one that
 * works until the day it matters, so each of these inserts a deliberately
 * illegal row inside a savepoint that is always rolled back. Each violates
 * exactly ONE constraint — everything else about the row is legal, so a pass
 * cannot be credited to the wrong rule.
 */
const NEGATIVE_CONTROLS = [
  [
    "an inverted pairing (shortfall that CREDITS pay) is rejected",
    `INSERT INTO public.mesa_payroll_obligations
       (email, kind, direction, amount_php, due_week_end)
     VALUES ('control@example.com','receipt_shortfall','credit',100,'2026-08-29')`,
  ],
  [
    "a zero-value obligation is rejected",
    `INSERT INTO public.mesa_payroll_obligations
       (email, kind, direction, amount_php, due_week_end)
     VALUES ('control@example.com','receipt_shortfall','deduct',0,'2026-08-29')`,
  ],
  [
    "a non-Saturday due week is rejected",
    `INSERT INTO public.mesa_payroll_obligations
       (email, kind, direction, amount_php, due_week_end)
     VALUES ('control@example.com','receipt_shortfall','deduct',100,'2026-08-31')`,
  ],
  [
    "a half-settled row is rejected",
    `INSERT INTO public.mesa_payroll_obligations
       (email, kind, direction, amount_php, due_week_end, settled_at)
     VALUES ('control@example.com','receipt_shortfall','deduct',100,'2026-08-29', now())`,
  ],
  [
    "owing back more than was drawn is rejected",
    `INSERT INTO public.mesa_payroll_obligations
       (email, kind, direction, amount_php, requested_php, due_week_end)
     VALUES ('control@example.com','receipt_shortfall','deduct',500,100,'2026-08-29')`,
  ],
];

const client = new Client({ connectionString });

async function main() {
  await client.connect();

  if (dryRun) {
    // Rehearse the whole thing inside a transaction that is always rolled back.
    // Postgres DDL is transactional, so nothing survives this.
    const sql = readFileSync(SQL_PATH, "utf8");
    console.log(`DRY RUN — applying ${SQL_PATH} inside a transaction, then rolling back.\n`);
    await client.query("BEGIN");
    await client.query(sql);
  } else if (!verifyOnly) {
    const sql = readFileSync(SQL_PATH, "utf8");
    console.log(`Applying ${SQL_PATH} ...`);
    await client.query(sql);
    console.log("  applied.\n");
  } else {
    console.log("Verify only — not applying.\n");
  }

  console.log("Verifying objects:");
  let failed = 0;
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "MISS"}  ${label}`);
  }

  console.log("\nVerifying the constraints actually bite:");
  // SAVEPOINTs, not BEGIN/ROLLBACK: in --dry we are already inside the outer
  // transaction, and a nested BEGIN there would silently no-op while the
  // ROLLBACK discarded the entire rehearsal.
  if (!dryRun) await client.query("BEGIN");

  // Positive control first — if a good row cannot land, every "rejected" below
  // is meaningless and the suite must not claim success.
  {
    const [label, sql] = POSITIVE_CONTROL;
    await client.query("SAVEPOINT pc");
    let accepted = true;
    let why = "";
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${e.message}`;
    }
    await client.query("ROLLBACK TO SAVEPOINT pc");
    await client.query("RELEASE SAVEPOINT pc");
    console.log(`  ${accepted ? "OK  " : "FAIL"}  ${label}${why}`);
    if (!accepted) {
      await client.query("ROLLBACK");
      await client.end();
      console.error(
        "\nPositive control failed — the negative controls below would be meaningless. Aborting.",
      );
      process.exit(1);
    }
  }

  for (const [label, sql] of NEGATIVE_CONTROLS) {
    await client.query("SAVEPOINT nc");
    let rejected = false;
    try {
      await client.query(sql);
    } catch {
      rejected = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT nc");
    await client.query("RELEASE SAVEPOINT nc");
    if (!rejected) failed++;
    console.log(`  ${rejected ? "OK  " : "FAIL"}  ${label}`);
  }
  if (!dryRun) await client.query("ROLLBACK");

  if (dryRun) {
    await client.query("ROLLBACK");
    console.log("\nRolled back — production is unchanged.");
  }

  await client.end();

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch(async (e) => {
  console.error("\nFAILED:", e.message);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});

/**
 * Applies references/sql/create/create_payroll_rate_exemptions.sql — the
 * per-week "Ignore" store for Payroll Wizard → Readiness → No Pay Rate (the
 * rate twin of payroll_bank_exemptions) — then verifies the table, its CHECK,
 * its indexes and its Realtime publication row all landed, and that the
 * constraints actually bite.
 *
 *   node scripts/apply-rate-exemptions-migration.mjs           # apply + verify
 *   node scripts/apply-rate-exemptions-migration.mjs --verify  # verify only
 *   node scripts/apply-rate-exemptions-migration.mjs --dry     # rehearse, then ROLL BACK
 *
 * --dry applies the SQL and runs every check inside a transaction it always
 * rolls back. Postgres DDL is transactional, so this proves the migration
 * parses, the table builds, the identity CHECK rejects a keyless row and the
 * partial-unique index refuses a duplicate active ignore — while leaving
 * production exactly as it was. Run it before the real apply.
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
 * The SQL is idempotent (CREATE ... IF NOT EXISTS throughout), so a re-run is
 * a no-op. Run it BEFORE deploying the code that reads the table — until it
 * exists, the Readiness pane's Ignore button errors on save (the read side
 * fails soft: everyone simply stays listed).
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/create/create_payroll_rate_exemptions.sql";
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
    "table payroll_rate_exemptions exists",
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='payroll_rate_exemptions'
     ) AS ok`,
  ],
  [
    "constraint payroll_rate_exemptions_identity_present",
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'payroll_rate_exemptions_identity_present'
     ) AS ok`,
  ],
  [
    "index payroll_rate_exemptions_week_active_idx",
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = 'payroll_rate_exemptions_week_active_idx'
     ) AS ok`,
  ],
  [
    "index payroll_rate_exemptions_work_email_idx",
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = 'payroll_rate_exemptions_work_email_idx'
     ) AS ok`,
  ],
  [
    "partial-unique index payroll_rate_exemptions_one_active_per_person_week",
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public'
         AND indexname = 'payroll_rate_exemptions_one_active_per_person_week'
     ) AS ok`,
  ],
  [
    "table is in the supabase_realtime publication",
    `SELECT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public'
         AND tablename='payroll_rate_exemptions'
     ) AS ok`,
  ],
];

/**
 * POSITIVE CONTROL — a fully legal row MUST insert. Without it, the negative
 * controls could be "passing" because inserts fail for some unrelated reason,
 * and a suite that cannot accept a good row produces a report
 * indistinguishable from one where every constraint works. Runs FIRST and
 * aborts the rest if it fails (memory/migration-pending-claims-are-folklore).
 */
const POSITIVE_CONTROL = [
  "a legal ignore row is ACCEPTED (proves the suite can pass)",
  `INSERT INTO public.payroll_rate_exemptions (work_email, name, week_start, created_by)
   VALUES ('control@simple.biz', 'Control Person', '2000-01-02', 'control@simple.biz')`,
];

/**
 * Prove each rule actually REJECTS what it is meant to reject. Each insert is
 * legal in every respect EXCEPT the one rule under test, so a pass cannot be
 * credited to the wrong rule. Each runs inside a savepoint always rolled back.
 * The duplicate control inserts the SAME identity+week twice inside its
 * savepoint — the second must trip the partial-unique index.
 */
const NEGATIVE_CONTROLS = [
  [
    "a row with no identity at all is rejected (identity CHECK)",
    `INSERT INTO public.payroll_rate_exemptions (name, week_start)
     VALUES ('', '2000-01-02')`,
  ],
  [
    "a NULL week_start is rejected",
    `INSERT INTO public.payroll_rate_exemptions (work_email, name, week_start)
     VALUES ('control@simple.biz', 'Control Person', NULL)`,
  ],
  [
    "a second ACTIVE ignore for the same person-week is rejected (partial-unique)",
    `INSERT INTO public.payroll_rate_exemptions (work_email, name, week_start)
     VALUES ('control@simple.biz', 'Control Person', '2000-01-02'),
            ('control@simple.biz', 'Control Person', '2000-01-02')`,
  ],
];

/** A REVOKED row must NOT block re-ignoring the same person-week — the unique
 *  index is partial over the active slice, and this is the behaviour Undo →
 *  re-Ignore depends on. Expected to SUCCEED. */
const REVOKED_REINSERT_CONTROL = [
  "a revoked ignore does not block re-ignoring the same person-week",
  `WITH first_row AS (
     INSERT INTO public.payroll_rate_exemptions (work_email, name, week_start, revoked_at, revoked_by)
     VALUES ('control@simple.biz', 'Control Person', '2000-01-02', now(), 'control@simple.biz')
     RETURNING id
   )
   INSERT INTO public.payroll_rate_exemptions (work_email, name, week_start)
   SELECT 'control@simple.biz', 'Control Person', '2000-01-02' FROM first_row`,
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

  {
    const [label, sql] = REVOKED_REINSERT_CONTROL;
    await client.query("SAVEPOINT rc");
    let accepted = true;
    let why = "";
    try {
      await client.query(sql);
    } catch (e) {
      accepted = false;
      why = ` — ${e.message}`;
    }
    await client.query("ROLLBACK TO SAVEPOINT rc");
    await client.query("RELEASE SAVEPOINT rc");
    if (!accepted) failed++;
    console.log(`  ${accepted ? "OK  " : "FAIL"}  ${label}${why}`);
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

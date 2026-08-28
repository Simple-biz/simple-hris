/**
 * Applies references/sql/migrate/2026-08-28_offboarded_sheet_origin.sql —
 * `offboarded_sheet.origin` ('hris' | 'google_sheet'), the provenance column
 * the merged HR Offboarding tab shows — then verifies the column, its default,
 * its NOT NULL, its CHECK and its index all landed, AND that the backfill
 * reproduced the split the live data already implies.
 *
 *   node scripts/apply-offboarded-origin-migration.mjs           # apply + verify
 *   node scripts/apply-offboarded-origin-migration.mjs --verify  # verify only
 *   node scripts/apply-offboarded-origin-migration.mjs --dry     # rehearse, then ROLL BACK
 *
 * --dry applies the SQL and runs every check inside a transaction it always
 * rolls back. Postgres DDL is transactional, so this proves the migration
 * parses, the column builds, the CHECK actually rejects bad values and the
 * backfill lands the right counts — while leaving production exactly as it was.
 * Run it before the real apply.
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
 * The SQL is idempotent (ADD COLUMN IF NOT EXISTS, DROP/ADD CONSTRAINT, and a
 * backfill scoped to rows still lacking a value), so a re-run is a no-op.
 *
 * Run it BEFORE deploying the code that reads `origin`, and BEFORE
 * scripts/import-offboarded-from-json.mjs — that import writes the column
 * explicitly and cannot run without it.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/migrate/2026-08-28_offboarded_sheet_origin.sql";
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
    "offboarded_sheet.origin exists",
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='offboarded_sheet'
         AND column_name='origin'
     ) AS ok`,
  ],
  [
    "origin is NOT NULL",
    `SELECT COALESCE(
       (SELECT is_nullable = 'NO' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='offboarded_sheet'
           AND column_name='origin'), false) AS ok`,
  ],
  [
    "origin defaults to 'hris'",
    `SELECT COALESCE(
       (SELECT column_default LIKE '''hris''%' FROM information_schema.columns
         WHERE table_schema='public' AND table_name='offboarded_sheet'
           AND column_name='origin'), false) AS ok`,
  ],
  [
    "constraint offboarded_sheet_origin_check",
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'offboarded_sheet_origin_check'
     ) AS ok`,
  ],
  [
    "index offboarded_sheet_origin_idx",
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname = 'offboarded_sheet_origin_idx'
     ) AS ok`,
  ],
  // The backfill is the whole point: a column that exists but classified
  // nothing is worse than no column, because the UI would confidently label
  // 3,354 sheet-era rows "HRIS". Assert it against the signal it was derived
  // from, so a silently-skipped UPDATE cannot pass.
  [
    "every row with an HR actor is origin='hris'",
    `SELECT NOT EXISTS (
       SELECT 1 FROM public.offboarded_sheet
       WHERE off_boarded_by IS NOT NULL AND origin <> 'hris'
     ) AS ok`,
  ],
  [
    "every actor-less row is origin='google_sheet'",
    `SELECT NOT EXISTS (
       SELECT 1 FROM public.offboarded_sheet
       WHERE off_boarded_by IS NULL AND origin <> 'google_sheet'
     ) AS ok`,
  ],
  [
    "both origins are actually populated (neither side is empty)",
    `SELECT (
       (SELECT count(*) FROM public.offboarded_sheet WHERE origin='hris') > 0
       AND
       (SELECT count(*) FROM public.offboarded_sheet WHERE origin='google_sheet') > 0
     ) AS ok`,
  ],
];

/**
 * POSITIVE CONTROL — a fully legal row MUST insert.
 *
 * Without this, the negative controls below could be "passing" because the
 * inserts fail for some unrelated reason (a missing column, a NOT NULL
 * elsewhere), and a suite that cannot accept a good row produces a report
 * indistinguishable from one where every constraint works. This runs FIRST and
 * aborts the rest if it fails. Same lesson as the pending-migrations probe
 * (memory/migration-pending-claims-are-folklore), which reported APPLIED for a
 * table that did not exist until a control was added.
 */
const POSITIVE_CONTROL = [
  "a legal google_sheet row is ACCEPTED (proves the suite can pass)",
  `INSERT INTO public.offboarded_sheet (personal_email, work_email, origin)
   VALUES ('control@example.com','control@simple.biz','google_sheet')`,
];

/**
 * The DEFAULT is load-bearing in a way the CHECK cannot express:
 * /api/hr/offboard names the column explicitly, but any other INSERT that omits
 * it must still land a real value rather than a NULL that trips NOT NULL at
 * runtime. Assert the omitted-column path produces 'hris'.
 */
const DEFAULT_CONTROL = [
  "an INSERT that omits origin defaults to 'hris'",
  `INSERT INTO public.offboarded_sheet (personal_email, work_email)
   VALUES ('control@example.com','control@simple.biz')
   RETURNING origin`,
];

/**
 * Prove the constraint actually REJECTS what it is meant to reject. A CHECK
 * that exists but does not bite is indistinguishable from one that works until
 * the day it matters. Each insert is legal in every respect EXCEPT the one rule
 * under test, so a pass cannot be credited to the wrong rule. Each runs inside
 * a savepoint that is always rolled back.
 */
const NEGATIVE_CONTROLS = [
  [
    "an unrecognised origin ('sheet') is rejected",
    `INSERT INTO public.offboarded_sheet (personal_email, work_email, origin)
     VALUES ('control@example.com','control@simple.biz','sheet')`,
  ],
  [
    "a mis-cased origin ('HRIS') is rejected",
    `INSERT INTO public.offboarded_sheet (personal_email, work_email, origin)
     VALUES ('control@example.com','control@simple.biz','HRIS')`,
  ],
  [
    "an explicit NULL origin is rejected",
    `INSERT INTO public.offboarded_sheet (personal_email, work_email, origin)
     VALUES ('control@example.com','control@simple.biz', NULL)`,
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

  // Report the split the merged tab will show, so the apply is self-evidencing.
  {
    const { rows } = await client.query(
      `SELECT origin, count(*)::int AS n FROM public.offboarded_sheet GROUP BY origin ORDER BY origin`,
    );
    console.log("Origin split:");
    for (const r of rows) console.log(`  ${String(r.origin).padEnd(14)} ${r.n}`);
    console.log("");
  }

  console.log("Verifying objects:");
  let failed = 0;
  for (const [label, sql] of CHECKS) {
    const { rows } = await client.query(sql);
    const ok = rows[0]?.ok === true;
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "MISS"}  ${label}`);
  }

  console.log("\nVerifying the constraint actually bites:");
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

  {
    const [label, sql] = DEFAULT_CONTROL;
    await client.query("SAVEPOINT dc");
    let got = null;
    let why = "";
    try {
      const { rows } = await client.query(sql);
      got = rows[0]?.origin ?? null;
    } catch (e) {
      why = ` — ${e.message}`;
    }
    await client.query("ROLLBACK TO SAVEPOINT dc");
    await client.query("RELEASE SAVEPOINT dc");
    const ok = got === "hris";
    if (!ok) failed++;
    console.log(
      `  ${ok ? "OK  " : "FAIL"}  ${label}${ok ? "" : ` (got ${JSON.stringify(got)}${why})`}`,
    );
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

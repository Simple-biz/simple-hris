/**
 * Applies references/sql/alter/add_middle_name_to_onboarding.sql — one nullable
 * `middle_name` column on hr_onboarding_submissions AND hr_pending_employees, so
 * the onboarding paperwork can capture a middle name for HR records.
 *
 *   node scripts/apply-middle-name-columns.mjs          # apply + verify
 *   node scripts/apply-middle-name-columns.mjs --verify # verify only
 *
 * Needs DATABASE_URL in .env.local (the Supabase Postgres connection string:
 * Supabase dashboard → Project Settings → Database → Connection string → URI,
 * with the password filled in). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly.
 *
 * The .sql file wraps itself in BEGIN/COMMIT and is idempotent, so a re-run is a
 * no-op. Nothing here touches row data — there is no backfill, because a middle
 * name was never captured and cannot be recovered from full_name.
 *
 * Until this runs the app degrades rather than breaking: both writers strip a
 * `middle_name` the database rejects and retry, so a hire's paperwork always
 * lands (see OPTIONAL_COLUMN_FAMILIES in src/lib/supabase/hr-onboarding-
 * submissions.ts and src/lib/supabase/hr-pending-employees.ts).
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/add_middle_name_to_onboarding.sql";
const TABLES = ["hr_onboarding_submissions", "hr_pending_employees"];
const verifyOnly = process.argv.includes("--verify");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add it to .env.local, e.g.:",
      "  DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres",
      "",
      "Supabase dashboard → Project Settings → Database → Connection string → URI.",
      "Use the direct connection (port 5432), not the pooler — DDL on the pooler can fail.",
    ].join("\n"),
  );
  process.exit(1);
}

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!verifyOnly) {
    const sql = readFileSync(SQL_PATH, "utf8");
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(sql);
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");
  const { rows } = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name = ANY($1::text[])
        AND column_name='middle_name'
      ORDER BY table_name`,
    [TABLES],
  );
  console.log(`\nmiddle_name columns: ${rows.length} row(s)`);
  for (const r of rows) console.log("  ", JSON.stringify(r));

  if (rows.length === TABLES.length) {
    console.log(`\n✓ middle_name present on both tables (${TABLES.join(", ")}).`);
  } else {
    const found = new Set(rows.map((r) => r.table_name));
    console.error(
      `\n✗ expected ${TABLES.length} columns, found ${rows.length}. Missing: ${TABLES.filter(
        (t) => !found.has(t),
      ).join(", ")}`,
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nmigration FAILED (transaction rolled back):", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

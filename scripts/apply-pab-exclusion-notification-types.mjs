/**
 * Applies references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql
 * — widens employee_notifications.type CHECK to allow pab.excluded /
 * pab.restored — then verifies it landed.
 *
 *   node scripts/apply-pab-exclusion-notification-types.mjs           # apply + verify
 *   node scripts/apply-pab-exclusion-notification-types.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard -> Project Settings ->
 * Database -> Connection string -> URI, password filled in, direct port 5432 —
 * DDL on the pooler can fail). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly. Same shape as
 * scripts/apply-fix-security-definer-views.mjs.
 *
 * The SQL is idempotent (DROP CONSTRAINT IF EXISTS + re-ADD), so a re-run is a
 * no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql";
const NEW_TYPES = ["pab.excluded", "pab.restored"];
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
      "Supabase dashboard -> Project Settings -> Database -> Connection string -> URI.",
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
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'employee_notifications_type_check'`,
  );

  console.log("\n=== VERIFY ===");
  const def = rows[0]?.def ?? "";
  console.log(def || "(constraint not found)");

  const missing = NEW_TYPES.filter((t) => !def.includes(`'${t}'`));
  if (missing.length > 0) {
    console.error(`\n✗ CHECK constraint still missing: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ pab.excluded and pab.restored are both allowed now.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

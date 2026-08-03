/**
 * Applies references/sql/alter/2026-08-03_fix_security_definer_views.sql —
 * sets security_invoker=true on active_employees, employee_hourly_rates_current,
 * and active_hsl_agents (Supabase Advisor "Security Definer View", CRITICAL x3) —
 * then verifies it landed.
 *
 *   node scripts/apply-fix-security-definer-views.mjs           # apply + verify
 *   node scripts/apply-fix-security-definer-views.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard -> Project Settings ->
 * Database -> Connection string -> URI, password filled in, direct port 5432 —
 * DDL on the pooler can fail). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly. Same shape as scripts/apply-mesa-effective-date.mjs.
 *
 * The SQL is idempotent (ALTER VIEW ... SET, no column/type changes) and
 * touches no row data, so a re-run is a no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-03_fix_security_definer_views.sql";
const VIEWS = ["active_employees", "employee_hourly_rates_current", "active_hsl_agents"];
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
    `SELECT c.relname, c.reloptions
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])`,
    [VIEWS],
  );

  console.log("\n=== VERIFY ===");
  for (const r of rows) console.log("  ", JSON.stringify(r));

  const fixed = new Set(
    rows
      .filter((r) => (r.reloptions ?? []).some((o) => o === "security_invoker=true"))
      .map((r) => r.relname),
  );
  const missing = VIEWS.filter((v) => !fixed.has(v));

  if (missing.length > 0) {
    console.error(`\n✗ still SECURITY DEFINER (owner-privilege): ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ all three views now run as security_invoker — Advisor findings resolved.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

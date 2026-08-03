/**
 * Applies references/sql/alter/2026-08-03_restore_active_employees_definer.sql —
 * puts public.active_employees back on OWNER-privilege (definer) semantics after
 * Supabase Advisor's "Security Definer View" quick-fix silently emptied it for the
 * anon key and blanked the Payroll Wizard's department source of truth (422 of 1045
 * people re-labelled "Unassigned"). Leaves employee_hourly_rates_current and
 * active_hsl_agents on security_invoker = true — those were real leaks.
 *
 *   node scripts/apply-restore-active-employees-definer.mjs           # apply + verify
 *   node scripts/apply-restore-active-employees-definer.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard -> Project Settings ->
 * Database -> Connection string -> URI, password filled in, direct port 5432 — DDL
 * on the pooler can fail). The Supabase JS client cannot run DDL, hence `pg`.
 * Same shape as scripts/apply-fix-security-definer-views.mjs.
 *
 * NOTE: the app no longer depends on this. getEmployees() reads with the service
 * role first and self-heals from global_master_list if the view comes back empty
 * (src/lib/supabase/employees.ts). This restores correctness for every OTHER
 * caller of the view. Confirm with scripts/verify-active-employees-roster.mjs.
 *
 * The SQL is idempotent and touches no row data, so a re-run is a no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-03_restore_active_employees_definer.sql";
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
      "",
      "Alternative with no DATABASE_URL: paste the single ALTER VIEW line from",
      `  ${SQL_PATH}`,
      "into the Supabase dashboard SQL editor.",
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
    [["active_employees", "employee_hourly_rates_current", "active_hsl_agents"]],
  );

  const invoker = (name) => {
    const r = rows.find((x) => x.relname === name);
    return (r?.reloptions ?? []).some((o) => o === "security_invoker=true");
  };

  console.log("\n=== VERIFY ===");
  for (const r of rows) console.log("  ", JSON.stringify(r));

  const problems = [];
  if (invoker("active_employees")) {
    problems.push("active_employees is still security_invoker=true — it will read empty for anon");
  }
  for (const v of ["employee_hourly_rates_current", "active_hsl_agents"]) {
    if (!invoker(v)) problems.push(`${v} is NOT security_invoker=true — anon-key leak is open again`);
  }

  if (problems.length > 0) {
    console.error("");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
  } else {
    console.log(
      "\n✓ active_employees back on definer; the two sensitive views remain security_invoker.",
    );
    console.log("  Next: node scripts/verify-active-employees-roster.mjs");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

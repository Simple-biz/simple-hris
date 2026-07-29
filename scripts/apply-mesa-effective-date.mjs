/**
 * Applies references/sql/alter/2026-07-29_add_mesa_effective_date.sql — the
 * `effective_date` column behind the MESA Opt-out form's effective date — then
 * verifies it landed.
 *
 *   node scripts/apply-mesa-effective-date.mjs           # apply + verify
 *   node scripts/apply-mesa-effective-date.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard → Project Settings →
 * Database → Connection string → URI, password filled in, direct port 5432 —
 * DDL on the pooler can fail). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly. Same shape as
 * scripts/apply-contractor-dispatch-migration.mjs.
 *
 * The SQL is idempotent (ADD COLUMN IF NOT EXISTS) and touches no row data, so
 * a re-run is a no-op. Run it BEFORE deploying: the Opt-out form POSTs this
 * column, and without it every opt-out submission fails.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-07-29_add_mesa_effective_date.sql";
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
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='mesa_requests'
        AND column_name='effective_date'`,
  );
  console.log("\n=== VERIFY ===");
  for (const r of rows) console.log("  ", JSON.stringify(r));

  if (rows.length === 0) {
    console.error("\n✗ mesa_requests.effective_date is missing — opt-out submissions will fail.");
    process.exitCode = 1;
  } else {
    console.log("\n✓ mesa_requests.effective_date is present. Safe to deploy the Opt-out form.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

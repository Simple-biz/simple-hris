/**
 * Applies references/sql/alter/add_system_bonus_to_payment_dispatches.sql —
 * two nullable columns on payment_dispatches (system_bonus_php,
 * system_bonus_label) that snapshot the PAB/Tech bonus so the Paid tab can
 * show the same bonus chip the Pending queue shows.
 *
 *   node scripts/apply-system-bonus-dispatch-column.mjs          # apply + verify
 *   node scripts/apply-system-bonus-dispatch-column.mjs --verify # verify only
 *
 * Needs DATABASE_URL in .env.local (the Supabase Postgres connection string:
 * Supabase dashboard → Project Settings → Database → Connection string → URI,
 * with the password filled in). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly.
 *
 * The .sql file already wraps itself in BEGIN/COMMIT and is idempotent, so a
 * re-run is a no-op. Nothing here touches row data.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/add_system_bonus_to_payment_dispatches.sql";
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
  const { rows } = await client.query(`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_dispatches'
       AND column_name IN ('system_bonus_php','system_bonus_label')
     ORDER BY column_name`);
  console.log(`\npayment_dispatches columns: ${rows.length} row(s)`);
  for (const r of rows) console.log("  ", JSON.stringify(r));

  if (rows.length === 2) {
    console.log("\n✓ both columns present.");
  } else {
    console.error("\n✗ expected 2 columns, found", rows.length);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nmigration FAILED (transaction rolled back):", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

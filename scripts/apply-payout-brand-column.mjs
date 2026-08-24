/**
 * Applies references/sql/alter/add_payout_brand_to_onboarding.sql — one nullable
 * `payout_brand` column on hr_onboarding_submissions, so HR's copy of a hire's
 * paperwork keeps saying "Hurupay" for anyone who signed before the Kolan
 * rebrand while new paperwork says "Kolan".
 *
 *   node scripts/apply-payout-brand-column.mjs           # apply + verify
 *   node scripts/apply-payout-brand-column.mjs --verify  # verify only
 *
 * Routing is NOT touched. `payment_method` stays 'hurupay' for both brands —
 * see the .sql header and docs/features/bank-preferred-routing.md §4.
 *
 * Needs DATABASE_URL in .env.local. Use the SESSION POOLER string, not the
 * direct db.<ref>.supabase.co host — that host is IPv6-only and unreachable
 * from here. Supabase dashboard -> Connect -> Session pooler:
 *   postgresql://postgres.<ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 * An `@` inside the password MUST be percent-encoded as %40 or the URL parser
 * truncates it silently and you get an auth failure that looks like a bad password.
 *
 * The .sql wraps itself in BEGIN/COMMIT and is idempotent, so a re-run is a no-op.
 *
 * Until this runs the app degrades rather than breaking: the submit writer
 * strips a payout_brand the database rejects and retries (OPTIONAL_COLUMN_
 * FAMILIES in src/lib/supabase/hr-onboarding-submissions.ts), so a hire's
 * paperwork always lands; unstamped rows simply render "Hurupay".
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/add_payout_brand_to_onboarding.sql";
const TABLE = "hr_onboarding_submissions";
const COLUMN = "payout_brand";
const verifyOnly = process.argv.includes("--verify");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add the SESSION POOLER URI to .env.local, e.g.:",
      "  DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      "",
      "Supabase dashboard -> Connect -> Session pooler.",
      "Percent-encode an '@' in the password as %40, or the URL truncates silently.",
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
    console.log(`\napplying ${SQL_PATH} ...`);
    await client.query(sql);
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");
  const { rows: cols } = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [TABLE, COLUMN],
  );
  if (cols.length !== 1) {
    console.error(`\n✗ ${TABLE}.${COLUMN} not found.`);
    process.exitCode = 1;
  } else {
    console.log(`column: ${JSON.stringify(cols[0])}`);
    const { rows: dist } = await client.query(
      `SELECT COALESCE(${COLUMN}, '(null)') AS brand, count(*)::int AS n
         FROM public.${TABLE} GROUP BY 1 ORDER BY 1`,
    );
    console.log("\nbrand distribution:");
    for (const r of dist) console.log(`  ${String(r.brand).padEnd(10)} ${r.n}`);

    const nulls = dist.find((r) => r.brand === "(null)")?.n ?? 0;
    if (nulls > 0) {
      console.error(`\n✗ ${nulls} row(s) still NULL — the backfill did not run.`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ ${TABLE}.${COLUMN} present and every existing row stamped.`);
    }
  }
} catch (err) {
  console.error("\nmigration FAILED (transaction rolled back):", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

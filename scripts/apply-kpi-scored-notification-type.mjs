/**
 * Applies references/sql/alter/2026-08-17_add_kpi_scored_notification_type.sql
 * — widens employee_notifications.type CHECK to allow `kpi.scored` — then
 * verifies it landed.
 *
 *   node scripts/apply-kpi-scored-notification-type.mjs           # apply + verify
 *   node scripts/apply-kpi-scored-notification-type.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (direct port 5432, not the pooler — DDL on
 * the pooler can fail). The Supabase JS client cannot run DDL, which is why
 * this uses `pg` directly. Same shape as
 * scripts/apply-pab-exclusion-notification-types.mjs.
 *
 * Safety: because ADD CONSTRAINT restates the FULL allowed set, this script
 * first reads the LIVE constraint and ABORTS if it allows any type our SQL's
 * list is missing — restating a subset would silently break that other type's
 * INSERTs (the notify helpers swallow insert errors by design).
 *
 * The SQL is idempotent (DROP CONSTRAINT IF EXISTS + re-ADD); a re-run is a no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-17_add_kpi_scored_notification_type.sql";
const NEW_TYPES = ["kpi.scored"];
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

/** Every 'quoted' type name appearing in a CHECK definition / our SQL file. */
function extractTypes(sqlOrDef) {
  return new Set([...sqlOrDef.matchAll(/'([a-z0-9_.]+)'/gi)].map((m) => m[1]));
}

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  const readLiveDef = async () => {
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'employee_notifications_type_check'`,
    );
    return rows[0]?.def ?? "";
  };

  if (!verifyOnly) {
    // Superset guard: never clobber a type the live constraint already allows.
    const liveDef = await readLiveDef();
    const ourTypes = extractTypes(readFileSync(SQL_PATH, "utf8"));
    const liveOnly = [...extractTypes(liveDef)].filter((t) => !ourTypes.has(t));
    if (liveOnly.length > 0) {
      console.error(
        `\n✗ ABORT: live CHECK allows type(s) missing from ${SQL_PATH}: ${liveOnly.join(", ")}\n` +
          "  Applying would silently break those types' INSERTs. Add them to the SQL first.",
      );
      process.exit(1);
    }

    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");
  const def = await readLiveDef();
  console.log(def || "(constraint not found)");

  const missing = NEW_TYPES.filter((t) => !def.includes(`'${t}'`));
  if (missing.length > 0) {
    console.error(`\n✗ CHECK constraint still missing: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ kpi.scored is allowed now.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

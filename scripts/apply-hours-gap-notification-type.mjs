/**
 * Applies references/sql/alter/2026-08-21_add_payroll_hours_gap_notification_type.sql
 * — widens employee_notifications.type CHECK to allow `payroll.hours_gap` — then
 * verifies it landed.
 *
 *   node scripts/apply-hours-gap-notification-type.mjs           # apply + verify
 *   node scripts/apply-hours-gap-notification-type.mjs --verify  # verify only
 *
 * Until this runs, the zero-hours reminder notification does not exist: every
 * insert is rejected by the CHECK. `kpi.scored` shipped dead exactly that way
 * for three days. Verify, don't assume.
 *
 * Needs DATABASE_URL in .env.local — the Supabase JS client talks to PostgREST
 * and PostgREST cannot run DDL, which is why this uses `pg` directly. Same
 * shape as scripts/apply-kpi-scored-notification-type.mjs and
 * scripts/apply-ticket-moved-notification-type.mjs.
 *
 * Safety: because ADD CONSTRAINT restates the FULL allowed set, this script
 * first reads the LIVE constraint and ABORTS if it allows any type our SQL's
 * list is missing — restating a subset would silently break that other type's
 * INSERTs.
 *
 * The SQL is idempotent (DROP CONSTRAINT IF EXISTS + re-ADD); a re-run is a no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-21_add_payroll_hours_gap_notification_type.sql";
const NEW_TYPES = ["payroll.hours_gap"];
const verifyOnly = process.argv.includes("--verify");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add it to .env.local. For THIS project the working form is the SESSION",
      "POOLER (measured 2026-08-20 — the direct db.<ref> host is IPv6-only and",
      "unreachable here, so the older scripts' 'not the pooler' comment is wrong):",
      "",
      "  DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      "",
      "Three things silently break it:",
      "  * the user must be postgres.<project-ref>, not bare 'postgres'",
      "    (bare user answers 'Tenant or user not found')",
      "  * the region is aws-1 / us-east-2, not aws-0",
      "  * an '@' in the password MUST be percent-encoded as %40 — the first '@'",
      "    otherwise terminates the credentials and the driver misreads the host,",
      "    reporting 'password authentication failed' for a correct password",
      "",
      "Port 5432 (session mode) runs DDL fine. The 6543 transaction pooler does not.",
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
    console.log("\n✓ payroll.hours_gap is allowed now.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

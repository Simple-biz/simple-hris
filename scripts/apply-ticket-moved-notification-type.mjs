/**
 * Applies references/sql/alter/2026-08-21_add_ticket_moved_notification_type.sql
 * — widens employee_notifications.type CHECK to allow `ticket.moved` — then
 * verifies it landed.
 *
 *   node scripts/apply-ticket-moved-notification-type.mjs            # VERIFY ONLY (default)
 *   node scripts/apply-ticket-moved-notification-type.mjs --apply    # apply, then verify
 *
 * Verify-by-default is deliberate and is the repo rule (CLAUDE.md): a data
 * change ships behind an --apply gate, so running this by accident reads the
 * constraint and writes nothing. Same shape as
 * scripts/apply-kpi-scored-notification-type.mjs, which gated the other way.
 *
 * The Supabase JS client cannot run DDL, which is why this uses `pg` directly.
 *
 * Safety: because ADD CONSTRAINT restates the FULL allowed set, this script
 * first reads the LIVE constraint and ABORTS if it allows any type our SQL's
 * list is missing — restating a subset would silently break that other type's
 * INSERTs, and every notify helper in this codebase swallows insert errors by
 * design, so the breakage would be invisible.
 *
 * The SQL is idempotent (DROP CONSTRAINT IF EXISTS + re-ADD); a re-run is a no-op.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-21_add_ticket_moved_notification_type.sql";
const NEW_TYPES = ["ticket.moved"];
const apply = process.argv.includes("--apply");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add it to .env.local. Use the SESSION POOLER, not the direct host:",
      "  DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      "",
      "Supabase dashboard -> Project Settings -> Database -> Connection string -> Session pooler.",
      "Three things that have each silently cost a migration here:",
      "  - the username is postgres.<project-ref>, not bare postgres",
      "  - an `@` in the password MUST be percent-encoded as %40 — an unencoded",
      "    one truncates the host and the connection fails without saying why",
      "  - the direct db.<project-ref>.supabase.co host is IPv6-only and dead",
      "    from here, so port 5432 on the pooler is the working route",
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

  if (apply) {
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
  } else {
    console.log("\nVERIFY ONLY — nothing written. Re-run with --apply to widen the constraint.");
  }

  console.log("\n=== VERIFY ===");
  const def = await readLiveDef();
  console.log(def || "(constraint not found)");

  const missing = NEW_TYPES.filter((t) => !def.includes(`'${t}'`));
  if (missing.length > 0) {
    console.error(
      `\n✗ CHECK constraint does not allow: ${missing.join(", ")}` +
        (apply
          ? "\n  The apply did not take effect — do NOT report the tickets move-notification as live."
          : "\n  Expected before the apply. Re-run with --apply."),
    );
    process.exitCode = 1;
  } else {
    console.log("\n✓ ticket.moved is allowed now — in-app move notifications can insert.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

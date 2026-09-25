/**
 * Applies references/sql/alter/2026-09-25_add_support_closed_notification_type.sql
 * — widens employee_notifications.type CHECK to allow `support.closed` — then
 * verifies it landed.
 *
 *   node scripts/apply-support-closed-notification-type.mjs            # VERIFY ONLY (default, read-only)
 *   node scripts/apply-support-closed-notification-type.mjs --apply    # apply, verify, then commit
 *
 * Verify-by-default is deliberate and is the repo rule (CLAUDE.md): a data
 * change ships behind an --apply gate, so running this by accident reads the
 * constraint in a READ ONLY transaction and writes nothing. Same shape as
 * scripts/apply-ticket-moved-notification-type.mjs.
 *
 * The Supabase JS client cannot run DDL, which is why this uses `pg` directly.
 *
 * Safety, in two layers:
 *   1. The SQL itself can only WIDEN — it unions the live constraint with its
 *      own list, so no value that is live today can be dropped by it.
 *   2. This script checks that anyway, inside the transaction, BEFORE COMMIT:
 *      every value live before the apply must still be live after it, and
 *      `support.closed` must be present. Either failing → ROLLBACK, nothing kept.
 *
 * Until this runs, every support.closed insert is rejected and shows up only as
 * a `notification.insert_failed` row in audit_log — the employee is told nothing.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-09-25_add_support_closed_notification_type.sql";
const NEW_TYPES = ["support.closed"];
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

/** Every 'quoted' type name appearing in a CHECK definition. */
function extractTypes(def) {
  return new Set([...def.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
client.on("notice", (msg) => console.log(`  NOTICE: ${msg.message}`));

const readLiveDef = async () => {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'employee_notifications_type_check'`,
  );
  return rows[0]?.def ?? "";
};

let inTxn = false;
try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (apply) {
    await client.query("BEGIN");
    inTxn = true;

    const before = extractTypes(await readLiveDef());
    console.log(`\nlive constraint allows ${before.size} types before the apply.`);
    console.log(`applying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));

    const after = extractTypes(await readLiveDef());
    const lost = [...before].filter((t) => !after.has(t));
    const missing = NEW_TYPES.filter((t) => !after.has(t));
    if (lost.length > 0 || missing.length > 0) {
      await client.query("ROLLBACK");
      inTxn = false;
      if (lost.length > 0) console.error(`\n✗ ROLLED BACK: the apply would have DROPPED ${lost.join(", ")}.`);
      if (missing.length > 0) console.error(`\n✗ ROLLED BACK: ${missing.join(", ")} still not allowed after the apply.`);
      console.error("  Nothing was changed.");
      process.exitCode = 1;
    } else {
      await client.query("COMMIT");
      inTxn = false;
      console.log(`committed: ${before.size} → ${after.size} types, nothing dropped.`);
    }
  } else {
    await client.query("BEGIN READ ONLY");
    inTxn = true;
    console.log("\nVERIFY ONLY — read-only transaction, nothing written. Re-run with --apply to widen the constraint.");
  }

  console.log("\n=== VERIFY ===");
  const def = await readLiveDef();
  if (inTxn) {
    await client.query("ROLLBACK");
    inTxn = false;
  }
  const live = extractTypes(def);
  console.log(def ? `${live.size} types allowed.` : "(constraint not found)");

  const missing = NEW_TYPES.filter((t) => !live.has(t));
  if (missing.length > 0) {
    console.error(
      `\n✗ CHECK constraint does not allow: ${missing.join(", ")}` +
        (apply
          ? "\n  The apply did not take effect — do NOT report the ticket-closed notification as live."
          : "\n  Expected before the apply. Re-run with --apply."),
    );
    process.exitCode = 1;
  } else {
    console.log("\n✓ support.closed is allowed — a closed support ticket now notifies the employee.");
  }
} catch (err) {
  if (inTxn) await client.query("ROLLBACK").catch(() => {});
  console.error("\nmigration FAILED — rolled back, nothing kept:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

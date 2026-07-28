/**
 * Applies references/sql/alter/add_contractor_dispatch_link.sql — the schema
 * behind "contractors as Payment Dispatch payees" — in ONE transaction, then
 * verifies every part landed.
 *
 *   node scripts/apply-contractor-dispatch-migration.mjs          # apply + verify
 *   node scripts/apply-contractor-dispatch-migration.mjs --verify # verify only
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

const SQL_PATH = "references/sql/alter/add_contractor_dispatch_link.sql";
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

const VERIFY = {
  "contractor_invoices columns": `
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='contractor_invoices'
       AND column_name IN ('dispatch_id','dispatch_claimed_at','last_dispatched_at')
     ORDER BY column_name`,
  "payment_dispatches columns": `
    SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_dispatches'
       AND column_name IN ('payee_type','contractor_invoice_id')
     ORDER BY column_name`,
  "payee_type CHECK constraint": `
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid='public.payment_dispatches'::regclass
       AND conname='payment_dispatches_payee_type_check'`,
  "indexes": `
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname='public'
       AND indexname IN (
         'contractor_invoices_dispatch_id_idx',
         'contractor_invoices_payable_idx',
         'payment_dispatches_contractor_invoice_paid_uniq'
       )
     ORDER BY indexname`,
  "release trigger": `
    SELECT tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger
     WHERE tgrelid='public.payment_dispatches'::regclass
       AND tgname='payment_dispatches_release_contractor_invoice'`,
};

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
}

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!verifyOnly) {
    const sql = readFileSync(SQL_PATH, "utf8");
    console.log(`\napplying ${SQL_PATH} …`);
    // The file supplies its own BEGIN/COMMIT, so a failure anywhere rolls the
    // whole thing back — no partial migration.
    await client.query(sql);
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");
  for (const [label, sql] of Object.entries(VERIFY)) {
    const { rows } = await client.query(sql);
    console.log(`\n${label}: ${rows.length} row(s)`);
    for (const r of rows) console.log("  ", JSON.stringify(r));
  }

  // The single most important assertion: the clobber guard is really in the
  // live function body. Without it a contractor payment silently overwrites an
  // employee's disbursement record for that week.
  const { rows: fnRows } = await client.query(
    `SELECT pg_get_functiondef(oid) AS def
       FROM pg_proc
      WHERE proname='sync_disbursement_from_dispatch'
        AND pronamespace='public'::regnamespace`,
  );
  const def = fnRows[0]?.def ?? "";
  const guarded = /COALESCE\s*\(\s*NEW\.payee_type\s*,\s*'employee'\s*\)\s*<>\s*'employee'/i.test(def);
  console.log(`\nsync_disbursement_from_dispatch payee_type guard: ${guarded ? "PRESENT ✓" : "MISSING ✗"}`);
  if (!guarded) {
    fail(
      "PART 4 did not land. Do NOT pay any contractor until it does — a contractor payment would overwrite an employee's disbursement_records row for that week.",
    );
  }

  const { rows: idxRows } = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='payment_dispatches_contractor_invoice_paid_uniq'`,
  );
  const paidScoped = /status\s*=\s*'paid'/i.test(idxRows[0]?.indexdef ?? "");
  console.log(`unique index scoped to status='paid': ${paidScoped ? "YES ✓" : "NO ✗"}`);
  if (!paidScoped) {
    fail("The unique index is not scoped to status='paid' — a failed payment attempt would permanently block its own retry.");
  }

  if (process.exitCode !== 1) {
    console.log("\n✓ all parts verified. Next: node scripts/preflight-contractor-dispatch.mjs");
  }
} catch (err) {
  console.error("\nmigration FAILED (transaction rolled back):", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

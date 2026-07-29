/**
 * Applies references/sql/migrate/2026-07-29_payment_dispatches_cycle_id_text.sql —
 * payment_dispatches.cycle_id UUID → TEXT (drops the hubstaff_uploads FK) — then
 * verifies the column type and that the urgent-queue filter no longer errors.
 *
 * This unbreaks Payment Dispatch → Urgent → Mark as Paid, which failed with
 *   invalid input syntax for type uuid: "urgent"
 * because both urgent dispatch routes write the sentinel cycle_id='urgent'.
 *
 *   node scripts/apply-cycle-id-text.mjs           # apply + verify
 *   node scripts/apply-cycle-id-text.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (direct port 5432, not the pooler — DDL on
 * the pooler can fail). Same shape as scripts/apply-mesa-receipts.mjs.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/migrate/2026-07-29_payment_dispatches_cycle_id_text.sql";
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

let failed = false;

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!verifyOnly) {
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  console.log("\nverifying …");

  const { rows: cols } = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_dispatches' AND column_name='cycle_id'`,
  );
  const type = cols[0]?.data_type ?? "(column missing)";
  if (type === "text") {
    console.log("  ✓ cycle_id is text");
  } else {
    console.error(`  ✗ cycle_id is ${type}, expected text`);
    failed = true;
  }

  const { rows: fks } = await client.query(
    `SELECT conname FROM pg_constraint
     WHERE conrelid='public.payment_dispatches'::regclass AND contype='f'
       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid='public.payment_dispatches'::regclass
                             AND attname='cycle_id')]`,
  );
  if (fks.length === 0) {
    console.log("  ✓ no FK remains on cycle_id");
  } else {
    console.error(`  ✗ FK still present: ${fks.map((r) => r.conname).join(", ")}`);
    failed = true;
  }

  // The exact filter the urgent report reader / queue uses — errored pre-migration.
  const { rows: urgent } = await client.query(
    `SELECT count(*)::int AS n FROM public.payment_dispatches WHERE cycle_id = 'urgent'`,
  );
  console.log(`  ✓ cycle_id='urgent' filter works (${urgent[0].n} rows so far)`);
} catch (e) {
  console.error("FAILED:", e.message ?? e);
  failed = true;
} finally {
  await client.end();
}

process.exit(failed ? 1 : 0);

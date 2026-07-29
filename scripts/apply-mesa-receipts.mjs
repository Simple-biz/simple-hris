/**
 * Applies references/sql/migrate/2026-07-29_mesa_request_receipts.sql — the
 * private `mesa-receipts` bucket + the `mesa_request_receipts` table behind the
 * Receipt column on Employee → MESA → Request → Past requests — then verifies
 * both landed.
 *
 *   node scripts/apply-mesa-receipts.mjs           # apply + verify
 *   node scripts/apply-mesa-receipts.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (Supabase dashboard → Project Settings →
 * Database → Connection string → URI, password filled in, direct port 5432 —
 * DDL on the pooler can fail). The Supabase JS client cannot run DDL, which is
 * why this uses `pg` directly. Same shape as
 * scripts/apply-mesa-effective-date.mjs.
 *
 * The SQL is idempotent (CREATE ... IF NOT EXISTS / ON CONFLICT DO UPDATE) and
 * touches no row data, so a re-run is a no-op. Run it BEFORE deploying: the
 * upload endpoint writes this table, and the Receipt column reads it. (The
 * request list degrades gracefully without it — every row simply reports zero
 * receipts — so a deploy that lands first won't 500, it just can't accept a
 * receipt until this runs.)
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/migrate/2026-07-29_mesa_request_receipts.sql";
const BUCKET = "mesa-receipts";
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

  console.log("\n=== VERIFY ===");

  // 1. Columns
  const { rows: cols } = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='mesa_request_receipts'
      ORDER BY ordinal_position`,
  );
  console.log(`\nmesa_request_receipts — ${cols.length} column(s):`);
  for (const c of cols) {
    console.log(`   ${c.column_name.padEnd(12)} ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
  }
  const expectedCols = [
    "id",
    "request_id",
    "work_email",
    "slot",
    "file_path",
    "file_name",
    "file_size",
    "mime_type",
    "uploaded_by",
    "uploaded_at",
  ];
  const missing = expectedCols.filter((c) => !cols.some((r) => r.column_name === c));
  if (missing.length > 0) {
    console.error(`\n✗ missing column(s): ${missing.join(", ")}`);
    failed = true;
  }

  // 2. The 3-per-request cap (the unique constraint IS the cap — without it the
  //    API's slot pick can be raced by a double-submit).
  const { rows: cons } = await client.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.mesa_request_receipts'::regclass
        AND conname = 'mesa_request_receipts_slot_uniq'`,
  );
  if (cons.length === 0) {
    console.error("\n✗ mesa_request_receipts_slot_uniq is missing — the 3-receipt cap is not enforced.");
    failed = true;
  } else {
    console.log("\n✓ (request_id, slot) unique — 3-receipt cap enforced by the DB.");
  }

  // 3. The private bucket
  const { rows: buckets } = await client.query(
    `SELECT id, public, file_size_limit, allowed_mime_types
       FROM storage.buckets WHERE id = $1`,
    [BUCKET],
  );
  if (buckets.length === 0) {
    console.error(`\n✗ storage bucket '${BUCKET}' is missing — uploads will fail.`);
    failed = true;
  } else {
    const b = buckets[0];
    console.log(
      `\n✓ bucket '${b.id}' — public=${b.public}, limit=${b.file_size_limit} bytes, mime=[${(b.allowed_mime_types ?? []).join(", ")}]`,
    );
    if (b.public) {
      console.error("✗ bucket is PUBLIC — receipts must be private (read via signed URLs only).");
      failed = true;
    }
  }

  // 4. Existing rows, if this is a re-run
  const { rows: counted } = await client.query(
    `SELECT count(*)::int AS n, count(distinct request_id)::int AS requests
       FROM public.mesa_request_receipts`,
  );
  console.log(`\nrows: ${counted[0].n} receipt(s) across ${counted[0].requests} request(s).`);

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log("\n✓ MESA receipts are ready. Safe to deploy the Receipt column.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

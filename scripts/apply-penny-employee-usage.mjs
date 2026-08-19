/**
 * Applies references/sql/create/2026-08-19_penny_employee_usage.sql — the prompt
 * ledger behind Employee Penny AI's 10-per-Manila-day allowance — then verifies
 * the table and both indexes landed.
 *
 *   node scripts/apply-penny-employee-usage.mjs            # VERIFY ONLY (default)
 *   node scripts/apply-penny-employee-usage.mjs --apply    # apply, then verify
 *
 * Read-only unless --apply is passed, per CLAUDE.md: .env.local holds production
 * service-role credentials.
 *
 * Needs DATABASE_URL in .env.local (direct port 5432, not the pooler — DDL on the
 * pooler can fail). The Supabase JS client cannot run DDL, which is why this uses
 * `pg` directly. Same shape as scripts/apply-kpi-scored-notification-type.mjs.
 *
 * The SQL is idempotent (CREATE TABLE / INDEX IF NOT EXISTS); a re-run is a no-op.
 * There is no data migration and nothing to back up — the table starts empty, and
 * an empty ledger means "nobody has spent a prompt today", which is the correct
 * reading on day one.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/create/2026-08-19_penny_employee_usage.sql";
const TABLE = "penny_employee_usage";
const REQUIRED_COLUMNS = [
  "id",
  "session_email",
  "subject_email",
  "elevated",
  "asked_at",
  "manila_day",
  "tools_used",
  "refunded_at",
  "refund_reason",
];
const REQUIRED_INDEXES = [
  "penny_employee_usage_session_day_idx",
  "penny_employee_usage_subject_idx",
];

const apply = process.argv.includes("--apply");

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

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!apply) {
    console.log("\n(verify only — pass --apply to run the DDL)");
  } else {
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");

  const { rows: cols } = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [TABLE],
  );

  if (cols.length === 0) {
    console.error(`✗ table public.${TABLE} does not exist`);
    console.error("  Re-run with --apply (or paste the SQL in the Supabase SQL editor).");
    process.exitCode = 1;
  } else {
    for (const c of cols) {
      console.log(`  ${c.column_name.padEnd(15)} ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
    }
    const present = new Set(cols.map((c) => c.column_name));
    const missingCols = REQUIRED_COLUMNS.filter((c) => !present.has(c));
    if (missingCols.length > 0) {
      console.error(`\n✗ missing column(s): ${missingCols.join(", ")}`);
      process.exitCode = 1;
    }

    const { rows: idx } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1`,
      [TABLE],
    );
    const haveIdx = new Set(idx.map((r) => r.indexname));
    console.log(`\nindexes: ${[...haveIdx].sort().join(", ") || "(none)"}`);
    const missingIdx = REQUIRED_INDEXES.filter((i) => !haveIdx.has(i));
    if (missingIdx.length > 0) {
      console.error(`✗ missing index(es): ${missingIdx.join(", ")}`);
      process.exitCode = 1;
    }

    // The meter itself: charged rows today, so a support question ("did she
    // really use ten?") is answerable straight from this script.
    const { rows: tally } = await client.query(
      `SELECT count(*)::int AS charged,
              count(*) FILTER (WHERE refunded_at IS NOT NULL)::int AS refunded,
              count(DISTINCT lower(session_email))::int AS people
         FROM public.${TABLE}
        WHERE asked_at >= (now() AT TIME ZONE 'Asia/Manila')::date::timestamptz - interval '8 hours'`,
    );
    const t = tally[0] ?? { charged: 0, refunded: 0, people: 0 };
    console.log(
      `\ntoday (Manila): ${t.charged} row(s) across ${t.people} account(s), ${t.refunded} refunded`,
    );

    if (!process.exitCode) console.log("\n✓ penny_employee_usage is ready.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

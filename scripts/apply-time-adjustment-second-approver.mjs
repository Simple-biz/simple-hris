/**
 * Applies references/sql/alter/2026-08-19_time_adjustment_second_approver.sql
 * — adds the second-approver / dual-approval columns to time_adjustment_requests
 * — then verifies it landed.
 *
 *   node scripts/apply-time-adjustment-second-approver.mjs           # DRY RUN (default)
 *   node scripts/apply-time-adjustment-second-approver.mjs --apply   # actually apply
 *   node scripts/apply-time-adjustment-second-approver.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (direct port 5432, not the pooler — DDL on the
 * pooler can fail). The Supabase JS client cannot run DDL, which is why this uses
 * `pg` directly. Same shape as scripts/apply-kpi-scored-notification-type.mjs.
 *
 * Safety:
 *   * DRY RUN is the default — nothing is written without --apply (CLAUDE.md).
 *   * The migration backfills `manager_decision` on existing rows, so before
 *     applying, the pre-change row counts are written to a JSON backup on disk
 *     (CLAUDE.md: every bulk UPDATE needs a SELECT backup written first).
 *   * The SQL is idempotent (add column if not exists + guarded constraints +
 *     backfill restricted to `manager_decision is null`); a re-run is a no-op.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-08-19_time_adjustment_second_approver.sql";
const NEW_COLUMNS = [
  "second_approver_email",
  "second_approver_assigned_by",
  "second_approver_assigned_at",
  "second_decision",
  "second_decided_by",
  "second_decided_at",
  "second_decision_note",
  "manager_decision",
];

const verifyOnly = process.argv.includes("--verify");
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

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

const listColumns = async () => {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'time_adjustment_requests'`,
  );
  return new Set(rows.map((r) => r.column_name));
};

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  const before = await listColumns();
  const missing = NEW_COLUMNS.filter((c) => !before.has(c));
  console.log(`\ncolumns already present: ${NEW_COLUMNS.filter((c) => before.has(c)).join(", ") || "(none)"}`);
  console.log(`columns to add:          ${missing.join(", ") || "(none — already applied)"}`);

  // What the backfill would touch. Read BEFORE any write.
  const { rows: counts } = await client.query(
    `SELECT status, count(*)::int AS n
       FROM public.time_adjustment_requests
      GROUP BY status
      ORDER BY status`,
  );
  console.log("\nrows by status (pre-change):");
  for (const r of counts) console.log(`  ${r.status.padEnd(26)} ${r.n}`);

  if (!verifyOnly) {
    // SELECT backup to disk before the backfill UPDATE (CLAUDE.md).
    mkdirSync("scripts/backups", { recursive: true });
    const { rows: backup } = await client.query(
      `SELECT id, work_email, adjust_date, status
         FROM public.time_adjustment_requests
        ORDER BY created_at`,
    );
    const backupPath = "scripts/backups/time_adjustment_requests-pre-second-approver.json";
    writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), counts, rows: backup }, null, 2));
    console.log(`\nbackup written: ${backupPath} (${backup.length} rows)`);

    if (!apply) {
      console.log("\nDRY RUN — nothing was changed. Re-run with --apply to execute.");
      process.exit(0);
    }

    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  console.log("\n=== VERIFY ===");
  const after = await listColumns();
  const stillMissing = NEW_COLUMNS.filter((c) => !after.has(c));
  if (stillMissing.length > 0) {
    console.error(`\n✗ columns still missing: ${stillMissing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("✓ all second-approver columns present.");
  }

  // The backfill must leave no decided row without an explicit manager_decision,
  // or a legacy row would derive back to 'pending' and re-enter the queue.
  const { rows: gaps } = await client.query(
    `SELECT count(*)::int AS n
       FROM public.time_adjustment_requests
      WHERE manager_decision IS NULL
        AND status IN ('manager_approved', 'manager_denied', 'approved', 'denied')`,
  );
  if ((gaps[0]?.n ?? 0) > 0) {
    console.error(`\n✗ ${gaps[0].n} decided row(s) still have manager_decision NULL — backfill incomplete.`);
    process.exitCode = 1;
  } else {
    console.log("✓ every decided row carries an explicit manager_decision.");
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

/**
 * Applies references/sql/alter/2026-09-15_time_adjustment_stage1_waived.sql
 * — adds `stage1_waived_reason` to time_adjustment_requests and marks OPEN rows
 * filed by managers as waived (they go straight to Accounting) — then verifies.
 *
 *   node scripts/apply-time-adjustment-stage1-waived.mjs           # DRY RUN (default)
 *   node scripts/apply-time-adjustment-stage1-waived.mjs --apply   # actually apply
 *   node scripts/apply-time-adjustment-stage1-waived.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local (session pooler or direct 5432 — see
 * memory/migration-apply-needs-database-url.md). The Supabase JS client cannot run
 * DDL, which is why this uses `pg` directly. Same shape as
 * scripts/apply-time-adjustment-second-approver.mjs.
 *
 * Safety:
 *   * DRY RUN is the default — nothing is written without --apply (CLAUDE.md).
 *   * The migration UPDATEs open rows, so the pre-change rows are written to a JSON
 *     backup on disk first (CLAUDE.md: every bulk UPDATE needs a SELECT backup).
 *   * The SQL is idempotent (add column if not exists + guarded CHECK + backfill
 *     restricted to `stage1_waived_reason is null`); a re-run is a no-op.
 *   * The SQL carries no BEGIN/COMMIT; the multi-statement query below runs as one
 *     implicit transaction, so a failure mid-way leaves nothing half-applied.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/alter/2026-09-15_time_adjustment_stage1_waived.sql";
const NEW_COLUMN = "stage1_waived_reason";

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
    ].join("\n"),
  );
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

const hasColumn = async () => {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'time_adjustment_requests'
        AND column_name = $1`,
    [NEW_COLUMN],
  );
  return rows.length > 0;
};

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  const present = await hasColumn();
  console.log(`\n${NEW_COLUMN}: ${present ? "already present" : "MISSING — will be added"}`);

  // What the backfill would touch. Read BEFORE any write: open rows whose filer holds
  // an active department_managers assignment.
  const { rows: candidates } = await client.query(
    `SELECT t.id, t.work_email, t.adjust_date::text AS adjust_date, t.status, t.manager_decision, t.second_decision
       FROM public.time_adjustment_requests t
      WHERE t.status IN ('pending', 'awaiting_second_approval', 'manager_approved')
        AND EXISTS (
          SELECT 1 FROM public.department_managers d
           WHERE d.revoked_at IS NULL AND lower(d.manager_email) = lower(t.work_email)
        )
      ORDER BY t.created_at`,
  );
  console.log(`\nopen rows filed by a manager (would be marked '${"manager_filed"}'): ${candidates.length}`);
  for (const r of candidates) {
    console.log(
      `  ${String(r.id).slice(0, 8)} ${String(r.work_email).padEnd(26)} ${r.adjust_date} ${String(r.status).padEnd(26)} mgr=${r.manager_decision ?? "-"} 2nd=${r.second_decision ?? "-"}`,
    );
  }

  if (!verifyOnly) {
    // SELECT backup to disk before the UPDATE (CLAUDE.md).
    mkdirSync("scripts/backups", { recursive: true });
    const { rows: backup } = await client.query(
      `SELECT id, work_email, adjust_date::text AS adjust_date, status, manager_decision, second_decision, updated_at
         FROM public.time_adjustment_requests
        ORDER BY created_at`,
    );
    const backupPath = "scripts/backups/time_adjustment_requests-pre-stage1-waived.json";
    writeFileSync(
      backupPath,
      JSON.stringify({ takenAt: new Date().toISOString(), candidates, rows: backup }, null, 2),
    );
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
  if (!(await hasColumn())) {
    console.error(`\n✗ ${NEW_COLUMN} still missing.`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${NEW_COLUMN} present.`);
    // A waived row must derive to manager_approved; a stored pending/awaiting on a waived
    // row would contradict deriveAdjustmentStatus on day one.
    const { rows: bad } = await client.query(
      `SELECT count(*)::int AS n
         FROM public.time_adjustment_requests
        WHERE stage1_waived_reason IS NOT NULL
          AND status IN ('pending', 'awaiting_second_approval')`,
    );
    if ((bad[0]?.n ?? 0) > 0) {
      console.error(`\n✗ ${bad[0].n} waived row(s) still stored as pending/awaiting — backfill incomplete.`);
      process.exitCode = 1;
    } else {
      console.log("✓ every waived row is stored as manager_approved.");
    }
    const { rows: waived } = await client.query(
      `SELECT id, work_email, adjust_date::text AS adjust_date, status
         FROM public.time_adjustment_requests
        WHERE stage1_waived_reason = 'manager_filed'
        ORDER BY created_at`,
    );
    console.log(`\nwaived rows now: ${waived.length}`);
    for (const r of waived) {
      console.log(`  ${String(r.id).slice(0, 8)} ${String(r.work_email).padEnd(26)} ${r.adjust_date} ${r.status}`);
    }
  }
} catch (err) {
  console.error("\nmigration FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

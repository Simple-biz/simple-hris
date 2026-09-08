/**
 * Applies references/sql/create/2026-09-08_bonus_catalog_history.sql — Bonus
 * Library versioning: `version` + `effective_from` on bonus_catalog_bonuses, the
 * bonus_catalog_bonus_history and bonus_catalog_assignment_history tables, and
 * the baseline backfill (v1 per bonus, one `added` event per assignment). Then
 * verifies it landed.
 *
 *   node scripts/apply-bonus-history-migration.mjs           # apply + verify
 *   node scripts/apply-bonus-history-migration.mjs --verify  # verify only
 *
 * Needs DATABASE_URL in .env.local. Use the SESSION POOLER — the direct
 * db.<ref>.supabase.co host is IPv6-only and unreachable from this machine
 * (memory: migration-apply-needs-database-url):
 *   postgresql://postgres.<ref>:<password, @ as %40>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
 * The Supabase JS client cannot run DDL, which is why this uses `pg` directly.
 * Same shape as scripts/apply-mesa-effective-date.mjs.
 *
 * The SQL is idempotent and never UPDATEs an existing bonus row, so a re-run is
 * a no-op. Saves keep working before it lands (the app tolerates a missing
 * history table); the detail modal says "history unavailable" until it does.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SQL_PATH = "references/sql/create/2026-09-08_bonus_catalog_history.sql";
const verifyOnly = process.argv.includes("--verify");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    [
      "DATABASE_URL is not set.",
      "",
      "Add it to .env.local (session pooler, user postgres.<project-ref>, @ in the password as %40):",
      "  DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
    ].join("\n"),
  );
  process.exit(1);
}

// Supabase requires TLS; its cert chain is not in Node's default store.
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`connected: ${connectionString.replace(/:[^:@/]+@/, ":****@")}`);

  if (!verifyOnly) {
    console.log(`\napplying ${SQL_PATH} …`);
    await client.query(readFileSync(SQL_PATH, "utf8"));
    console.log("applied.");
  }

  const cols = await client.query(
    `SELECT column_name, data_type, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bonus_catalog_bonuses'
        AND column_name IN ('version', 'effective_from')
      ORDER BY column_name`,
  );
  console.log("\nbonus_catalog_bonuses columns:");
  for (const r of cols.rows) console.log(`  ${r.column_name}  ${r.data_type}  default ${r.column_default ?? "—"}`);
  const missingCols = ["effective_from", "version"].filter((c) => !cols.rows.some((r) => r.column_name === c));

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('bonus_catalog_bonus_history', 'bonus_catalog_assignment_history')
      ORDER BY table_name`,
  );
  const present = tables.rows.map((r) => r.table_name);
  const missingTables = ["bonus_catalog_assignment_history", "bonus_catalog_bonus_history"].filter(
    (t) => !present.includes(t),
  );

  if (missingCols.length || missingTables.length) {
    console.error(`\nNOT APPLIED — missing columns: ${missingCols.join(", ") || "none"}; missing tables: ${missingTables.join(", ") || "none"}`);
    process.exit(2);
  }

  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM public.bonus_catalog_bonuses)                                        AS bonuses,
      (SELECT count(*) FROM public.bonus_catalog_bonus_history)                                  AS versions,
      (SELECT count(*) FROM public.bonus_catalog_bonuses b
        WHERE NOT EXISTS (SELECT 1 FROM public.bonus_catalog_bonus_history h WHERE h.bonus_id = b.id)) AS bonuses_without_history,
      (SELECT count(*) FROM public.bonus_catalog_assignments)                                    AS assignments,
      (SELECT count(*) FROM public.bonus_catalog_assignment_history WHERE event = 'added')       AS added_events,
      (SELECT count(*) FROM public.bonus_catalog_assignments a
        WHERE NOT EXISTS (SELECT 1 FROM public.bonus_catalog_assignment_history h
                           WHERE h.assignment_id = a.id AND h.event = 'added'))                  AS assignments_without_history
  `);
  const c = counts.rows[0];
  console.log("\ncounts:");
  for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(28)} ${v}`);

  const ok = Number(c.bonuses_without_history) === 0 && Number(c.assignments_without_history) === 0;
  console.log(ok ? "\nOK — every bonus and assignment has a baseline history row." : "\nBACKFILL INCOMPLETE — see counts above.");
  process.exit(ok ? 0 : 3);
} catch (err) {
  console.error("\nfailed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

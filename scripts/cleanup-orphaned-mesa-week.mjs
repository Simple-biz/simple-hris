// Removes ORPHANED weekly MESA deposits: app-written ₱100+₱300 rows for a pay
// week whose Hubstaff upload has since been deleted (the pre-2026-07-25 delete
// path didn't reverse them — the deployed fix now does this automatically).
//
// Only rows matching the app-written signature are touched: deposit_date equal
// to the given week end, ₱100/₱300 amounts, and NO tracker provenance
// (status / opt_in_number / fpu_completion_date null) and NO disbursement
// fields. Sheet-backfilled ledger rows always carry tracker fields, so they
// can never match. Refuses to run if any remaining hubstaff_uploads row still
// covers the week. Also removes the week's orphaned payroll.available
// notifications (details.source_file no longer among the remaining uploads).
//
// Usage:  node scripts/cleanup-orphaned-mesa-week.mjs --week 2026-07-25          (dry run)
//         node scripts/cleanup-orphaned-mesa-week.mjs --week 2026-07-25 --apply
//
// Backup: matched rows are written to references/backups/ (gitignored) BEFORE
// any delete.

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const weekIdx = process.argv.indexOf("--week");
const WEEK_END = weekIdx >= 0 ? process.argv[weekIdx + 1] : null;
if (!WEEK_END || !/^\d{4}-\d{2}-\d{2}$/.test(WEEK_END)) {
  console.error("Pass --week YYYY-MM-DD (the pay week END date, a Saturday).");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const parseWeekEnd = (f) => {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(f ?? "");
  return m ? m[2] : null;
};

// ── Guard: refuse if any remaining upload still covers this week ──────────────
const { data: uploads, error: upErr } = await sb
  .from("hubstaff_uploads")
  .select("source_file");
if (upErr) throw upErr;
const remainingFiles = new Set((uploads ?? []).map((u) => u.source_file).filter(Boolean));
const covering = [...remainingFiles].filter((f) => parseWeekEnd(f) === WEEK_END);
if (covering.length > 0) {
  console.error(
    `REFUSING: ${covering.length} upload(s) still cover week ending ${WEEK_END}:\n  ${covering.join("\n  ")}\n` +
      "Their members' deposits are legitimate. Delete those uploads first if you really mean it.",
  );
  process.exit(1);
}

// ── Find the orphaned deposits (app-written signature only) ──────────────────
const { data: deposits, error: depErr } = await sb
  .from("mesa_ledger")
  .select("*")
  .eq("deposit_date", WEEK_END)
  .eq("worker_contribution_php", 100)
  .eq("simple_match_php", 300)
  .is("status", null)
  .is("opt_in_number", null)
  .is("fpu_completion_date", null)
  .is("disbursement_date", null)
  .is("disbursement_amount_php", null);
if (depErr) throw depErr;

// ── Find the week's orphaned payroll.available notifications ────────────────
const { data: notifs, error: nErr } = await sb
  .from("employee_notifications")
  .select("id, recipient_email, details")
  .eq("type", "payroll.available");
if (nErr) throw nErr;
const orphanNotifs = (notifs ?? []).filter((n) => {
  const sf = n.details?.source_file;
  return sf && parseWeekEnd(sf) === WEEK_END && !remainingFiles.has(sf);
});

console.log(`Week ending ${WEEK_END} — no remaining upload covers it.`);
console.log(`Orphaned mesa_ledger deposits : ${deposits.length}`);
console.log(`Orphaned payroll.available    : ${orphanNotifs.length}`);
for (const d of deposits.slice(0, 5)) console.log(`  e.g. id=${d.id} ${d.email}`);

if (!APPLY) {
  console.log("\nDry run — nothing deleted. Re-run with --apply to delete.");
  process.exit(0);
}

// ── Backup, then delete ──────────────────────────────────────────────────────
mkdirSync("references/backups", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = `references/backups/mesa_orphan_week_${WEEK_END}_${stamp}.json`;
writeFileSync(backupFile, JSON.stringify({ weekEnd: WEEK_END, deposits, notifications: orphanNotifs }, null, 2));
console.log(`\nBackup written: ${backupFile}`);

if (deposits.length > 0) {
  const ids = deposits.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await sb.from("mesa_ledger").delete().in("id", ids.slice(i, i + 200));
    if (error) throw error;
  }
  console.log(`Deleted ${ids.length} mesa_ledger deposits.`);
}
if (orphanNotifs.length > 0) {
  const ids = orphanNotifs.map((n) => n.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await sb.from("employee_notifications").delete().in("id", ids.slice(i, i + 200));
    if (error) throw error;
  }
  console.log(`Deleted ${ids.length} payroll.available notifications.`);
}
console.log("Done.");

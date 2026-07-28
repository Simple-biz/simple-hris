// Surgical seed (2026-07-27): make vano@simple.biz active as LEAD GEN.
//
// Context: Kane corrected his Department to "Lead Gen" on the master Google
// Sheet, but the sheet sync kept dying mid-batch on transient network errors
// ("TypeError: fetch failed"), so the roster still showed his 2026-07-27
// sheet-sync "Sales" row. This applies to his two global_master_list rows
// exactly what a SUCCESSFUL sync of the corrected sheet would have done:
//
//   1. Lead Gen row  efa1d486-… (employee_id 2509-0031, his original):
//      last_seen_upload_id → the CURRENT master upload  → row becomes active.
//   2. Sales row     28d91fe0-… (employee_id 2509-0054, minted post-split):
//      last_seen_upload_id → the PREVIOUS upload        → row ages out of
//      active_employees, the same way any sheet-removed row retires.
//
// Both rows are backed up to references/backups/ before writing.
// Re-running is idempotent. A later successful full sheet sync simply
// restamps the Lead Gen row onto its own new upload — no conflict.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const LEAD_GEN_ROW_ID = "efa1d486-5ed6-4888-ad29-543c0a2e550d";
const SALES_ROW_ID = "28d91fe0-e441-4ec1-b6f0-57f47ca4f71a";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Resolve the current + previous master uploads live (no hardcoded upload ids,
// so this stays correct even if a sync succeeds between writing and running).
const { data: uploads, error: upErr } = await supabase
  .from("master_list_uploads")
  .select("id, uploaded_at, is_current")
  .order("uploaded_at", { ascending: false })
  .limit(10);
if (upErr) throw new Error("uploads: " + upErr.message);
const current = uploads.find((u) => u.is_current);
if (!current) throw new Error("no is_current master upload");
const previous = uploads.find((u) => !u.is_current && u.uploaded_at < current.uploaded_at);
if (!previous) throw new Error("no previous master upload older than current");
console.log("current upload:", current.id, current.uploaded_at);
console.log("previous upload (for retiring the Sales row):", previous.id, previous.uploaded_at);

const { data: rows, error: selErr } = await supabase
  .from("global_master_list")
  .select("*")
  .in("id", [LEAD_GEN_ROW_ID, SALES_ROW_ID]);
if (selErr) throw new Error("select: " + selErr.message);
if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);

const leadGen = rows.find((r) => r.id === LEAD_GEN_ROW_ID);
const sales = rows.find((r) => r.id === SALES_ROW_ID);
if (leadGen["Department"] !== "Lead Gen") throw new Error(`row ${LEAD_GEN_ROW_ID} Department is ${leadGen["Department"]}, expected Lead Gen`);
if (sales["Department"] !== "Sales") throw new Error(`row ${SALES_ROW_ID} Department is ${sales["Department"]}, expected Sales`);

const backupDir = path.join("references", "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `vano-gml-rows-before-leadgen-seed-${Date.now()}.json`);
fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
console.log("backup written:", backupPath);

const u1 = await supabase
  .from("global_master_list")
  .update({ last_seen_upload_id: current.id })
  .eq("id", LEAD_GEN_ROW_ID);
if (u1.error) throw new Error("update lead gen row: " + u1.error.message);
console.log(`Lead Gen row ${LEAD_GEN_ROW_ID} → last_seen ${current.id}`);

const u2 = await supabase
  .from("global_master_list")
  .update({ last_seen_upload_id: previous.id })
  .eq("id", SALES_ROW_ID);
if (u2.error) throw new Error("update sales row: " + u2.error.message);
console.log(`Sales row ${SALES_ROW_ID} → last_seen ${previous.id} (retired from active)`);

// Verify through the same view the app reads.
const { data: active, error: vErr } = await supabase
  .from("active_employees")
  .select("*")
  .ilike("Work Email", "vano@simple.biz");
if (vErr) throw new Error("verify: " + vErr.message);
console.log("\nactive_employees rows for vano now:");
console.log(JSON.stringify(active?.map((r) => ({
  id: r.id, department: r["Department"], employee_id: r.employee_id,
})), null, 1));
if (active?.length === 1 && active[0]["Department"] === "Lead Gen") {
  console.log("\nOK: vano is active as Lead Gen (single row).");
} else {
  console.log("\nWARNING: unexpected active state — inspect above.");
}

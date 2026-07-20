// Re-mirrors the mesa_ledger table from a fresh "MESA Database - Active" sheet
// export (CSV), replacing the one-time SQL backfill path (load-mesa-ledger.mjs)
// for ongoing refreshes — the sheet stays the source of truth and this script
// re-syncs the mirror whenever a new export lands.
//
// The ledger's `id` is just the export row number (the original backfill did
// the same); nothing in the app references ledger ids — all reads aggregate by
// email (src/lib/mesa/ledger.ts). So a refresh upserts id = 1..N in file order,
// overwriting every existing row, and deletes any leftover ids past N.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply. The dry run parses the CSV,
// prints per-week deposit counts, and cross-checks the CURRENT DB content so
// you see exactly what would be lost/added before writing.
//
//   node scripts/load-mesa-ledger-from-csv.mjs "MESA Database - Active.csv"
//   node scripts/load-mesa-ledger-from-csv.mjs "MESA Database - Active.csv" --apply
//
// Expected export layout (sheet display headers; mapped by position):
//   FPU date, Opt in #, confirmation sent, last eligibility, Active/Inactive,
//   payroll notified, email, name, department, additional notes, deposit date,
//   worker contribution, simple match, total deposit, <spacer>, disbursement
//   date, disbursement amount, disbursement type, last disbursement, receipts
//   deadline, receipts received, funds returned x1153, funds returned mesa, notes

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const file = process.argv.find((a) => a.endsWith(".csv"));
if (!file) {
  console.error('Usage: node scripts/load-mesa-ledger-from-csv.mjs "<export>.csv" [--apply]');
  process.exit(1);
}
const BATCH = 500;

// MESA email-drift aliases (old ledger email → current roster email). Single
// source shared with the app (src/lib/mesa/email-aliases.ts). We re-key rows on
// load so the DB mirror stays attached to each member's CURRENT roster email
// even though the sheet keeps the old address — see that module for the why.
const MESA_EMAIL_ALIASES = JSON.parse(
  readFileSync(new URL("../src/data/mesa-email-aliases.json", import.meta.url), "utf8"),
);

// ── RFC4180 parse (quoted fields may contain commas, quotes, newlines) ──────
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { record.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { record.push(field); records.push(record); record = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

// ── value coercion ───────────────────────────────────────────────────────────
/** "6/15/2026" | "2026-06-15..." → "2026-06-15"; empty → null */
function toDate(s) {
  const t = (s ?? "").trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)))
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if ((m = t.match(/^(\d{4}-\d{2}-\d{2})/))) return m[1];
  return null; // free text in a date cell — drop rather than corrupt
}
/** "₱1,500.00" → 1500; empty → null */
function toMoney(s) {
  const t = (s ?? "").replace(/[₱,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const toText = (s) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

// CSV column index → mesa_ledger column (index 14 is a spacer in the sheet)
const MAP = [
  ["fpu_completion_date", 0, toDate],
  ["opt_in_number", 1, toText],
  ["optin_confirmation_sent", 2, toDate],
  ["last_eligibility_notice", 3, toDate],
  ["status", 4, toText],
  ["inactive_payroll_notified", 5, toDate],
  ["email", 6, toText],
  ["name", 7, toText],
  ["department", 8, toText],
  ["additional_notes", 9, toText],
  ["deposit_date", 10, toDate],
  ["worker_contribution_php", 11, toMoney],
  ["simple_match_php", 12, toMoney],
  ["total_daily_deposit_php", 13, toMoney],
  ["disbursement_date", 15, toDate],
  ["disbursement_amount_php", 16, toMoney],
  ["disbursement_type", 17, toText],
  ["last_disbursement_date", 18, toDate],
  ["receipts_deadline", 19, toDate],
  ["receipts_received_date", 20, toDate],
  ["funds_returned_x1153", 21, toDate],
  ["funds_returned_mesa", 22, toDate],
  ["notes", 23, toText],
];

const records = parseCsv(readFileSync(file, "utf8"));
const header = records[0] ?? [];
if (!/email/i.test(header[6] ?? "")) {
  console.error(`Column 7 of the header is "${header[6]}" — expected the email column. Layout changed?`);
  process.exit(1);
}

const syncedAt = new Date().toISOString();
const rows = [];
for (const rec of records.slice(1)) {
  const obj = {};
  for (const [col, idx, fn] of MAP) obj[col] = fn(rec[idx]);
  // Re-key drifted emails to the member's current roster address so their
  // contributions attach to the right person instead of a phantom.
  if (obj.email) {
    const canonical = MESA_EMAIL_ALIASES[obj.email.trim().toLowerCase()];
    if (canonical) obj.email = canonical;
  }
  // Skip filler rows: nothing to key on and nothing recorded.
  if (!obj.email && !obj.deposit_date && !obj.disbursement_date && !obj.name) continue;
  obj.id = rows.length + 1; // row order in the export IS the id (as in the original backfill)
  obj.synced_at = syncedAt;
  rows.push(obj);
}

console.log(`Parsed ${rows.length} ledger rows from ${file}`);
const emails = new Set(rows.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean));
console.log(`Distinct emails: ${emails.size}`);
const byWeek = new Map();
for (const r of rows) if (r.deposit_date) byWeek.set(r.deposit_date, (byWeek.get(r.deposit_date) ?? 0) + 1);
const weeks = [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0]));
console.log("Deposit rows for the 5 most recent dates:", weeks.slice(0, 5));
const disb = rows.filter((r) => r.disbursement_date);
console.log(`Disbursement rows: ${disb.length}`);

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ── preserve money history the new export no longer carries ─────────────────
// The Active tab drops old disbursement rows over time (e.g. the 2026-07-16
// export kept only 4 of the 128 disbursements the 2026-06-26 backfill had —
// PHP ~995k). Losing them would inflate balances (= deposited − disbursed), so
// any DB row whose deposit/disbursement key is absent from the export is
// re-appended after the sheet rows. A row half that IS still on the sheet is
// nulled out so it isn't double-counted.
const dbRows = [];
{
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("mesa_ledger").select("*").range(from, from + PAGE - 1);
    if (error) { console.error("DB read failed:", error.message); process.exit(1); }
    dbRows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
}
const low = (e) => (e ?? "").toLowerCase();
const csvDeposits = new Set(rows.filter((r) => r.deposit_date).map((r) => `${low(r.email)}|${r.deposit_date}`));
const csvDisb = new Set(disb.map((r) => `${low(r.email)}|${r.disbursement_date}|${r.disbursement_amount_php}`));
let nextId = rows.length;
const preserved = [];
for (const r of dbRows) {
  const depositLost = r.deposit_date && !csvDeposits.has(`${low(r.email)}|${r.deposit_date}`);
  const disbLost = r.disbursement_date && !csvDisb.has(`${low(r.email)}|${r.disbursement_date}|${r.disbursement_amount_php}`);
  if (!depositLost && !disbLost) continue;
  const copy = { ...r };
  if (r.deposit_date && !depositLost) {
    copy.deposit_date = null; copy.worker_contribution_php = null; copy.simple_match_php = null; copy.total_daily_deposit_php = null;
  }
  if (r.disbursement_date && !disbLost) {
    copy.disbursement_date = null; copy.disbursement_amount_php = null; copy.disbursement_type = null;
  }
  copy.id = ++nextId;
  copy.synced_at = syncedAt;
  preserved.push(copy);
}
const preservedDisbTotal = preserved.reduce((s, r) => s + (r.disbursement_amount_php ?? 0), 0);
console.log(`\nDB rows now: ${dbRows.length}. After apply: ${rows.length + preserved.length} (${rows.length} sheet + ${preserved.length} preserved).`);
console.log(`Preserved DB-only rows: ${preserved.filter((r) => r.disbursement_date).length} disbursements (PHP ${preservedDisbTotal.toLocaleString()}), ${preserved.filter((r) => r.deposit_date).length} deposits`);
for (const r of preserved.slice(0, 10)) console.log("  preserved:", r.email, r.deposit_date ?? "", r.disbursement_date ?? "", r.disbursement_amount_php ?? "");

if (!APPLY) {
  console.log("\nDry run only — pass --apply to write.");
  process.exit(0);
}

// ── write: upsert 1..N, then delete leftovers past N ─────────────────────────
const finalRows = [...rows, ...preserved];
let done = 0;
for (let start = 0; start < finalRows.length; start += BATCH) {
  const chunk = finalRows.slice(start, start + BATCH);
  const { error } = await supabase.from("mesa_ledger").upsert(chunk, { onConflict: "id" });
  if (error) { console.error(`Batch ${start}-${start + chunk.length} FAILED:`, error.message); process.exit(1); }
  done += chunk.length;
  console.log(`upserted ${done}/${finalRows.length}`);
}
const { error: delErr, count: delCount } = await supabase
  .from("mesa_ledger")
  .delete({ count: "exact" })
  .gt("id", finalRows.length);
if (delErr) console.error("Cleanup delete failed:", delErr.message);
else if (delCount) console.log(`deleted ${delCount} leftover rows with id > ${finalRows.length}`);
console.log("Done.");

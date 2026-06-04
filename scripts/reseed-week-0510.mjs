// Re-seed the Hubstaff week 2026-05-10..2026-05-17, replacing the previously
// stored rows for that source_file with the corrected CSV. Does NOT change which
// upload is_current. Dry-run by default; pass --commit to write.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
dotenv.config();

const COMMIT = process.argv.includes("--commit");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const table = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE || "hubstaff_hours";
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const CSV_PATH = "references/simple-biz_daily_report_2026-05-10_to_2026-05-17.csv";
const SRC = "simple-biz_daily_report_2026-05-10_to_2026-05-17.csv";
const UPLOAD_ID = "b22a5cb3-a4fd-4dde-ab16-9fb58c7ae6a1"; // existing archive row for this week

// DB columns (excluding auto id), exactly as in public.hubstaff_hours
const DB_COLS = [
  "Organization", "Time Zone", "Member", "Email", "Job title", "Job type",
  "Employee ID", "Tax info", "Location", "Time zone", "Date added",
  "Total worked", "Activity", "Spent total", "Currency",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

// --- minimal RFC4180 CSV parser ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- app's column-mapping helpers (faithful copies) ---
const CANONICAL_WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
function csvColToIsoDate(col) {
  const s = col.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}
function isoDateToWeekdayKey(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(dt.getTime())) return null;
  return CANONICAL_WEEKDAYS[dt.getUTCDay()] ?? null;
}
function dbColumnToWeekdayKey(c) {
  return CANONICAL_WEEKDAYS.includes(c.toLowerCase()) ? c.toLowerCase() : null;
}

// resolveColumnMapping — Pass1 exact ci, Pass3 weekday (last-wins). No ISO date DB cols here.
function resolveColumnMapping(headers) {
  const insertCols = [];
  const usedCsvIdx = new Set();
  for (const dbCol of DB_COLS) {
    const idx = headers.findIndex((h) => h.toLowerCase() === dbCol.toLowerCase());
    if (idx >= 0) { insertCols.push({ csvIdx: idx, dbCol }); usedCsvIdx.add(idx); }
  }
  const unmatchedWeekday = DB_COLS.filter(
    (c) => !insertCols.some((ic) => ic.dbCol === c) && dbColumnToWeekdayKey(c) !== null,
  );
  if (unmatchedWeekday.length) {
    const wkToIdx = new Map();
    headers.forEach((h, i) => {
      if (usedCsvIdx.has(i)) return;
      const iso = csvColToIsoDate(h);
      if (!iso) return;
      const wk = isoDateToWeekdayKey(iso);
      if (wk) wkToIdx.set(wk, i); // later column wins on collision (e.g. two Sundays)
    });
    for (const dbCol of unmatchedWeekday) {
      const wk = dbColumnToWeekdayKey(dbCol);
      const idx = wkToIdx.get(wk);
      if (idx !== undefined) { insertCols.push({ csvIdx: idx, dbCol }); usedCsvIdx.add(idx); }
    }
  }
  return insertCols;
}

// --- build rows ---
const grid = parseCsv(readFileSync(CSV_PATH, "utf8"));
const headers = grid[0].map((h) => h.trim());
const dataRows = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
const insertCols = resolveColumnMapping(headers);

const mapped = dataRows.map((r) => {
  const obj = {};
  for (const { csvIdx, dbCol } of insertCols) {
    const v = r[csvIdx] ?? "";
    obj[dbCol] = v === "" ? null : String(v);
  }
  obj.source_file = SRC;
  obj.upload_id = UPLOAD_ID;
  return obj;
});

console.log("=== column mapping (dbCol <- csvHeader) ===");
for (const { csvIdx, dbCol } of insertCols) console.log(`  ${dbCol.padEnd(14)} <- "${headers[csvIdx]}"`);
console.log(`\nparsed data rows: ${mapped.length}`);
console.log("sample mapped row (first):");
console.log(JSON.stringify(mapped[0], null, 2));

const { count: oldCount } = await supabase
  .from(table).select("*", { count: "exact", head: true })
  .eq("source_file", SRC).is("upload_id", null);
console.log(`\nexisting OLD rows to delete (source_file=SRC, upload_id IS NULL): ${oldCount}`);

if (!COMMIT) {
  console.log("\n[DRY RUN] no changes written. Re-run with --commit to apply.");
  process.exit(0);
}

// 1. insert new rows
console.log("\n[COMMIT] inserting new rows...");
for (let i = 0; i < mapped.length; i += 50) {
  const batch = mapped.slice(i, i + 50);
  const { error } = await supabase.from(table).insert(batch);
  if (error) { console.error(`insert failed @${i}: ${error.message}`); process.exit(1); }
}
const { count: newCount } = await supabase
  .from(table).select("*", { count: "exact", head: true })
  .eq("source_file", SRC).eq("upload_id", UPLOAD_ID);
console.log(`inserted; new rows now present: ${newCount} (expected ${mapped.length})`);
if (newCount !== mapped.length) {
  console.error("count mismatch after insert — aborting before delete. Inspect manually.");
  process.exit(1);
}

// 2. delete old rows
console.log("deleting old rows...");
const { error: delErr } = await supabase
  .from(table).delete().eq("source_file", SRC).is("upload_id", null);
if (delErr) { console.error(`delete failed: ${delErr.message}`); process.exit(1); }

// 3. update archive row_count
await supabase.from("hubstaff_uploads").update({ row_count: mapped.length }).eq("id", UPLOAD_ID);

// 4. verify
const { count: finalCount } = await supabase
  .from(table).select("*", { count: "exact", head: true }).eq("source_file", SRC);
console.log(`\nfinal rows for ${SRC}: ${finalCount} (all upload_id=${UPLOAD_ID})`);
console.log("done. is_current pointer untouched.");

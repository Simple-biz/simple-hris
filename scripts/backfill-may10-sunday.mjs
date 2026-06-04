// Backfill May 10 (Sunday) hours into the sunday column of the 2026-05-10..05-17
// week. ONLY the sunday column changes (was holding the misfiled May 17 value).
// Dry-run by default; pass --commit to write.
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

function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /*skip*/ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function hmsToSec(s) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}
function secToHms(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const grid = parseCsv(readFileSync(CSV_PATH, "utf8"));
const headers = grid[0].map((h) => h.trim());
const emailIdx = headers.findIndex((h) => h.toLowerCase() === "email");
const may10Idx = headers.findIndex((h) => h.trim() === "2026-05-10");
if (emailIdx < 0 || may10Idx < 0) { console.error("could not find Email / 2026-05-10 columns"); process.exit(1); }

const dataRows = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
const may10ByEmail = new Map();
let dupes = 0, sumSec = 0;
for (const r of dataRows) {
  const email = (r[emailIdx] ?? "").trim().toLowerCase();
  const val = (r[may10Idx] ?? "").trim();
  if (!email) continue;
  if (may10ByEmail.has(email)) dupes++;
  may10ByEmail.set(email, val);
  sumSec += hmsToSec(val);
}
console.log(`CSV data rows: ${dataRows.length}, unique emails: ${may10ByEmail.size}, dup emails: ${dupes}`);
console.log(`May 10 column total: ${secToHms(sumSec)}  (expected 450:25:20)`);

// fetch DB rows for this week
const dbRows = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from(table).select("id, Email, sunday").eq("source_file", SRC).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  dbRows.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
console.log(`DB rows for week: ${dbRows.length}`);

const TOTAL_HMS = secToHms(sumSec); // May 10 column total, for the CSV totals row (null email)
let matched = 0, unmatched = [], changed = 0, sample = [];
const updates = [];
for (const r of dbRows) {
  const email = (r.Email ?? "").trim().toLowerCase();
  // The Hubstaff export's trailing column-totals row has no Member/Email.
  if (!email) {
    matched++;
    if (r.sunday !== TOTAL_HMS) changed++;
    updates.push({ id: r.id, sunday: TOTAL_HMS });
    continue;
  }
  if (!may10ByEmail.has(email)) { unmatched.push(r.Email); continue; }
  matched++;
  const newVal = may10ByEmail.get(email);
  if (r.sunday !== newVal) changed++;
  if (sample.length < 5) sample.push({ email, oldSunday: r.sunday, newSunday: newVal });
  updates.push({ id: r.id, sunday: newVal });
}
console.log(`matched ${matched}/${dbRows.length}, unmatched ${unmatched.length}, sunday values changing: ${changed}`);
if (unmatched.length) console.log("unmatched DB emails:", unmatched.slice(0, 20));
console.log("sample (old sunday = May 17 value, new = May 10 value):");
console.log(JSON.stringify(sample, null, 2));

if (!COMMIT) { console.log("\n[DRY RUN] no changes written. Re-run with --commit."); process.exit(0); }
if (unmatched.length) { console.error("\nrefusing to commit: some DB rows have no CSV match."); process.exit(1); }

console.log("\n[COMMIT] updating sunday column...");
for (const u of updates) {
  const { error } = await supabase.from(table).update({ sunday: u.sunday }).eq("id", u.id);
  if (error) { console.error(`update failed id=${u.id}: ${error.message}`); process.exit(1); }
}

// verify
const { data: vr } = await supabase.from(table).select("sunday").eq("source_file", SRC);
let vsum = 0; for (const r of vr) vsum += hmsToSec(r.sunday);
console.log(`done. verified sunday column total now: ${secToHms(vsum)} (expected 450:25:20)`);

// Additively backfill Sunday May 10 onto its OWN calendar date by creating a
// complete, correct Mon-Sun week file (2026-05-04..2026-05-10) as a BACKDATED,
// non-current upload. Nothing existing is modified or deleted.
//   - sunday      = each person's May 10 hours (CSV first column)
//   - monday..sat = May 04..09, copied from the existing 05-03 week (identical
//                   values -> merge order can't corrupt them)
//   - uploaded_at = backdated so it never becomes files[0] (payroll source).
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
const PRIOR_SRC = "simple-biz_daily_report_2026-05-03_to_2026-05-09.csv"; // donor for Mon..Sat (05-04..05-09)
const NEW_SRC = "backfill-may10_2026-05-04_to_2026-05-10.csv";           // synthetic Mon-Sun week
const BACKDATED_AT = "2026-05-11T00:00:00+00:00"; // < current upload (06-01) so it never becomes files[0]

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
const norm = (e) => (e ?? "").trim().toLowerCase();

// 1. CSV -> per-email May 10 (sunday) + identity fields
const grid = parseCsv(readFileSync(CSV_PATH, "utf8"));
const H = grid[0].map((h) => h.trim());
const ix = (name) => H.findIndex((h) => h.toLowerCase() === name.toLowerCase());
const iOrg = ix("Organization"), iTz = ix("Time Zone"), iMember = ix("Member"), iEmail = ix("Email");
const iMay10 = H.findIndex((h) => h.trim() === "2026-05-10");
if (iEmail < 0 || iMay10 < 0) { console.error("CSV missing Email / 2026-05-10"); process.exit(1); }

const csvByEmail = new Map();
for (const r of grid.slice(1)) {
  if (!r.some((c) => c.trim() !== "")) continue;
  const email = norm(r[iEmail]);
  if (!email) continue; // skip the totals row (no email)
  csvByEmail.set(email, {
    Organization: r[iOrg]?.trim() || null,
    "Time Zone": r[iTz]?.trim() || null,
    "Time zone": r[iTz]?.trim() || null,
    Member: r[iMember]?.trim() || null,
    Email: r[iEmail]?.trim() || null,
    sunday: (r[iMay10]?.trim() || null),
  });
}

// 2. Prior week (05-03) -> per-email Mon..Sat (= calendar dates 05-04..05-09)
const priorRows = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from(table).select('Email, monday, tuesday, wednesday, thursday, friday, saturday')
    .eq("source_file", PRIOR_SRC).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  priorRows.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
const priorByEmail = new Map();
for (const r of priorRows) {
  const e = norm(r.Email);
  if (e) priorByEmail.set(e, r);
}

// 3. Build synthetic rows
const synthetic = [];
let withMonSat = 0, withMay10 = 0;
for (const [email, ident] of csvByEmail) {
  const p = priorByEmail.get(email);
  if (p) withMonSat++;
  if (ident.sunday && ident.sunday !== "0:00:00") withMay10++;
  synthetic.push({
    ...ident,
    monday: p?.monday ?? null,
    tuesday: p?.tuesday ?? null,
    wednesday: p?.wednesday ?? null,
    thursday: p?.thursday ?? null,
    friday: p?.friday ?? null,
    saturday: p?.saturday ?? null,
    source_file: NEW_SRC,
  });
}

const edward = synthetic.find((s) => norm(s.Email) === "edwardt@simple.biz");
console.log(`CSV employees: ${csvByEmail.size}`);
console.log(`  with Mon..Sat copied from 05-03 week: ${withMonSat}`);
console.log(`  with nonzero May 10 hours: ${withMay10}`);
console.log("Edward sample row:", JSON.stringify(edward, null, 2));
console.log(`\nWill create upload "${NEW_SRC}" (is_current=false, uploaded_at=${BACKDATED_AT})`);

if (!COMMIT) { console.log("\n[DRY RUN] nothing written. Re-run with --commit."); process.exit(0); }

// 4. Create backdated, non-current upload row
const { data: up, error: upErr } = await supabase
  .from("hubstaff_uploads")
  .insert({ source_file: NEW_SRC, row_count: synthetic.length, is_current: false, uploaded_by: "may10-backfill", uploaded_at: BACKDATED_AT })
  .select("id").single();
if (upErr) { console.error(`upload insert failed: ${upErr.message}`); process.exit(1); }
const uploadId = up.id;
console.log(`[COMMIT] created upload ${uploadId}`);

// 5. Insert synthetic rows
for (let i = 0; i < synthetic.length; i += 50) {
  const batch = synthetic.slice(i, i + 50).map((r) => ({ ...r, upload_id: uploadId }));
  const { error } = await supabase.from(table).insert(batch);
  if (error) { console.error(`row insert failed @${i}: ${error.message}`); process.exit(1); }
}
const { count } = await supabase.from(table).select("*", { count: "exact", head: true }).eq("source_file", NEW_SRC);
console.log(`inserted ${count} rows for ${NEW_SRC}.`);
console.log("done. May 10 now resolves to its own date; all other weeks untouched.");

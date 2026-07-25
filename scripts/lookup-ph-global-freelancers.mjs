/**
 * READ-ONLY lookup: takes the "PH Global Freelancers" Wise list and, for each
 * email, pulls their DEPARTMENT from the global master list and whatever bank /
 * payout info they set themselves in HRIS or via the external onboarding link
 * (employee_ids table).
 *
 * Input:  references/docs/PH Global Freelancers .xlsx  (Email / From / To)
 * Output: references/backups/<date>_ph_global_freelancers_lookup.csv (gitignored)
 *
 * Usage:  node scripts/lookup-ph-global-freelancers.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env/.env.local)");
  process.exit(1);
}
const supabase = createClient(url, key);

const norm = (e) => (e == null ? "" : String(e).trim().toLowerCase());

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function fetchAll(table, select = "*") {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── Read the freelancer list ────────────────────────────────────────────────
const wb = XLSX.readFile("references/docs/PH Global Freelancers .xlsx");
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }).slice(1); // drop header
const freelancers = rows
  .filter((r) => norm(r[0]))
  .map((r) => ({ email: norm(r[0]), from: String(r[1] ?? "").trim(), to: String(r[2] ?? "").trim() }));

// ── Load master list + HRIS payout rows ─────────────────────────────────────
const master = await fetchAll(
  "global_master_list",
  '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Employement Status",off_boarded_at',
);
const ids = await fetchAll("employee_ids");

// email → master row (index every email column, first-wins)
const masterByEmail = new Map();
for (const r of master) {
  for (const e of [r["Work Email"], r["Personal Email"], r["Alternate Work Email"], r["Alternate Work Email 2"]]) {
    const k = norm(e);
    if (k && !masterByEmail.has(k)) masterByEmail.set(k, r);
  }
}

// email → employee_ids row (work first, then personal)
const idsByEmail = new Map();
for (const r of ids) {
  const we = norm(r.work_email);
  const pe = norm(r.personal_email);
  if (we && !idsByEmail.has(we)) idsByEmail.set(we, r);
  if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r);
}

// ── Join ────────────────────────────────────────────────────────────────────
const header = [
  "Email (Wise list)",
  "Wise Last4",
  "Found in Master",
  "Name",
  "Department",
  "Employment Status",
  "Off-boarded",
  "Has HRIS Profile",
  "Bank Preferred",
  "Preferred Processor",
  "Wise Email",
  "Wise Tag",
  "Bank Name",
  "Account Holder Name",
  "Account Number",
  "Routing Number",
  "SWIFT",
  "Alt Bank Name",
  "Alt Account Holder",
  "Alt Account Number",
  "Alt Routing",
  "Self-updated At",
];

const out = [];
let matchedMaster = 0;
let hasBank = 0;
const notFound = [];

for (const f of freelancers) {
  const m = masterByEmail.get(f.email);
  const e = idsByEmail.get(f.email);
  if (m) matchedMaster++;
  else notFound.push(f.email);

  const anyBank =
    e &&
    [
      e.wise_email,
      e.wise_tag,
      e.bank_name,
      e.account_number,
      e.alt_bank_name,
      e.alt_account_number,
      e.hurupay_email,
      e.higlobe_email,
      e.wepay_email,
    ].some((v) => v != null && String(v).trim() !== "");
  if (anyBank) hasBank++;

  out.push([
    f.email,
    f.to,
    m ? "yes" : "NO",
    m?.["Name"] ?? e?.name ?? "",
    m?.["Department"] ?? e?.department ?? "",
    m?.["Employement Status"] ?? "",
    m?.off_boarded_at ? "yes" : "",
    e ? "yes" : "no",
    e?.bank_preferred ?? "",
    e?.preferred_processor ?? "",
    e?.wise_email ?? "",
    e?.wise_tag ?? "",
    e?.bank_name ?? "",
    e?.account_holder_name ?? "",
    e?.account_number ?? "",
    e?.routing_number ?? "",
    e?.swift_code ?? "",
    e?.alt_bank_name ?? "",
    e?.alt_account_holder_name ?? "",
    e?.alt_account_number ?? "",
    e?.alt_routing_number ?? "",
    e?.bank_last_self_updated_at ?? "",
  ]);
}

const csv = [header, ...out].map((cells) => cells.map(csvCell).join(",")).join("\n");
const outDir = path.join("references", "backups");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${new Date().toISOString().slice(0, 10)}_ph_global_freelancers_lookup.csv`);
fs.writeFileSync(outPath, csv + "\n");

console.log(`Freelancers in list : ${freelancers.length}`);
console.log(`Matched in master   : ${matchedMaster}`);
console.log(`Have HRIS bank info : ${hasBank}`);
console.log(`Not found in master : ${notFound.length}${notFound.length ? " -> " + notFound.join(", ") : ""}`);
console.log(`\nWrote ${outPath}`);

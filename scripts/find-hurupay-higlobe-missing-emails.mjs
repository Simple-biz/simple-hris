/**
 * READ-ONLY audit: every ACTIVE person who should be paid via HURUPAY or HIGLOBE
 * but has NO payout email attached — split by cause.
 *
 * "Routes to hurupay/higlobe" is resolved the way the Payment Dispatch queue does
 * (buildQueueFromRates precedence), plus the BD-for-HRIS CSV as an extra signal so
 * we also catch people who only exist there:
 *   1. employee_ids.bank_preferred        (known processor id)
 *   2. employee_ids.preferred_processor   (known processor id)
 *   3. legacy rates-row "Bank Preferred"   (fuzzy)
 *   4. BD for HRIS.csv  "From" column      (Hurupay / HiGlobe)
 *
 * Missing email = employee_ids.hurupay_email / higlobe_email is empty AND the rates
 * row carries no processor email either.
 *
 * Buckets:
 *   A) HAS employee_ids row, email column empty       → seedable in place
 *   B) NO employee_ids row (but on active master list) → needs a row created first
 *
 * Usage: node scripts/find-hurupay-higlobe-missing-emails.mjs [--csv]
 *   --csv  also writes references/backups/<date>_hurupay_higlobe_missing_emails.csv
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const WRITE_CSV = process.argv.includes("--csv");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE key.");
  process.exit(1);
}
const supabase = createClient(url, key);

const KNOWN = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);
const CSV_PATH = path.join("references", "docs", "BD for HRIS.csv");

function processorIdFromBankPreferred(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return null;
  if (v === "hurupay" || v === "huru" || v === "huropay") return "hurupay";
  if (v === "wepay") return "wepay";
  if (v === "higlobe" || v === "higloble" || v === "higlobel") return "higlobe";
  if (v === "wise" || v === "transferwise") return "wise";
  if (v === "jeeves") return "jeeves";
  if (/^x?\d{3,5}$/.test(v) || v === "wire" || v === "wires" || v.startsWith("wire")) return "wires";
  return null;
}

function csvProcessor(rawFrom) {
  if (!rawFrom) return null;
  const v = String(rawFrom).trim().toLowerCase().replace(/\s+/g, "");
  if (v === "hurupay" || v === "huru" || v === "huropay") return "hurupay";
  if (v === "higlobe" || v === "higloble" || v === "higlobel") return "higlobe";
  return null;
}

function pickFirst(...values) {
  for (const v of values) if (v != null && String(v).trim() !== "") return String(v).trim();
  return undefined;
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

function col(row, ...names) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const idx = new Map(Object.keys(row).map((k) => [norm(k), row[k]]));
  for (const n of names) {
    const v = idx.get(norm(n));
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

// ── Load ─────────────────────────────────────────────────────────────────────
let ratesRaw;
try {
  ratesRaw = await fetchAll("employee_hourly_rates_current");
} catch {
  ratesRaw = await fetchAll("employee_hourly_rates");
}
const ids = await fetchAll("employee_ids");
const master = await fetchAll("active_employees", '"Name","Work Email","Personal Email"');

// active master list, email → {name, work, personal}
const masterByEmail = new Map();
for (const r of master) {
  const we = r["Work Email"]?.trim().toLowerCase();
  const pe = r["Personal Email"]?.trim().toLowerCase();
  const rec = { name: r["Name"]?.trim() || we || pe, work: we || null, personal: pe || null };
  if (we) masterByEmail.set(we, rec);
  if (pe && !masterByEmail.has(pe)) masterByEmail.set(pe, rec);
}

const idsByEmail = new Map();
for (const r of ids) {
  const we = r.work_email?.trim().toLowerCase();
  const pe = r.personal_email?.trim().toLowerCase();
  if (we) idsByEmail.set(we, r);
  if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r);
}

const ratesByEmail = new Map();
for (const raw of ratesRaw) {
  const email = (col(raw, "Work Email") || col(raw, "Personal Email") || "").toLowerCase();
  if (email) ratesByEmail.set(email, raw);
}

// CSV: email → { processor, target } (last wins)
const csvByEmail = new Map();
const csvRaw = fs.readFileSync(CSV_PATH, "utf8").split(/\r?\n/);
csvRaw.shift();
for (const line of csvRaw) {
  if (!line.trim()) continue;
  const parts = line.split(",");
  const email = (parts[0] ?? "").trim().toLowerCase();
  const proc = csvProcessor(parts[1]);
  const target = (parts.slice(2).join(",") ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!email || !proc) continue;
  csvByEmail.set(email, { processor: proc, target });
}

// ── Universe of candidate emails: master ∪ rates ∪ csv, restricted to active ──
const candidates = new Set();
for (const e of masterByEmail.keys()) candidates.add(e);
for (const e of ratesByEmail.keys()) if (masterByEmail.has(e)) candidates.add(e);
for (const e of csvByEmail.keys()) if (masterByEmail.has(e)) candidates.add(e);

const bucketA = []; // has employee_ids row, email empty
const bucketB = []; // no employee_ids row

for (const email of candidates) {
  const idsRow = idsByEmail.get(email);
  const ratesRow = ratesByEmail.get(email);
  const csv = csvByEmail.get(email);
  const mrec = masterByEmail.get(email);

  // Resolve processor with the app's precedence, then CSV as a fallback signal.
  const choseBankPreferred = (idsRow?.bank_preferred ?? "").trim().toLowerCase();
  const choseProcessor = (idsRow?.preferred_processor ?? "").trim().toLowerCase();
  const ratesBankPref = ratesRow ? col(ratesRow, "Bank Preferred") : null;
  const resolved =
    (KNOWN.has(choseBankPreferred) ? choseBankPreferred : null) ??
    (KNOWN.has(choseProcessor) ? choseProcessor : null) ??
    processorIdFromBankPreferred(ratesBankPref) ??
    csv?.processor ??
    null;

  if (resolved !== "hurupay" && resolved !== "higlobe") continue;

  const column = resolved === "hurupay" ? "hurupay_email" : "higlobe_email";

  // Existing email from any known source.
  const existingEmail = pickFirst(
    resolved === "hurupay" ? idsRow?.hurupay_email : idsRow?.higlobe_email,
    ratesRow
      ? resolved === "hurupay"
        ? col(ratesRow, "Hurupay Email", "HuruPay Email Account")
        : col(ratesRow, "Higlobe Email", "HiGlobe Email Account")
      : null,
  );
  if (existingEmail) continue; // has an email — not missing

  const rec = {
    name: idsRow?.name?.trim() || mrec?.name || email,
    email,
    processor: resolved,
    column,
    resolvedBy: KNOWN.has(choseBankPreferred)
      ? "bank_preferred"
      : KNOWN.has(choseProcessor)
        ? "preferred_processor"
        : processorIdFromBankPreferred(ratesBankPref)
          ? "rates Bank Preferred"
          : "BD-CSV",
    csvTarget: csv?.target || null, // the email the CSV says to use, if any
  };

  if (idsRow) bucketA.push(rec);
  else bucketB.push(rec);
}

const sortFn = (a, b) => a.processor.localeCompare(b.processor) || a.name.localeCompare(b.name);
bucketA.sort(sortFn);
bucketB.sort(sortFn);

// ── Report ─────────────────────────────────────────────────────────────────
const line = (r) =>
  `  ${r.processor.toUpperCase().padEnd(8)} ${r.name.padEnd(34)} ${r.email.padEnd(30)} ` +
  `${r.csvTarget ? `CSV→ ${r.csvTarget}` : "(no CSV email on file)"}  [via ${r.resolvedBy}]`;

console.log(`\nACTIVE people on HURUPAY/HIGLOBE with NO payout email attached\n`);

console.log(`A) HAS an employee_ids row, email column empty — ${bucketA.length} (seedable in place):`);
bucketA.forEach((r) => console.log(line(r)));

console.log(`\nB) NO employee_ids row at all — ${bucketB.length} (need a row created first):`);
bucketB.forEach((r) => console.log(line(r)));

const withCsv = [...bucketA, ...bucketB].filter((r) => r.csvTarget).length;
const noCsv = [...bucketA, ...bucketB].filter((r) => !r.csvTarget).length;
console.log(
  `\nTotals: ${bucketA.length + bucketB.length} missing ` +
    `(${bucketA.length} in-place seedable, ${bucketB.length} need a row). ` +
    `${withCsv} have a CSV email to use, ${noCsv} have NO email anywhere (must be collected).`,
);

if (WRITE_CSV) {
  const dir = path.join("references", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${new Date().toISOString().slice(0, 10)}_hurupay_higlobe_missing_emails.csv`);
  const rows = [["bucket", "processor", "name", "email", "resolved_by", "csv_email", "column"]];
  for (const r of bucketA) rows.push(["A_has_row", r.processor, r.name, r.email, r.resolvedBy, r.csvTarget ?? "", r.column]);
  for (const r of bucketB) rows.push(["B_no_row", r.processor, r.name, r.email, r.resolvedBy, r.csvTarget ?? "", r.column]);
  fs.writeFileSync(p, rows.map((c) => c.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"));
  console.log(`\nWrote ${p}`);
}

/**
 * READ-ONLY export: active people routed to the Payment Dispatch HURUPAY tab
 * who have NO Hurupay email AND NO wire/bank details anywhere — i.e. nobody
 * can pay them until their payout data is collected (People-tab "Notify" flow).
 *
 * Output: references/backups/<date>_hurupay_no_payout_data.csv (gitignored dir).
 *
 * Usage: node scripts/export-hurupay-no-payout.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
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

const KNOWN = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);

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

function pickFirst(...values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
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

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Load ────────────────────────────────────────────────────────────────────
let ratesRaw;
try {
  ratesRaw = await fetchAll("employee_hourly_rates_current");
} catch {
  ratesRaw = await fetchAll("employee_hourly_rates");
}
const ids = await fetchAll("employee_ids");
const master = await fetchAll("active_employees", '"Name","Work Email","Personal Email","Department"');

// email → { name, department } from the master list (active people only).
const masterByEmail = new Map();
for (const r of master) {
  const entry = { name: r["Name"] ?? null, department: r["Department"] ?? null };
  for (const e of [r["Work Email"], r["Personal Email"]]) {
    const k = e ? String(e).trim().toLowerCase() : "";
    if (k && !masterByEmail.has(k)) masterByEmail.set(k, entry);
  }
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

// ── Select: active ∩ hurupay-routed ∩ no hurupay email ∩ no wire info ───────
const rows = [];
for (const [email, raw] of ratesByEmail) {
  const masterEntry = masterByEmail.get(email);
  if (!masterEntry) continue;
  const idsRow = idsByEmail.get(email);

  const choseBankPreferred = (idsRow?.bank_preferred ?? "").trim().toLowerCase();
  const choseProcessor = (idsRow?.preferred_processor ?? "").trim().toLowerCase();
  const chosen =
    (KNOWN.has(choseBankPreferred) ? choseBankPreferred : null) ??
    (KNOWN.has(choseProcessor) ? choseProcessor : null);
  const processor = chosen ?? processorIdFromBankPreferred(col(raw, "Bank Preferred"));
  if (processor !== "hurupay") continue;

  const hurupayEmail = pickFirst(idsRow?.hurupay_email, col(raw, "Hurupay Email", "HuruPay Email Account"));
  if (hurupayEmail) continue;

  const bankName = pickFirst(idsRow?.bank_name, idsRow?.alt_bank_name);
  const acctNum = pickFirst(idsRow?.account_number, idsRow?.alt_account_number);
  if (bankName && acctNum) continue; // has wire info — handled by the wires flip

  rows.push({
    name: idsRow?.name?.trim() || masterEntry.name || email,
    email,
    department: masterEntry.department ?? "",
    routedBy: KNOWN.has(choseBankPreferred)
      ? "bank_preferred"
      : KNOWN.has(choseProcessor)
        ? "preferred_processor"
        : "legacy rates sheet",
    hasProfileRow: idsRow ? "yes" : "no",
    partialBankName: bankName ?? "",
    partialAcctPresent: acctNum ? "yes" : "no",
  });
}

rows.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));

const outDir = path.join("references", "backups");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${new Date().toISOString().slice(0, 10)}_hurupay_no_payout_data.csv`);
const header = ["Name", "Work Email", "Department", "Routed To Hurupay By", "Has Profile Row", "Partial: Bank Name", "Partial: Acct # Present"];
const csv = [header, ...rows.map((r) => [r.name, r.email, r.department, r.routedBy, r.hasProfileRow, r.partialBankName, r.partialAcctPresent])]
  .map((cells) => cells.map(csvCell).join(","))
  .join("\n");
fs.writeFileSync(outPath, csv + "\n");

console.log(`Exported ${rows.length} people → ${outPath}`);
const byDept = new Map();
for (const r of rows) byDept.set(r.department || "(no dept)", (byDept.get(r.department || "(no dept)") ?? 0) + 1);
for (const [d, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${d}`);

/**
 * READ-ONLY diagnostic: people who route to the Payment Dispatch HURUPAY tab
 * but have NO Hurupay email anywhere — and whether their Employee Dashboard
 * (employee_ids) carries wire/bank details we could pay them through instead.
 *
 * Replicates buildQueueFromRates (src/components/payroll-clerk/mock-queue.ts)
 * processor precedence exactly:
 *   1. employee_ids.bank_preferred        (if a known processor id)
 *   2. employee_ids.preferred_processor   (if a known processor id)
 *   3. legacy rates-row "Bank Preferred"  (fuzzy string map)
 *
 * Usage: node scripts/check-hurupay-missing-emails.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY(.env/.env.local)");
  process.exit(1);
}
const supabase = createClient(url, key);

const KNOWN = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);

/** Mirror of processorIdFromBankPreferred in mock-queue.ts. */
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

/** Loose column getter for spaced/cased rates-view columns. */
function col(row, ...names) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const idx = new Map(Object.keys(row).map((k) => [norm(k), row[k]]));
  for (const n of names) {
    const v = idx.get(norm(n));
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

// ── Load sources ────────────────────────────────────────────────────────────
let ratesRaw;
try {
  ratesRaw = await fetchAll("employee_hourly_rates_current");
} catch {
  // View absent — fall back to base table (last row per email wins, like the app).
  ratesRaw = await fetchAll("employee_hourly_rates");
}
const ids = await fetchAll("employee_ids");
const master = await fetchAll("active_employees", '"Name","Work Email","Personal Email"');

const masterEmails = new Set(
  master
    .flatMap((r) => [r["Work Email"], r["Personal Email"]])
    .filter(Boolean)
    .map((e) => String(e).trim().toLowerCase()),
);

const idsByEmail = new Map();
for (const r of ids) {
  const we = r.work_email?.trim().toLowerCase();
  const pe = r.personal_email?.trim().toLowerCase();
  if (we) idsByEmail.set(we, r);
  if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r);
}

// Dedupe rates rows by email — last occurrence wins (matches buildQueueFromRates).
const ratesByEmail = new Map();
for (const raw of ratesRaw) {
  const email = (col(raw, "Work Email") || col(raw, "Personal Email") || "").toLowerCase();
  if (email) ratesByEmail.set(email, raw);
}

// ── Replicate routing, filter to hurupay, inspect emails + wire info ────────
const rows = [];
for (const [email, raw] of ratesByEmail) {
  const idsRow = idsByEmail.get(email);
  const choseBankPreferred = (idsRow?.bank_preferred ?? "").trim().toLowerCase();
  const choseProcessor = (idsRow?.preferred_processor ?? "").trim().toLowerCase();
  const ratesBankPreferred = col(raw, "Bank Preferred");
  const chosen =
    (KNOWN.has(choseBankPreferred) ? choseBankPreferred : null) ??
    (KNOWN.has(choseProcessor) ? choseProcessor : null);
  const processor = chosen ?? processorIdFromBankPreferred(ratesBankPreferred);
  if (processor !== "hurupay") continue;

  const hurupayEmail = pickFirst(idsRow?.hurupay_email, col(raw, "Hurupay Email", "HuruPay Email Account"));
  if (hurupayEmail) continue; // has a wallet email — fine, not our target

  // Wire info exactly as the queue resolves it (preferred slot first).
  const altSlot = idsRow?.preferred_bank_slot === "alternative";
  const bankName = altSlot
    ? pickFirst(idsRow?.alt_bank_name, idsRow?.bank_name)
    : pickFirst(idsRow?.bank_name, idsRow?.alt_bank_name);
  const acctNum = altSlot
    ? pickFirst(idsRow?.alt_account_number, idsRow?.account_number)
    : pickFirst(idsRow?.account_number, idsRow?.alt_account_number);
  const holder = altSlot
    ? pickFirst(idsRow?.alt_account_holder_name, idsRow?.account_holder_name)
    : pickFirst(idsRow?.account_holder_name, idsRow?.alt_account_holder_name);
  const swift = altSlot
    ? pickFirst(idsRow?.alt_routing_number, idsRow?.swift_code, idsRow?.routing_number)
    : pickFirst(idsRow?.swift_code, idsRow?.routing_number, idsRow?.alt_routing_number);

  rows.push({
    name: idsRow?.name?.trim() || col(raw, "Name") || email,
    email,
    onMasterList: masterEmails.has(email),
    routedBy: KNOWN.has(choseBankPreferred)
      ? `employee_ids.bank_preferred='${choseBankPreferred}'`
      : KNOWN.has(choseProcessor)
        ? `employee_ids.preferred_processor='${choseProcessor}'`
        : `rates "Bank Preferred"='${ratesBankPreferred}'`,
    hasWireInfo: Boolean(bankName && acctNum),
    bankName: bankName ?? null,
    acctLast4: acctNum ? `…${String(acctNum).replace(/\s+/g, "").slice(-4)}` : null,
    holder: holder ?? null,
    hasSwift: Boolean(swift),
  });
}

rows.sort((a, b) => Number(b.onMasterList) - Number(a.onMasterList) || a.name.localeCompare(b.name));

const active = rows.filter((r) => r.onMasterList);
console.log(`\nHurupay-routed people with NO Hurupay email: ${rows.length} total, ${active.length} on the active master list\n`);
for (const r of rows) {
  console.log(
    [
      r.onMasterList ? "[ACTIVE]" : "[stale ]",
      r.name.padEnd(32),
      r.email.padEnd(38),
      r.hasWireInfo ? `WIRE OK: ${r.bankName} ${r.acctLast4}${r.hasSwift ? " +SWIFT" : " (no SWIFT)"}` : "NO WIRE INFO",
      `| via ${r.routedBy}`,
    ].join(" "),
  );
}
console.log(
  `\nSummary (active only): ${active.filter((r) => r.hasWireInfo).length} have wire info, ` +
    `${active.filter((r) => !r.hasWireInfo).length} have neither Hurupay email nor wire info.`,
);

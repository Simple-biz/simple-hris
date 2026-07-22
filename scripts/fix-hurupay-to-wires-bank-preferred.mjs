/**
 * Fix: active people routed to the Payment Dispatch HURUPAY tab who have NO
 * Hurupay email but DO have wire/bank details on their Employee Dashboard.
 * Their receiving rail is really a bank wire, so set
 * employee_ids.bank_preferred = 'wires' — Bank Preferred wins routing
 * precedence, moving them to the Wires tab where Mark as Paid surfaces their
 * dashboard bank details + SWIFT.
 *
 * Selection (recomputed live, mirrors buildQueueFromRates):
 *   on active master list
 *   AND resolved processor = 'hurupay'
 *   AND no hurupay_email (employee_ids nor rates row)
 *   AND wire info present (bank_name + account_number via preferred slot)
 *   AND employee_ids.bank_preferred currently empty (never clobbers a choice)
 *
 * Usage:
 *   node scripts/fix-hurupay-to-wires-bank-preferred.mjs           # dry run
 *   node scripts/fix-hurupay-to-wires-bank-preferred.mjs --apply   # backup + update
 *
 * Backup: writes the affected employee_ids rows (full row JSON) to
 * references/backups/<date>_hurupay_to_wires_bank_preferred.json before updating.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (writes need service role).");
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

// ── Load + select targets ───────────────────────────────────────────────────
let ratesRaw;
try {
  ratesRaw = await fetchAll("employee_hourly_rates_current");
} catch {
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

const ratesByEmail = new Map();
for (const raw of ratesRaw) {
  const email = (col(raw, "Work Email") || col(raw, "Personal Email") || "").toLowerCase();
  if (email) ratesByEmail.set(email, raw);
}

const targets = [];
for (const [email, raw] of ratesByEmail) {
  if (!masterEmails.has(email)) continue;
  const idsRow = idsByEmail.get(email);
  if (!idsRow) continue; // wire info lives on employee_ids — nothing to route without a row

  const choseBankPreferred = (idsRow.bank_preferred ?? "").trim().toLowerCase();
  const choseProcessor = (idsRow.preferred_processor ?? "").trim().toLowerCase();
  const chosen =
    (KNOWN.has(choseBankPreferred) ? choseBankPreferred : null) ??
    (KNOWN.has(choseProcessor) ? choseProcessor : null);
  const processor = chosen ?? processorIdFromBankPreferred(col(raw, "Bank Preferred"));
  if (processor !== "hurupay") continue;

  const hurupayEmail = pickFirst(idsRow.hurupay_email, col(raw, "Hurupay Email", "HuruPay Email Account"));
  if (hurupayEmail) continue;

  const altSlot = idsRow.preferred_bank_slot === "alternative";
  const bankName = altSlot
    ? pickFirst(idsRow.alt_bank_name, idsRow.bank_name)
    : pickFirst(idsRow.bank_name, idsRow.alt_bank_name);
  const acctNum = altSlot
    ? pickFirst(idsRow.alt_account_number, idsRow.account_number)
    : pickFirst(idsRow.account_number, idsRow.alt_account_number);
  if (!bankName || !acctNum) continue; // no wire info — leave for data collection

  // Never clobber an explicit Bank Preferred choice (shouldn't exist here,
  // since a known bank_preferred would have won routing — belt and braces).
  if (choseBankPreferred) {
    console.warn(`SKIP ${email}: bank_preferred already '${idsRow.bank_preferred}'`);
    continue;
  }

  targets.push({
    email,
    employee_id: idsRow.employee_id,
    name: idsRow.name?.trim() || email,
    bankName,
    acctLast4: `…${String(acctNum).replace(/\s+/g, "").slice(-4)}`,
    row: idsRow,
  });
}

targets.sort((a, b) => a.name.localeCompare(b.name));

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — bank_preferred → 'wires' for ${targets.length} people:\n`);
for (const t of targets) {
  console.log(`  ${t.name.padEnd(36)} ${t.email.padEnd(30)} ${t.bankName} ${t.acctLast4}`);
}

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to backup + update.");
  process.exit(0);
}

// ── Backup, then update ─────────────────────────────────────────────────────
const backupDir = path.join("references", "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(
  backupDir,
  `${new Date().toISOString().slice(0, 10)}_hurupay_to_wires_bank_preferred.json`,
);
fs.writeFileSync(backupPath, JSON.stringify(targets.map((t) => t.row), null, 2));
console.log(`\nBacked up ${targets.length} employee_ids rows → ${backupPath}`);

let ok = 0;
let failed = 0;
for (const t of targets) {
  const { data, error } = await supabase
    .from("employee_ids")
    .update({ bank_preferred: "wires" })
    .eq("employee_id", t.employee_id)
    .is("bank_preferred", null) // only if still unset (no clobber race)
    .select("employee_id");
  if (error) {
    failed += 1;
    console.error(`  FAIL ${t.email}: ${error.message}`);
  } else if (!data || data.length === 0) {
    failed += 1;
    console.error(`  SKIP ${t.email}: row changed since selection (bank_preferred no longer null)`);
  } else {
    ok += 1;
    console.log(`  OK   ${t.email} → wires`);
  }
}
console.log(`\nDone: ${ok} updated, ${failed} failed/skipped. Backup at ${backupPath}`);

/**
 * The ₱225-shown / ₱175-paid class, company-wide.
 *
 * The pay engine prorates each day from `employee_rate_history` (newest row with
 * `effective_from <= day` STRICTLY wins) and treats the flat `employee_hourly_rates`
 * sheet cache only as a fallback for dates history doesn't cover. So when a raise
 * lands on the sheet but never gets a history row, the engine keeps paying the OLD
 * rate — silently, because the paystub's own line totals still add up.
 *
 * Nathaniel Rosal was underpaid ₱6,564.25 across three weeks this way, one of which
 * was already emailed and paid. This finds everyone else in the same state.
 *
 * An employee-scope Payment Catalog structure is the fix: it inserts a fresh,
 * actor-authored history row AND makes the pay engine bypass per-day history
 * entirely (`catalogOverride` in current-pay.ts), so pay and the displayed rate can
 * never drift apart again for that person.
 *
 * READ-ONLY by default. Writes ONLY with --apply, and even then only:
 *   - `payment_catalog_pay_structures` (an employee-scope PHP structure)
 *   - `employee_rate_history`          (one dated row, note-tagged)
 * It deliberately does NOT touch the Google rates Sheet and does NOT fire the
 * employee "rate changed" notification — those are the outward-facing side effects
 * of POST /api/payment-catalog/pay-structures, and they are a human's call.
 *
 * Usage:
 *   node scripts/audit-rate-source-divergence.mjs                 # sweep, report only
 *   node scripts/audit-rate-source-divergence.mjs --email a@b.c   # one person
 *   node scripts/audit-rate-source-divergence.mjs --apply --email a@b.c --rate 225 --ot 337.5 --from 2026-07-05
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}
const supabase = createClient(url, key);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : null;
};
const APPLY = argv.includes("--apply");
const ONLY_EMAIL = flag("email");
const NEW_RATE = flag("rate") != null ? Number(flag("rate")) : null;
const NEW_OT = flag("ot") != null ? Number(flag("ot")) : null;
const FROM = flag("from");

const norm = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const peso = (n) =>
  `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Newest history row with effective_from <= asOf. Mirrors resolveRateAsOfDate. */
function resolveAsOf(rows, asOf) {
  const t = new Date(asOf).getTime();
  let best = null;
  for (const r of rows) {
    const eff = new Date(r.effective_from).getTime();
    if (eff <= t && (best == null || eff > new Date(best.effective_from).getTime())) best = r;
  }
  return best;
}

async function pageAll(table, select) {
  const out = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < SIZE) break;
  }
  return out;
}

async function main() {
  console.log("Loading rate history, rate sheet, master list, and catalog structures…\n");

  const [history, rates, master, structures] = await Promise.all([
    pageAll("employee_rate_history", "employee_email, regular_rate, ot_rate, effective_from, note, created_by, created_at"),
    pageAll("employee_hourly_rates", '"Work Email", "Personal Email", "Regular Rate", "OT Rate", "Department", created_at'),
    pageAll("global_master_list", '"Work Email", "Name", "Department", off_boarded_at, "Employement Status", last_seen_upload_id'),
    pageAll("payment_catalog_pay_structures", "scope, employee_email, department_key, regular_rate, ot_rate, currency"),
  ]);

  // Only the CURRENT master upload counts — a stale duplicate row is exactly how a
  // wrong-department rate row gets attached to someone (see master-list-sync-race).
  const { data: mlUploads } = await supabase
    .from("master_list_uploads")
    .select("id, is_current, uploaded_at")
    .eq("is_current", true)
    .limit(1);
  const currentMasterUpload = mlUploads?.[0]?.id ?? null;

  const activeByEmail = new Map();
  for (const m of master) {
    const em = norm(m["Work Email"]);
    if (!em) continue;
    if (m.off_boarded_at) continue;
    if (currentMasterUpload && m.last_seen_upload_id !== currentMasterUpload) continue;
    activeByEmail.set(em, m);
  }

  const histByEmail = new Map();
  for (const h of history) {
    const em = norm(h.employee_email);
    if (!em) continue;
    if (!histByEmail.has(em)) histByEmail.set(em, []);
    histByEmail.get(em).push(h);
  }

  // Sheet rows keyed by work email. Keep ALL rows so duplicates are visible.
  const sheetByEmail = new Map();
  for (const r of rates) {
    const em = norm(r["Work Email"]);
    if (!em) continue;
    if (!sheetByEmail.has(em)) sheetByEmail.set(em, []);
    sheetByEmail.get(em).push(r);
  }

  const catalogEmails = new Set(
    structures.filter((s) => s.scope === "employee").map((s) => norm(s.employee_email)),
  );

  const asOf = FROM || new Date().toISOString().slice(0, 10);
  const findings = [];

  for (const [em, m] of activeByEmail) {
    if (ONLY_EMAIL && em !== norm(ONLY_EMAIL)) continue;
    // An employee-scope catalog structure already bypasses history — immune.
    if (catalogEmails.has(em)) continue;

    const sheetRows = sheetByEmail.get(em) ?? [];
    if (sheetRows.length === 0) continue;
    const hist = histByEmail.get(em) ?? [];
    if (hist.length === 0) continue; // no history ⇒ sheet is used ⇒ consistent

    const resolved = resolveAsOf(hist, asOf);
    if (!resolved) continue;
    const paidReg = numOrNull(resolved.regular_rate);
    if (paidReg == null) continue;

    // Distinct sheet rates on file for this person. More than one ⇒ duplicate rows.
    const sheetRegs = [...new Set(sheetRows.map((r) => numOrNull(r["Regular Rate"])).filter((v) => v != null))];
    const maxSheet = Math.max(...sheetRegs);
    if (!Number.isFinite(maxSheet)) continue;
    if (Math.abs(maxSheet - paidReg) < 0.005) continue; // agree ⇒ fine

    findings.push({
      email: em,
      name: m["Name"] ?? "",
      dept: m["Department"] ?? "",
      paidReg,
      paidOt: numOrNull(resolved.ot_rate),
      sheetRegs,
      maxSheet,
      gapPerHour: Math.round((maxSheet - paidReg) * 100) / 100,
      duplicateSheetRows: sheetRows.length > 1,
      sheetDepts: [...new Set(sheetRows.map((r) => r["Department"]).filter(Boolean))],
      histNote: resolved.note ?? "",
      histFrom: resolved.effective_from,
      histAuthor: resolved.created_by ?? "",
      baselineOnly: hist.every((h) => String(h.effective_from).startsWith("1970")),
    });
  }

  findings.sort((a, b) => b.gapPerHour - a.gapPerHour);

  const underpaid = findings.filter((f) => f.gapPerHour > 0);
  const overpaid = findings.filter((f) => f.gapPerHour < 0);

  console.log(`Active employees checked ........ ${activeByEmail.size}`);
  console.log(`Already immune (catalog struct) .. ${catalogEmails.size}`);
  console.log(`Rate-source DISAGREEMENTS ....... ${findings.length}`);
  console.log(`  paid BELOW sheet (likely owed) . ${underpaid.length}`);
  console.log(`  paid ABOVE sheet ............... ${overpaid.length}`);
  console.log(`Resolved as-of date ............. ${asOf}\n`);

  const show = (list, title) => {
    if (list.length === 0) return;
    console.log(`── ${title} ──`);
    for (const f of list) {
      console.log(
        `${f.name || f.email}  [${f.dept}]\n` +
          `    paid ${peso(f.paidReg)}/h   sheet ${f.sheetRegs.map(peso).join(" | ")}/h   gap ${peso(f.gapPerHour)}/h` +
          `${f.duplicateSheetRows ? `   ⚠ ${f.sheetRegs.length} sheet rows (${f.sheetDepts.join(", ")})` : ""}` +
          `${f.baselineOnly ? "   ⚠ history is 1970-baseline only" : ""}\n` +
          `    history: eff ${String(f.histFrom).slice(0, 10)} by ${f.histAuthor || "?"} — "${f.histNote}"`,
      );
    }
    console.log("");
  };
  show(underpaid, "PAID BELOW THE SHEET RATE — money likely owed");
  show(overpaid, "PAID ABOVE THE SHEET RATE — sheet may be a stale cell; do NOT auto-lower");

  if (!APPLY) {
    console.log("Read-only sweep. Nothing was written.");
    console.log("To fix one person (creates a catalog structure + one dated history row):");
    console.log("  node scripts/audit-rate-source-divergence.mjs --apply \\");
    console.log("       --email someone@simple.biz --rate 225 --ot 337.5 --from 2026-07-05");
    return;
  }

  // ── apply ──
  if (!ONLY_EMAIL || NEW_RATE == null || !FROM) {
    console.error("\n--apply requires --email, --rate and --from (and --ot unless 1.5x is intended).");
    process.exit(1);
  }
  const em = norm(ONLY_EMAIL);
  const ot = NEW_OT != null ? NEW_OT : Math.round(NEW_RATE * 1.5 * 100) / 100;

  console.log(`\n── APPLYING for ${em} ──`);
  console.log(`regular ${peso(NEW_RATE)}/h · ot ${peso(ot)}/h · effective ${FROM}`);

  // Backup first: dump what exists before changing anything.
  const before = {
    history: (histByEmail.get(em) ?? []),
    sheet: (sheetByEmail.get(em) ?? []),
    structures: structures.filter((s) => norm(s.employee_email) === em),
  };
  console.log("\nBEFORE (keep this):");
  console.log(JSON.stringify(before, null, 2));

  const { error: sErr } = await supabase.from("payment_catalog_pay_structures").insert({
    scope: "employee",
    employee_email: em,
    regular_rate: NEW_RATE,
    ot_rate: ot,
    currency: "PHP",
  });
  if (sErr) {
    console.error(`\npayment_catalog_pay_structures insert FAILED: ${sErr.message}`);
    process.exit(1);
  }
  console.log("\n✓ employee-scope Payment Catalog structure created (pay engine now bypasses stale history)");

  const { error: hErr } = await supabase.from("employee_rate_history").insert({
    employee_email: em,
    regular_rate: String(NEW_RATE),
    ot_rate: String(ot),
    effective_from: FROM,
    created_by: "rate-source-divergence fix",
    note: `Corrected: sheet held ${peso(NEW_RATE)} but history paid a stale rate. Effective ${FROM}.`,
  });
  if (hErr) {
    console.error(`\nemployee_rate_history insert FAILED: ${hErr.message}`);
    console.error("The catalog structure WAS created — it alone already corrects pay.");
    process.exit(1);
  }
  console.log("✓ dated employee_rate_history row inserted");
  console.log("\nNOT done (outward-facing, do these deliberately):");
  console.log("  · Google rates Sheet not updated");
  console.log("  · employee 'rate changed' notification not sent");
  console.log("  · re-run the Payroll Wizard calc to re-price unsent staged weeks");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

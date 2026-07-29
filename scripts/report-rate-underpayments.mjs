/**
 * READ-ONLY. The list of people underpaid by the rate-source divergence, in pesos.
 *
 * Same detection as scripts/audit-rate-source-divergence.mjs (the pay engine pays
 * from `employee_rate_history` as-of each day, and a raise that only reached the
 * `employee_hourly_rates` sheet never gets a history row, so the OLD rate keeps
 * paying) — but joined against each person's STAGED paystub for the week so the
 * output is what Nathaniel's looked like:
 *
 *   Rosal, Nathaniel   got ₱7,000.00 regular   should be ₱9,000.00   short ₱2,310.74
 *
 * Usage:
 *   node scripts/report-rate-underpayments.mjs                      # current week
 *   node scripts/report-rate-underpayments.mjs --week 2026-07-19
 *   node scripts/report-rate-underpayments.mjs --csv out.csv
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
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
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const WEEK = flag("week") || "2026-07-19";
const CSV = flag("csv");

const norm = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const num = (v) => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const peso = (n) =>
  n == null
    ? "—"
    : `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (n) => Math.round(n * 100) / 100;

async function pageAll(table, select, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = [];
      const SIZE = 1000;
      for (let from = 0; ; from += SIZE) {
        const { data, error } = await supabase.from(table).select(select).range(from, from + SIZE - 1);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if (!data || data.length < SIZE) break;
      }
      return out;
    } catch (e) {
      if (attempt >= tries) throw new Error(`${table}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

function resolveAsOf(rows, asOf) {
  const t = new Date(asOf).getTime();
  let best = null;
  for (const r of rows) {
    const eff = new Date(r.effective_from).getTime();
    if (eff <= t && (best == null || eff > new Date(best.effective_from).getTime())) best = r;
  }
  return best;
}

async function main() {
  const [history, rates, master, structures, queue, uploads] = await Promise.all([
    pageAll("employee_rate_history", "employee_email, regular_rate, ot_rate, effective_from, note, created_by"),
    pageAll("employee_hourly_rates", '"Work Email", "Regular Rate", "OT Rate", "Department"'),
    pageAll("global_master_list", '"Work Email", "Name", "Department", off_boarded_at, last_seen_upload_id'),
    pageAll("payment_catalog_pay_structures", "scope, employee_email"),
    pageAll("paystub_dispatch_queue", "recipient_email, payload, pay_period, amount_php, sent_at, send_count, excluded"),
    pageAll("master_list_uploads", "id, is_current"),
  ]);

  const currentUpload = uploads.find((u) => u.is_current)?.id ?? null;

  const activeByEmail = new Map();
  for (const m of master) {
    const em = norm(m["Work Email"]);
    if (!em || m.off_boarded_at) continue;
    if (currentUpload && m.last_seen_upload_id !== currentUpload) continue;
    activeByEmail.set(em, m);
  }

  const histBy = new Map();
  for (const h of history) {
    const em = norm(h.employee_email);
    if (!em) continue;
    if (!histBy.has(em)) histBy.set(em, []);
    histBy.get(em).push(h);
  }

  const sheetBy = new Map();
  for (const r of rates) {
    const em = norm(r["Work Email"]);
    if (!em) continue;
    if (!sheetBy.has(em)) sheetBy.set(em, []);
    sheetBy.get(em).push(r);
  }

  const immune = new Set(structures.filter((s) => s.scope === "employee").map((s) => norm(s.employee_email)));

  // Staged paystub for the requested week, keyed by recipient.
  const stagedBy = new Map();
  for (const q of queue) {
    const wk = q.payload?.pay_period?.week?.start ?? q.pay_period?.week?.start ?? null;
    if (wk !== WEEK) continue;
    const em = norm(q.recipient_email);
    if (!em) continue;
    // Prefer the row with the larger final (the daily_report batch beats a partial
    // api_sync duplicate — see hubstaff-double-ingest-duplicate-batch).
    const prev = stagedBy.get(em);
    if (!prev || (q.payload?.pay_php?.final ?? 0) > (prev.payload?.pay_php?.final ?? 0)) {
      stagedBy.set(em, q);
    }
  }

  const rows = [];
  for (const [em, m] of activeByEmail) {
    if (immune.has(em)) continue;
    const sheetRows = sheetBy.get(em) ?? [];
    const hist = histBy.get(em) ?? [];
    if (!sheetRows.length || !hist.length) continue;

    const resolved = resolveAsOf(hist, WEEK);
    const paidReg = num(resolved?.regular_rate);
    if (paidReg == null) continue;

    const sheetRegs = [...new Set(sheetRows.map((r) => num(r["Regular Rate"])).filter((v) => v != null))];
    const correctReg = Math.max(...sheetRegs);
    if (!Number.isFinite(correctReg)) continue;
    if (correctReg - paidReg < 0.005) continue; // not underpaid

    const sheetOts = sheetRows.map((r) => num(r["OT Rate"])).filter((v) => v != null);
    const correctOt = sheetOts.length ? Math.max(...sheetOts) : r2(correctReg * 1.5);
    const paidOt = num(resolved?.ot_rate) ?? r2(paidReg * 1.5);

    const staged = stagedBy.get(em);
    const h = staged?.payload?.hours ?? null;
    const p = staged?.payload?.pay_php ?? null;
    const regH = num(h?.regular);
    const otH = num(h?.ot);
    const gotReg = num(p?.regular);
    const gotOt = num(p?.ot);

    const shouldReg = regH != null ? r2(regH * correctReg) : null;
    const shouldOt = otH != null ? r2(otH * correctOt) : null;
    const shortfall =
      shouldReg != null && gotReg != null
        ? r2(shouldReg - gotReg + ((shouldOt ?? 0) - (gotOt ?? 0)))
        : null;

    rows.push({
      name: m["Name"] ?? em,
      email: em,
      dept: m["Department"] ?? "",
      paidReg,
      correctReg,
      gapPerHour: r2(correctReg - paidReg),
      regH,
      otH,
      gotReg,
      shouldReg,
      gotOt,
      shouldOt,
      shortfall,
      staged: !!staged,
      sent: !!staged?.sent_at,
      stagedFinal: num(staged?.payload?.pay_php?.final),
      histSig: `${String(resolved?.effective_from).slice(0, 10)} / ${resolved?.created_by ?? "?"}`,
      dupSheetRows: sheetRows.length > 1,
      sheetDepts: [...new Set(sheetRows.map((r) => r["Department"]).filter(Boolean))].join(", "),
    });
  }

  // Biggest money first; unstaged (no hours this week) last.
  rows.sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1));

  console.log(`\nUNDERPAID BY THE RATE-SOURCE BUG — pay week starting ${WEEK}\n`);
  console.log(
    `${"#".padStart(3)} ${"NAME".padEnd(34)} ${"DEPT".padEnd(12)} ${"RATE".padEnd(19)} ${"REG PAY: GOT -> SHOULD".padEnd(30)} SHORT`,
  );
  console.log("-".repeat(122));
  let i = 0;
  let totalShort = 0;
  let withHours = 0;
  for (const r of rows) {
    i += 1;
    const rate = `${peso(r.paidReg)}->${peso(r.correctReg)}`;
    const regPay =
      r.gotReg != null && r.shouldReg != null ? `${peso(r.gotReg)} -> ${peso(r.shouldReg)}` : "(no hours this week)";
    const short = r.shortfall != null ? peso(r.shortfall) : "—";
    if (r.shortfall != null) {
      totalShort += r.shortfall;
      withHours += 1;
    }
    console.log(
      `${String(i).padStart(3)} ${String(r.name).slice(0, 34).padEnd(34)} ${String(r.dept).slice(0, 12).padEnd(12)} ${rate.padEnd(19)} ${regPay.padEnd(30)} ${short}${r.sent ? "  [ALREADY SENT]" : ""}`,
    );
  }
  console.log("-".repeat(122));
  console.log(`\n${rows.length} underpaid employees · ${withHours} worked this week`);
  console.log(`TOTAL SHORT for week ${WEEK}: ${peso(r2(totalShort))}`);
  const alreadySent = rows.filter((r) => r.sent);
  if (alreadySent.length) {
    console.log(`\n⚠ ${alreadySent.length} of these paystubs were ALREADY EMAILED for this week:`);
    for (const r of alreadySent) console.log(`   ${r.name} — short ${peso(r.shortfall)}`);
  }
  const noHours = rows.filter((r) => r.shortfall == null);
  if (noHours.length) {
    console.log(
      `\n${noHours.length} underpaid on rate but no staged hours for ${WEEK} (still need the rate fixed):`,
    );
    for (const r of noHours) console.log(`   ${r.name} [${r.dept}] ${peso(r.paidReg)} -> ${peso(r.correctReg)}`);
  }

  if (CSV) {
    const head = [
      "name", "email", "department", "paid_rate", "correct_rate", "gap_per_hour",
      "regular_hours", "ot_hours", "got_regular_pay", "should_regular_pay",
      "got_ot_pay", "should_ot_pay", "shortfall_php", "already_sent",
      "staged_final", "history_signature", "duplicate_sheet_rows", "sheet_departments",
    ];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name, r.email, r.dept, r.paidReg, r.correctReg, r.gapPerHour,
          r.regH, r.otH, r.gotReg, r.shouldReg, r.gotOt, r.shouldOt, r.shortfall,
          r.sent ? "YES" : "", r.stagedFinal, r.histSig, r.dupSheetRows ? "YES" : "", r.sheetDepts,
        ].map(esc).join(","),
      );
    }
    writeFileSync(CSV, lines.join("\n"), "utf8");
    console.log(`\nCSV written: ${CSV}`);
  }
  console.log("\nRead-only. Nothing was written.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

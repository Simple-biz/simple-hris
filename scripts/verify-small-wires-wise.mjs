/**
 * Preview which wires-routed people go out via WISE this week under the
 * sub-₱7,000 rule (owner rule, 2026-07-29): a wires person whose pay for the
 * week is UNDER ₱7,000 is paid through Wise that week; the first week at
 * ₱7,000+ they're back on Wires. Nothing is persisted — Payment Dispatch
 * recomputes the flip from each week's amount.
 *
 *   node scripts/verify-small-wires-wise.mjs             # live is_current week
 *   node scripts/verify-small-wires-wise.mjs --file=Simple_..._2026-07-19_to_2026-07-25.csv
 *
 * READ-ONLY. Mirrors the app exactly:
 *   - population + weekly amount = paystub_dispatch_queue (the wizard-locked
 *     staging PD itself treats as authoritative; excluded rows are skipped —
 *     they only surface via the arrears rollup, whose cumulative totals this
 *     preview does not recompute)
 *   - routing precedence = employee_ids.bank_preferred → preferred_processor →
 *     legacy employee_hourly_rates."Bank Preferred" (mock-queue.ts)
 *   - threshold = strictly under ₱7,000 on the PHP amount, zero/null exempt
 *     (SMALL_WIRES_WISE_THRESHOLD_PHP in mock-queue.ts)
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const THRESHOLD_PHP = 7000;
const KNOWN = new Set(["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"]);

/** Mirrors processorIdFromBankPreferred in mock-queue.ts. */
function processorFromLegacy(raw) {
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

/** Retry transport flakes — `TypeError: fetch failed` is a real one against this project. */
async function withRetry(label, run) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await run();
      if (!res.error) return res;
      last = new Error(`${label}: ${res.error.message}`);
      if (!/fetch failed|522|timeout/i.test(res.error.message)) throw last;
    } catch (e) {
      last = e;
      if (!/fetch failed|522|timeout/i.test(String(e?.message ?? e))) throw e;
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw last;
}

const norm = (e) => (e ?? "").trim().toLowerCase();
const php = (n) =>
  "₱" + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="))?.slice(7) ?? null;

  let sourceFile = fileArg;
  if (!sourceFile) {
    const { data } = await withRetry("hubstaff_uploads", () =>
      supabase
        .from("hubstaff_uploads")
        .select("source_file")
        .eq("is_current", true)
        .limit(1)
        .maybeSingle(),
    );
    sourceFile = data?.source_file ?? null;
  }
  if (!sourceFile) {
    console.error("No is_current Hubstaff upload found — pass --file=<source_file>.");
    process.exit(1);
  }
  console.log(`Pay week: ${sourceFile}\n`);

  const [stagedRes, idsRes, ratesRes, paidRes] = await Promise.all([
    withRetry("paystub_dispatch_queue", () =>
      supabase
        .from("paystub_dispatch_queue")
        .select("recipient_email, personal_email, recipient_name, amount_php, excluded")
        .eq("cycle_source_file", sourceFile),
    ),
    withRetry("employee_ids", () =>
      supabase
        .from("employee_ids")
        .select("work_email, personal_email, bank_preferred, preferred_processor"),
    ),
    withRetry("employee_hourly_rates", () =>
      supabase.from("employee_hourly_rates").select('"Work Email", "Personal Email", "Bank Preferred"'),
    ),
    withRetry("payment_dispatches", () =>
      supabase
        .from("payment_dispatches")
        .select("recipient_email, status, payee_type")
        .eq("cycle_source_file", sourceFile),
    ),
  ]);

  if (!stagedRes.data?.length) {
    console.log("No staged rows for this week — the wizard hasn't locked it yet. Nothing to preview.");
    return;
  }

  // Routing lookups, both emails indexed, work email winning on collisions.
  const chosen = new Map(); // email → employee_ids pick (bank_preferred > preferred_processor)
  for (const r of idsRes.data ?? []) {
    const bp = norm(r.bank_preferred);
    const pp = norm(r.preferred_processor);
    const pick = (KNOWN.has(bp) ? bp : null) ?? (KNOWN.has(pp) ? pp : null);
    if (!pick) continue;
    const we = norm(r.work_email);
    const pe = norm(r.personal_email);
    if (we) chosen.set(we, pick);
    if (pe && !chosen.has(pe)) chosen.set(pe, pick);
  }
  const legacy = new Map(); // email → legacy rates-cell processor
  for (const r of ratesRes.data ?? []) {
    const p = processorFromLegacy(r["Bank Preferred"]);
    if (!p) continue;
    const we = norm(r["Work Email"]);
    const pe = norm(r["Personal Email"]);
    if (we && !legacy.has(we)) legacy.set(we, p);
    if (pe && !legacy.has(pe)) legacy.set(pe, p);
  }
  // Emails whose turn is over this cycle (paid or problem-flagged, employees only).
  const settled = new Set(
    (paidRes.data ?? [])
      .filter((d) => (d.status === "paid" || d.status === "problem") && (d.payee_type ?? "employee") !== "contractor")
      .map((d) => norm(d.recipient_email)),
  );

  const toWise = [];
  let wiresStaying = 0;
  let wiresZero = 0;
  for (const s of stagedRes.data) {
    if (s.excluded) continue; // held people settle via the arrears path, not this preview
    const email = norm(s.recipient_email);
    const proc =
      chosen.get(email) ??
      chosen.get(norm(s.personal_email)) ??
      legacy.get(email) ??
      legacy.get(norm(s.personal_email));
    if (proc !== "wires") continue;
    const amt = typeof s.amount_php === "string" ? parseFloat(s.amount_php) : s.amount_php;
    if (amt == null || !Number.isFinite(amt) || amt <= 0) {
      wiresZero += 1;
      continue;
    }
    if (amt < THRESHOLD_PHP) {
      toWise.push({ name: s.recipient_name ?? email, email: s.recipient_email, amt, settled: settled.has(email) });
    } else {
      wiresStaying += 1;
    }
  }

  toWise.sort((a, b) => a.amt - b.amt);
  console.log(`WIRES → WISE this week (under ${php(THRESHOLD_PHP)}): ${toWise.length} people`);
  for (const p of toWise) {
    console.log(
      `  ${php(p.amt).padStart(12)}  ${p.name}  <${p.email}>${p.settled ? "  [already settled this cycle]" : ""}`,
    );
  }
  const wiseTotal = toWise.reduce((s, p) => s + p.amt, 0);
  console.log(`  ── total via Wise: ${php(wiseTotal)}`);
  console.log(`\nStaying on Wires (≥ ${php(THRESHOLD_PHP)}): ${wiresStaying} people`);
  if (wiresZero > 0) {
    console.log(`Wires people with no/zero staged amount (never rerouted): ${wiresZero}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

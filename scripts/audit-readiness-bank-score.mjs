/**
 * READ-ONLY audit: reproduce the Payroll Readiness "Bank info" dimension and its
 * score component EXACTLY as app/api/payroll-wizard/readiness computes them
 * (src/lib/payroll/payroll-readiness.ts buildMissingRates/buildMissingBank +
 * readiness-score.ts, incl. the 2026-07-25 on-payroll blocker split), so the
 * dashboard numbers can be reconciled against the raw tables.
 *
 * Prints:
 *   - the eligible denominator (active, on-channel, non-excepted, deduped)
 *   - the missing-bank count + WHY each person is missing, per processor
 *   - the ON-THIS-WEEK'S-PAYROLL blocker count (alias-expanded, like the server)
 *   - the score reconstruction (bank points/percent, headline arithmetic)
 *   - spot-checks: sample blockers (hours present? really unpayable?) and
 *     sample payable people on payroll (correctly NOT flagged?)
 *
 * Usage: node scripts/audit-readiness-bank-score.mjs
 * LOCAL-ONLY diagnostic - not meant to be committed.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAll(table, select = "*", filter = null) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let data = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
      if (filter) q = filter(q);
      const res = await q;
      if (!res.error) { data = res.data; lastErr = null; break; }
      lastErr = res.error;
      await sleep(500 * (attempt + 1));
    }
    if (lastErr) throw new Error(`${table}: ${lastErr.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── mirrors of src/lib/employee-payment-processors.ts ───────────────────────
const PROCESSOR_IDS = ["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"];
const isProcessorId = (v) => PROCESSOR_IDS.includes(v);
function processorIdFromBankPreferredText(raw) {
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

// ── mirrors of src/lib/employee/payout-completeness.ts ──────────────────────
function pick(row, ...keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}
function resolveEffectivePayoutProcessor(row, extras) {
  const bankPreferred = row ? processorIdFromBankPreferredText(pick(row, "bank_preferred")) : null;
  if (bankPreferred) return bankPreferred;
  const disbursement = row ? pick(row, "preferred_processor").toLowerCase() : "";
  if (isProcessorId(disbursement)) return disbursement;
  return processorIdFromBankPreferredText(extras?.bankPreferredRaw);
}
function whyIncomplete(row, extras) {
  // Returns null when payable, else a reason string. Mirrors isPayoutComplete.
  const processor = resolveEffectivePayoutProcessor(row, extras);
  if (!processor) return row ? "no processor resolvable" : "no employee_ids row + no processor";
  const hasWireDetails =
    !!(pick(row ?? {}, "bank_name") || pick(row ?? {}, "alt_bank_name")) &&
    !!(pick(row ?? {}, "account_number") || pick(row ?? {}, "alt_account_number"));
  switch (processor) {
    case "hurupay":
      return pick(row ?? {}, "hurupay_email") || (extras?.hurupayEmail ?? "").trim()
        ? null
        : "hurupay: no wallet email";
    case "wepay":
      return pick(row ?? {}, "wepay_email") ? null : "wepay: no wallet email";
    case "higlobe": {
      const email = pick(row ?? {}, "higlobe_email") || (extras?.higlobeEmail ?? "").trim();
      const name = pick(row ?? {}, "higlobe_account_name") || (extras?.higlobeAccountName ?? "").trim();
      return email && name ? null : `higlobe: missing ${!email ? "email" : ""}${!email && !name ? "+" : ""}${!name ? "account name" : ""}`;
    }
    case "wise":
      return pick(row ?? {}, "wise_email") || pick(row ?? {}, "wise_tag") || hasWireDetails
        ? null
        : "wise: no handle and no wire details";
    case "jeeves":
    case "wires":
      return hasWireDetails ? null : `${processor}: incomplete wire details`;
    default:
      return "unknown processor";
  }
}

// ── load everything the endpoint loads ──────────────────────────────────────
const employees = await fetchAll(
  "active_employees",
  'Department,Name,"Personal Email","Work Email","Alternate Work Email","Alternate Work Email 2"',
);
// Mirror getEmployeeIds(): ordered by employee_id, rows without an
// employee_id or name dropped (junk rows must not shadow a person's real row
// in the email map).
const ids = (await fetchAll("employee_ids", "*", (q) => q.order("employee_id"))).filter(
  (r) => r.employee_id && r.name,
);
const uploads = await fetchAll("hubstaff_uploads", "source_file, uploaded_at, is_current");
const pendingRows = await fetchAll("hr_pending_employees").catch((e) => {
  console.warn("hr_pending_employees unavailable:", e.message);
  return [];
});

// The rates view/table carries RAW SHEET headers ("Work Email", "Bank
// Preferred", "HuruPay Email Account", …) which the app normalizes through
// mapEmployeeHourlyRateRow. Reading snake_case fields directly returns
// nothing — that bug made this script over-flag 33 payable people (225 vs the
// endpoint's correct 192) on 2026-07-25. Mirror the mapping tolerantly:
// normalize keys to lowercase alphanumerics and look up canonical names.
// NOTE: scripts/verify-readiness.mts runs the REAL getPayrollReadiness and is
// the authoritative check; this replica exists for independent re-derivation.
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, "");
function mapRatesRow(raw) {
  const byKey = new Map();
  for (const k of Object.keys(raw)) {
    const nk = normKey(k);
    if (!byKey.has(nk)) byKey.set(nk, raw[k]);
  }
  const get = (...names) => {
    for (const n of names) {
      const v = byKey.get(n);
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
  };
  return {
    work_email: get("workemail"),
    personal_email: get("personalemail"),
    bank_preferred: get("bankpreferred"),
    hurupay_email: get("hurupayemail", "hurupayemailaccount"),
    higlobe_email: get("higlobeemail"),
    higlobe_account_name: get("higlobeaccountname"),
  };
}
let rates = [];
try {
  rates = (await fetchAll("employee_hourly_rates_current")).map(mapRatesRow);
} catch {
  try {
    rates = (await fetchAll("employee_hourly_rates")).map(mapRatesRow);
  } catch (e) {
    console.warn("legacy rates unavailable (endpoint would judge WITHOUT extras):", e.message);
  }
}

const current = uploads.find((u) => u.is_current) ?? null;
console.log(`current upload: ${current?.source_file ?? "(none)"}`);

// week start = first ISO date in the filename (weekKeyFromSourceFile)
const weekStart = (() => {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(current?.source_file ?? "");
  return m ? m[1] : null;
})();
const weekEnd = (() => {
  if (!weekStart) return null;
  const [y, mo, d] = weekStart.split("-").map(Number);
  const e = new Date(y, mo - 1, d + 6);
  return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
})();
console.log(`week: ${weekStart} .. ${weekEnd}`);

// paused departments for this week (Configuration tab)
let pausedKeys = new Set();
if (current?.source_file) {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", `payroll.wizard.dept_pay_paused.${current.source_file}`)
      .maybeSingle();
    const arr = data?.value ? JSON.parse(data.value) : [];
    if (Array.isArray(arr)) pausedKeys = new Set(arr.filter((k) => typeof k === "string"));
  } catch {}
}
console.log(`paused dept keys this week: ${pausedKeys.size ? [...pausedKeys].join(", ") : "(none)"}`);

// onboarding-exception identity set + the exceptions LIST count (mirrors
// buildExceptions: no_show / pending_work_email / ready / failed_to_promote
// always; promoted only when started inside the week)
const exceptionIdentities = new Set();
const remember = (r) => {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (em) exceptionIdentities.add(em);
  }
  const n = (r.name ?? "").trim().toLowerCase();
  if (n) exceptionIdentities.add(`name:${n}`);
};
let exceptionListCount = 0;
for (const r of pendingRows) {
  if (r.status === "no_show") { remember(r); exceptionListCount++; continue; }
  if (r.status === "pending_work_email" || r.status === "ready" || r.status === "failed_to_promote") {
    remember(r);
    exceptionListCount++;
    continue;
  }
  if (r.status === "promoted") {
    const startIso =
      (r.orientation_attended_at ? String(r.orientation_attended_at).slice(0, 10) : null) ??
      r.start_date ??
      (r.promoted_at ? String(r.promoted_at).slice(0, 10) : null);
    if (weekStart && startIso && startIso >= weekStart && (!weekEnd || startIso <= weekEnd)) {
      remember(r);
      exceptionListCount++;
    }
  }
}
console.log(`exceptions list (UI "Exceptions" tile): ${exceptionListCount} · identity keys: ${exceptionIdentities.size}`);

const isOffChannelDept = (dept) => {
  const d = norm(dept);
  return d === "usee" || d === "us employees" || d === "us employee";
};
const deptSlug = (dept) => norm(dept).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const isPausedDept = (dept) => pausedKeys.size > 0 && pausedKeys.has(deptSlug(dept));

// ── alias map from the master roster (mirrors buildMissingRates lines) ──────
// work→personal→alt→alt2: every alias maps to the person's FULL alias list.
const aliasesByEmail = new Map();
for (const e of employees) {
  const aliases = [e["Work Email"], e["Personal Email"], e["Alternate Work Email"], e["Alternate Work Email 2"]]
    .map((a) => norm(a))
    .filter(Boolean);
  for (const a of aliases) {
    if (!aliasesByEmail.has(a)) aliasesByEmail.set(a, aliases);
  }
}

// ── payrollEmails: everyone with hours in the week's file, alias-expanded ───
// (mirrors the new buildMissingRates payrollEmails: dedupe by email||name,
// then add the row email + every master alias, BEFORE any exclusions)
let hubRows = [];
if (current?.source_file) {
  hubRows = await fetchAll("hubstaff_hours", "*", (q) => q.eq("source_file", current.source_file));
}
const emailCol = hubRows.length
  ? ["Email", "email", "work_email", "member_email"].find((c) => c in hubRows[0])
  : null;
const nameCol = hubRows.length ? ["Name", "name", "Member", "member"].find((c) => c in hubRows[0]) : null;
const payrollEmails = new Set();
{
  const seenW = new Set();
  for (const r of hubRows) {
    const email = norm(emailCol ? r[emailCol] : "");
    const name = String((nameCol ? r[nameCol] : "") ?? "").trim() || email;
    const key = email || name.toLowerCase();
    if (!key || seenW.has(key)) continue;
    seenW.add(key);
    const aliases = (email && aliasesByEmail.get(email)) || (email ? [email] : []);
    if (email) payrollEmails.add(email);
    for (const a of aliases) payrollEmails.add(a);
  }
  console.log(`hubstaff rows: ${hubRows.length} · distinct workers: ${seenW.size} · payrollEmails (alias-expanded): ${payrollEmails.size}`);
}

// employee_ids keyed by every email it carries
const idRowByEmail = new Map();
for (const r of ids) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (em) idRowByEmail.set(em, r);
  }
}
// legacy rates keyed by both emails
const ratesByEmail = new Map();
for (const r of rates) {
  const w = norm(r.work_email);
  const p = norm(r.personal_email);
  if (w) ratesByEmail.set(w, r);
  if (p) ratesByEmail.set(p, r);
}

// ── the buildMissingBank replica (+ the endpoint's onPayroll stamp) ─────────
const seen = new Set();
let eligibleCount = 0;
let skippedOffChannel = 0, skippedPaused = 0, skippedException = 0, skippedNoKey = 0, skippedDupe = 0;
const missing = [];
const payableOnPayroll = []; // for the negative spot-check
for (const e of employees) {
  const dept = e["Department"];
  const name = e["Name"];
  const w = norm(e["Work Email"]);
  const p = norm(e["Personal Email"]);
  const n = (name ?? "").trim().toLowerCase();
  if (isOffChannelDept(dept)) { skippedOffChannel++; continue; }
  if (isPausedDept(dept)) { skippedPaused++; continue; }
  const excluded =
    (w && exceptionIdentities.has(w)) || (p && exceptionIdentities.has(p)) || (n && exceptionIdentities.has(`name:${n}`));
  if (excluded) { skippedException++; continue; }
  const base = w || p || n;
  if (!base) { skippedNoKey++; continue; }
  const idKey = `${base}|${n}`;
  if (seen.has(idKey)) { skippedDupe++; continue; }
  seen.add(idKey);
  eligibleCount++;

  const idRow = (w && idRowByEmail.get(w)) || (p && idRowByEmail.get(p)) || null;
  const legacy = (w && ratesByEmail.get(w)) || (p && ratesByEmail.get(p)) || null;
  const extras = legacy
    ? {
        bankPreferredRaw: legacy.bank_preferred,
        hurupayEmail: legacy.hurupay_email,
        higlobeEmail: legacy.higlobe_email,
        higlobeAccountName: legacy.higlobe_account_name,
      }
    : undefined;
  const onPayroll = (!!w && payrollEmails.has(w)) || (!!p && payrollEmails.has(p));
  const reason = whyIncomplete(idRow, extras);
  if (reason) {
    missing.push({ name, dept, email: w || p, w, p, reason, hasIdRow: !!idRow, onPayroll });
  } else if (onPayroll && payableOnPayroll.length < 5) {
    payableOnPayroll.push({ name, dept, email: w || p, processor: resolveEffectivePayoutProcessor(idRow, extras) });
  }
}

const blockers = missing.filter((m) => m.onPayroll);
console.log("\n== bank dimension (exact endpoint replica) ==");
console.log(`active roster rows:        ${employees.length}`);
console.log(`  skipped off-channel:     ${skippedOffChannel}`);
console.log(`  skipped paused dept:     ${skippedPaused}`);
console.log(`  skipped onboarding-exc:  ${skippedException}`);
console.log(`  skipped no identity key: ${skippedNoKey}`);
console.log(`  skipped duplicate:       ${skippedDupe}`);
console.log(`eligibleCount (denominator):  ${eligibleCount}`);
console.log(`missingBank (UI tile/tab):    ${missing.length}`);
console.log(`missingBankOnPayroll (UI):    ${blockers.length}`);

const byReason = new Map();
for (const m of missing) byReason.set(m.reason, (byReason.get(m.reason) ?? 0) + 1);
console.log("\nmissing by reason (blockers in [brackets]):");
for (const [r, c] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  const b = missing.filter((m) => m.reason === r && m.onPayroll).length;
  console.log(`  ${String(c).padStart(4)} [${String(b).padStart(3)}]  ${r}`);
}

const byDept = new Map();
for (const m of blockers) byDept.set(m.dept ?? "(none)", (byDept.get(m.dept ?? "(none)") ?? 0) + 1);
console.log("\nON-PAYROLL blockers by department:");
for (const [d, c] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${d}`);
}

// ── score reconstruction (readiness-score.ts replica) ───────────────────────
const cov = eligibleCount <= 0 ? 1 : Math.max(0, Math.min(1, 1 - missing.length / eligibleCount));
const bankPoints = blockers.length > 0 ? 5 : missing.length === 0 ? 25 : Math.min(25, Math.floor(cov * 25));
const bankPercent = missing.length === 0 ? 100 : Math.min(99, Math.floor(cov * 100));
console.log("\n== score reconstruction ==");
console.log(`bank coverage: ${(cov * 100).toFixed(2)}% -> tile percent ${bankPercent}% · bank points ${bankPoints}/25${blockers.length ? " (PINNED: blockers on payroll)" : ""}`);
console.log(`headline = rate + kpi + ${bankPoints}. With rate 50/50 and kpi 24/25 (per the UI): ${50 + 24 + bankPoints}/100`);

// ── spot-checks ──────────────────────────────────────────────────────────────
// Positive: 5 sample blockers — show their Hubstaff presence + payout row state.
console.log("\n== spot-check: 5 flagged 'Paying this week' blockers ==");
const hoursCols = hubRows.length
  ? Object.keys(hubRows[0]).filter((c) => /^(mon|tue|wed|thu|fri|sat|sun)/i.test(c) || /total|hours|time/i.test(c))
  : [];
for (const m of blockers.slice(0, 5)) {
  const hub = hubRows.filter((r) => {
    const em = norm(emailCol ? r[emailCol] : "");
    if (!em) return false;
    const aliases = aliasesByEmail.get(m.w || m.p) ?? [m.w, m.p].filter(Boolean);
    return em === m.w || em === m.p || aliases.includes(em);
  });
  const sample = hub[0];
  const hoursBits = sample
    ? hoursCols.slice(0, 9).map((c) => `${c}=${sample[c] ?? ""}`).filter((s) => !s.endsWith("=")).join(" ")
    : "(no hubstaff row matched?!)";
  console.log(`  - ${m.name} [${m.dept}] · ${m.reason}`);
  console.log(`      hubstaff: ${hub.length} row(s) ${hoursBits}`);
}

// Negative: 5 payable people on payroll — confirm they are NOT flagged.
console.log("\n== spot-check: payable people on this week's payroll (must NOT be flagged) ==");
for (const s of payableOnPayroll) {
  console.log(`  - ${s.name} [${s.dept}] -> processor ${s.processor} · correctly not in the missing list`);
}

// ── Orphan Ministry probe (Kane: "why doesn't it come up in there?") ─────────
console.log("\n== Orphan Ministry ==");
const orphanRoster = employees.filter((e) => /orphan/i.test(String(e["Department"] ?? "")));
const orphanLabels = new Map();
for (const e of orphanRoster) {
  const d = String(e["Department"]).trim();
  orphanLabels.set(d, (orphanLabels.get(d) ?? 0) + 1);
}
console.log(
  `active roster members: ${orphanRoster.length}${
    orphanLabels.size ? " (" + [...orphanLabels.entries()].map(([d, c]) => `${d}: ${c}`).join(", ") + ")" : ""
  }`,
);
const orphanOnPayroll = orphanRoster.filter((e) => {
  const w = norm(e["Work Email"]);
  const p = norm(e["Personal Email"]);
  return (!!w && payrollEmails.has(w)) || (!!p && payrollEmails.has(p));
});
console.log(`with hours in this week's Hubstaff file: ${orphanOnPayroll.length}`);
const orphanMissing = missing.filter((m) => /orphan/i.test(String(m.dept ?? "")));
console.log(`in the missing-bank list: ${orphanMissing.length} (blockers: ${orphanMissing.filter((m) => m.onPayroll).length})`);
for (const m of orphanMissing.slice(0, 10)) {
  console.log(`   - ${m.name} · ${m.reason}${m.onPayroll ? " · ON PAYROLL" : ""}`);
}
// KPI-list membership: built-ins + HSL are code-side (checked: no orphan key);
// the only data-side source is the Payment Catalog department registry.
try {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "payment_catalog.departments.registry")
    .maybeSingle();
  const reg = data?.value ? JSON.parse(data.value) : [];
  const entries = Array.isArray(reg) ? reg : [];
  const orphanReg = entries.filter((e) => /orphan/i.test(String(e?.name ?? "") + String(e?.key ?? "")));
  console.log(
    `department registry entries: ${entries.length}${
      entries.length ? " (" + entries.map((e) => e?.key).join(", ") + ")" : ""
    } · orphan-ish: ${orphanReg.length}`,
  );
} catch (e) {
  console.log(`department registry unreadable: ${e.message}`);
}

// ── screenshot comparison ────────────────────────────────────────────────────
console.log("\n== compare to the dashboard screenshot ==");
console.log(`  UI missing bank 192  vs replica ${missing.length}`);
console.log(`  UI on payroll  126   vs replica ${blockers.length}`);
console.log(`  UI bank percent 82%  vs replica ${bankPercent}%`);
console.log(`  UI exceptions   162  vs replica ${exceptionListCount}`);
console.log(`  UI score 79 = 50(rate) + 24(kpi 24/25) + 5(bank pinned) -> ${50 + 24 + 5}`);

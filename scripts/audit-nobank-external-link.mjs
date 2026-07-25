/**
 * READ-ONLY audit: does anyone on the Payroll Readiness "No Bank Info" list
 * actually HAVE bank info they set via the external link (or HRIS) that the
 * readiness lookup simply cannot see?
 *
 * Recomputes the missing-bank list EXACTLY like buildMissingBank (same replica
 * logic as scripts/audit-readiness-bank-score.mjs, which reconciled 1:1 with
 * the endpoint on 2026-07-25), then for each flagged person cross-examines:
 *   1. ALL employee_ids rows reachable via ANY of their roster emails
 *      (work / personal / alt / alt2) — including rows the readiness map drops
 *      (null employee_id or null name) and rows shadowed by same-email dupes.
 *   2. bank_update_history        — the non-clearable external-link save log.
 *   3. audit_log                  — action = 'bank_update.saved'.
 *   4. bank_last_self_updated_at  — the self-service stamp on any of their rows.
 *   5. SELF-… employee_id rows    — external-link bootstrap rows.
 *   6. bank_preferred_change_requests (pending) — submitted but awaiting approval.
 *
 * Verdicts per flagged person:
 *   MISREAD             — a payable row EXISTS but readiness can't see it (bug)
 *   SUBMITTED-INCOMPLETE — external-link/HRIS evidence, but data genuinely
 *                          incomplete for the resolved processor (correctly listed)
 *   PENDING-APPROVAL    — bank_preferred change sitting in the approval queue
 *   NO-SUBMISSION       — no evidence anywhere (correctly listed)
 *
 * Usage: node scripts/audit-nobank-external-link.mjs
 * LOCAL-ONLY diagnostic — not meant to be committed.
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
// FULL table for the audit (no filter, keep bank_last_self_updated_at + pk id)
const idsAll = await fetchAll("employee_ids", "*", (q) => q.order("employee_id"));
// Readiness view of the same rows (mirrors getEmployeeIds)
const ids = idsAll.filter((r) => r.employee_id && r.name);
const pendingRows = await fetchAll("hr_pending_employees").catch(() => []);
const uploads = await fetchAll("hubstaff_uploads", "source_file, uploaded_at, is_current");

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
  } catch {}
}

const current = uploads.find((u) => u.is_current) ?? null;
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

const exceptionIdentities = new Set();
const remember = (r) => {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (em) exceptionIdentities.add(em);
  }
  const n = (r.name ?? "").trim().toLowerCase();
  if (n) exceptionIdentities.add(`name:${n}`);
};
for (const r of pendingRows) {
  if (r.status === "no_show" || r.status === "pending_work_email" || r.status === "ready" || r.status === "failed_to_promote") {
    remember(r);
    continue;
  }
  if (r.status === "promoted") {
    const startIso =
      (r.orientation_attended_at ? String(r.orientation_attended_at).slice(0, 10) : null) ??
      r.start_date ??
      (r.promoted_at ? String(r.promoted_at).slice(0, 10) : null);
    if (weekStart && startIso && startIso >= weekStart && (!weekEnd || startIso <= weekEnd)) remember(r);
  }
}

const isOffChannelDept = (dept) => {
  const d = norm(dept);
  return d === "usee" || d === "us employees" || d === "us employee";
};
const deptSlug = (dept) => norm(dept).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const isPausedDept = (dept) => pausedKeys.size > 0 && pausedKeys.has(deptSlug(dept));

// hubstaff on-payroll set (alias-expanded)
const aliasesByEmail = new Map();
for (const e of employees) {
  const aliases = [e["Work Email"], e["Personal Email"], e["Alternate Work Email"], e["Alternate Work Email 2"]]
    .map((a) => norm(a))
    .filter(Boolean);
  for (const a of aliases) {
    if (!aliasesByEmail.has(a)) aliasesByEmail.set(a, aliases);
  }
}
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
    const k = email || name.toLowerCase();
    if (!k || seenW.has(k)) continue;
    seenW.add(k);
    const aliases = (email && aliasesByEmail.get(email)) || (email ? [email] : []);
    if (email) payrollEmails.add(email);
    for (const a of aliases) payrollEmails.add(a);
  }
}

// ── readiness view: email → row (last-wins, mirrors buildMissingBank) ───────
const idRowByEmail = new Map();
for (const r of ids) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (em) idRowByEmail.set(em, r);
  }
}
// audit view: email → ALL rows (unfiltered table)
const allRowsByEmail = new Map();
for (const r of idsAll) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (!em) continue;
    if (!allRowsByEmail.has(em)) allRowsByEmail.set(em, []);
    allRowsByEmail.get(em).push(r);
  }
}
const ratesByEmail = new Map();
for (const r of rates) {
  const w = norm(r.work_email);
  const p = norm(r.personal_email);
  if (w) ratesByEmail.set(w, r);
  if (p) ratesByEmail.set(p, r);
}

// ── the missing-bank list, exactly as the endpoint builds it ────────────────
const seen = new Set();
let eligibleCount = 0;
const missing = [];
for (const e of employees) {
  const dept = e["Department"];
  const name = e["Name"];
  const w = norm(e["Work Email"]);
  const p = norm(e["Personal Email"]);
  const n = (name ?? "").trim().toLowerCase();
  if (isOffChannelDept(dept)) continue;
  if (isPausedDept(dept)) continue;
  const excluded =
    (w && exceptionIdentities.has(w)) || (p && exceptionIdentities.has(p)) || (n && exceptionIdentities.has(`name:${n}`));
  if (excluded) continue;
  const base = w || p || n;
  if (!base) continue;
  const idKey = `${base}|${n}`;
  if (seen.has(idKey)) continue;
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
  const reason = whyIncomplete(idRow, extras);
  if (reason) {
    const onPayroll = (!!w && payrollEmails.has(w)) || (!!p && payrollEmails.has(p));
    const aliases = [
      w,
      p,
      norm(e["Alternate Work Email"]),
      norm(e["Alternate Work Email 2"]),
    ].filter(Boolean);
    missing.push({ name, dept, w, p, aliases, reason, onPayroll, extras, pickedRow: idRow });
  }
}

console.log(`current upload: ${current?.source_file ?? "(none)"} · week ${weekStart}..${weekEnd}`);
console.log(`eligible: ${eligibleCount} · missing-bank (No Bank Info list): ${missing.length} · on payroll: ${missing.filter((m) => m.onPayroll).length}\n`);

// ── evidence sources ─────────────────────────────────────────────────────────
let history = [];
try {
  history = await fetchAll("bank_update_history", "work_email, employee_name, via, created_new, fields, created_at");
} catch (e) {
  console.warn(`bank_update_history unavailable: ${e.message}`);
}
const historyByEmail = new Map();
for (const h of history) {
  const em = norm(h.work_email);
  if (!em) continue;
  if (!historyByEmail.has(em)) historyByEmail.set(em, []);
  historyByEmail.get(em).push(h);
}

let auditRows = [];
try {
  auditRows = await fetchAll("audit_log", "resource_id, action, created_at, details", (q) =>
    q.eq("action", "bank_update.saved"),
  );
} catch (e) {
  console.warn(`audit_log unavailable: ${e.message}`);
}
const auditByEmail = new Map();
for (const a of auditRows) {
  const em = norm(a.resource_id);
  if (!em) continue;
  if (!auditByEmail.has(em)) auditByEmail.set(em, []);
  auditByEmail.get(em).push(a);
}

let pendingPref = [];
try {
  pendingPref = await fetchAll("bank_preferred_change_requests", "*", (q) => q.eq("status", "pending"));
} catch (e) {
  console.warn(`bank_preferred_change_requests unavailable: ${e.message}`);
}
const pendingPrefByEmail = new Map();
for (const r of pendingPref) {
  for (const em of [norm(r.work_email), norm(r.employee_email), norm(r.requested_by)]) {
    if (em && !pendingPrefByEmail.has(em)) pendingPrefByEmail.set(em, r);
  }
}

// ── cross-examine every flagged person ───────────────────────────────────────
const misread = [];
const submittedIncomplete = [];
const pendingApproval = [];
const noSubmission = [];

for (const m of missing) {
  // Every employee_ids row reachable by any alias (dedupe by pk id).
  const rows = [];
  const seenPk = new Set();
  for (const a of m.aliases) {
    for (const r of allRowsByEmail.get(a) ?? []) {
      if (!seenPk.has(r.id)) {
        seenPk.add(r.id);
        rows.push(r);
      }
    }
  }

  // A payable row readiness can't see?
  const payableRows = rows.filter((r) => whyIncomplete(r, m.extras) === null);
  if (payableRows.length) {
    const r = payableRows[0];
    const why = [];
    if (!r.employee_id || !r.name) why.push("row dropped by the employee_id&&name filter");
    const keys = [norm(r.work_email), norm(r.personal_email)].filter(Boolean);
    if (!keys.includes(m.w) && !keys.includes(m.p)) why.push(`row keyed by ${keys.join("/")} (roster looks up ${m.w || m.p})`);
    if (keys.includes(m.w) || keys.includes(m.p)) {
      const picked = m.pickedRow;
      if (picked && picked.id !== r.id) why.push(`shadowed by same-email row ${picked.employee_id ?? picked.id}`);
      if (!picked) why.push("readiness map returned nothing for the roster emails (dupe shadowing?)");
    }
    misread.push({
      ...m,
      row: r,
      whyMissed: why.join("; ") || "unclear — needs a look",
      selfStamp: r.bank_last_self_updated_at ?? null,
    });
    continue;
  }

  // Evidence they tried via the external link / HRIS?
  const hist = m.aliases.flatMap((a) => historyByEmail.get(a) ?? []);
  const audits = m.aliases.flatMap((a) => auditByEmail.get(a) ?? []);
  const stamped = rows.filter((r) => r.bank_last_self_updated_at);
  const selfRows = rows.filter((r) => String(r.employee_id ?? "").startsWith("SELF-"));
  const pendingReq = m.aliases.map((a) => pendingPrefByEmail.get(a)).find(Boolean);

  if (hist.length || audits.length || stamped.length || selfRows.length) {
    const latest =
      [...hist.map((h) => h.created_at), ...audits.map((a) => a.created_at), ...stamped.map((r) => r.bank_last_self_updated_at)]
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    submittedIncomplete.push({ ...m, rows, hist, audits, stamped, selfRows, latest });
  } else if (pendingReq) {
    pendingApproval.push({ ...m, pendingReq });
  } else {
    noSubmission.push(m);
  }
}

console.log(`== verdicts ==`);
console.log(`MISREAD (has payable data readiness can't see): ${misread.length}`);
console.log(`SUBMITTED but genuinely incomplete            : ${submittedIncomplete.length}`);
console.log(`PENDING bank-preferred approval               : ${pendingApproval.length}`);
console.log(`NO SUBMISSION anywhere (correctly listed)     : ${noSubmission.length}`);

if (misread.length) {
  console.log(`\n-- MISREAD (should NOT be in the No Bank list) --`);
  for (const x of misread) {
    console.log(`  ${x.name} [${x.dept}] ${x.w || x.p}${x.onPayroll ? " · ON PAYROLL" : ""}`);
    console.log(`      listed because: ${x.reason}`);
    console.log(`      payable row: ${x.row.employee_id ?? "(no id)"} "${x.row.name ?? "(no name)"}" we=${x.row.work_email ?? "-"} pe=${x.row.personal_email ?? "-"}${x.selfStamp ? ` · self-updated ${String(x.selfStamp).slice(0, 10)}` : ""}`);
    console.log(`      why readiness misses it: ${x.whyMissed}`);
  }
}

if (submittedIncomplete.length) {
  console.log(`\n-- SUBMITTED via link/HRIS but data incomplete (correctly listed, needs follow-up) --`);
  for (const x of submittedIncomplete) {
    const src = [
      x.hist.length ? `history×${x.hist.length}` : "",
      x.audits.length ? `audit×${x.audits.length}` : "",
      x.stamped.length ? "self-stamp" : "",
      x.selfRows.length ? "SELF-row" : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${x.name} [${x.dept}] ${x.w || x.p}${x.onPayroll ? " · ON PAYROLL" : ""} · ${x.reason} · evidence: ${src}${x.latest ? ` · last ${String(x.latest).slice(0, 10)}` : ""}`);
  }
}

if (pendingApproval.length) {
  console.log(`\n-- PENDING bank-preferred approval (Issues tab) --`);
  for (const x of pendingApproval) {
    console.log(`  ${x.name} [${x.dept}] ${x.w || x.p} · ${x.reason}`);
  }
}

console.log(`\nDone (read-only).`);

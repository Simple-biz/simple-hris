/**
 * Seed bank/payout info for HSL (Hogan) people on the Payroll Readiness
 * "No Bank Info" list for the 2026-07-12..2026-07-18 pay week, from
 * references/data/NPD Bank List - Hogan.csv.
 *
 * Rules (Kane, 2026-07-26):
 *   - Only people ON the No Bank Info list (recomputed exactly like the
 *     readiness endpoint, against the Jul 12-18 upload) are touched.
 *   - Anyone with evidence of a submission via HRIS / External Link
 *     (bank_update_history, audit_log bank_update.saved, self-update stamp,
 *     SELF- rows, pending bank_preferred_change_requests) is SKIPPED.
 *   - Anyone with a payable employee_ids row anywhere is SKIPPED (misread).
 *   - Hurupay Email present  → bank_preferred='hurupay' + hurupay_email,
 *     plus receiving bank details (account number etc.) when the CSV has them.
 *     Hurupay WINS over HiGlobe when both emails are present.
 *   - else HiGlobe Email     → bank_preferred='higlobe' + higlobe_email +
 *     higlobe_account_name, plus receiving bank details when present.
 *   - else From = Wise/x1161 → receiving bank details (bank name, account
 *     holder, Primary Bank Acount Number, SWIFT) + bank_preferred
 *     ('wise' for Wise, 'wires' for x1161 — the send-from rail).
 *   - Everything is fill-EMPTY-only. Existing values are never overwritten;
 *     conflicts are reported instead.
 *
 * Targeting: the exact row the readiness lookup picks (so the flag actually
 * clears). If the person has rows but none visible to readiness, the best
 * row is repaired (employee_id/name/work_email filled) instead of minting a
 * duplicate. A row is only CREATED when the person has no employee_ids row
 * at all (real id from active_employees, occupancy-checked).
 *
 * Usage:
 *   node scripts/seed-hsl-npd-bank-list.mjs            # dry run (default)
 *   node scripts/seed-hsl-npd-bank-list.mjs --apply    # write
 *   node scripts/seed-hsl-npd-bank-list.mjs --verbose  # also list unmatched people
 *
 * Backup: pre-update rows → references/backups/<date>_seed_hsl_npd_bank_backup.json
 *         created rows    → references/backups/<date>_seed_hsl_npd_bank_created_rows.json
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const TARGET_WEEK = "2026-07-12"; // pay week Jul 12-18, 2026

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (writes need service role).");
  process.exit(1);
}
const supabase = createClient(url, key);

const CSV_PATH = path.join("references", "data", "NPD Bank List - Hogan.csv");

const norm = (e) => (e == null ? "" : String(e).trim().toLowerCase());
const filled = (v) => v != null && String(v).trim() !== "";
const isEmail = (v) => /^\S+@\S+\.\S+$/.test(String(v ?? "").trim());
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

// ── Read + normalize the NPD Bank List CSV ───────────────────────────────────
const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
function parseCsv() {
  const wb = XLSX.readFile(CSV_PATH, { raw: true });
  const raws = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const byEmail = new Map(); // work email → normalized row (last wins)
  for (const r of raws) {
    const workEmail = norm(r["Work Email"]);
    if (!workEmail) continue;
    const notes = [];
    let bankName = String(r["Primary Bank"] ?? "").trim();
    let acctName = String(r["Primary Bank Account Name"] ?? "").trim();
    let address = String(r["Primary Bank Address"] ?? "").trim();
    let acct = String(r["Primary Bank Acount Number"] ?? "").trim();
    let swift = String(r["Primary Bank SWIFT Code"] ?? "").trim();

    // Column-shift repair: some rows have acct in Address, SWIFT in AcctNumber,
    // address text in SWIFT (berne/ivanmm/gibsn pattern).
    const addressDigits = address.replace(/[\s-]/g, "");
    if (acct && /[A-Za-z]/.test(acct) && /^\d{6,}$/.test(addressDigits)) {
      notes.push(`column-shift repaired (acct was "${acct}")`);
      const shiftedSwift = acct.toUpperCase().replace(/\s+/g, "");
      acct = address;
      swift = SWIFT_RE.test(shiftedSwift) ? shiftedSwift : "";
    }

    acct = acct.replace(/\s+/g, "");
    if (acct && /[^0-9-]/.test(acct)) {
      notes.push(`account number dropped (non-numeric: "${acct}")`);
      acct = "";
    }
    swift = swift.toUpperCase().replace(/\s+/g, "");
    if (swift && !SWIFT_RE.test(swift)) {
      notes.push(`swift dropped (invalid: "${swift}")`);
      swift = "";
    }

    let hurupayEmail = norm(r["Hurupay Email"]);
    if (hurupayEmail && !isEmail(hurupayEmail)) {
      notes.push(`hurupay email dropped (invalid: "${hurupayEmail}")`);
      hurupayEmail = "";
    }
    let higlobeEmail = norm(r["HiGlobe Email"]);
    if (higlobeEmail && !isEmail(higlobeEmail)) {
      notes.push(`higlobe email dropped (invalid: "${higlobeEmail}")`);
      higlobeEmail = "";
    }

    byEmail.set(workEmail, {
      workEmail,
      hurupayEmail,
      higlobeEmail,
      higlobeName: String(r["HiGlobe Name"] ?? "").trim(),
      bankName,
      acctName,
      acct,
      swift,
      from: norm(r["From"]),
      notes,
    });
  }
  return byEmail;
}

// ── Build the plan (fields to fill) for one CSV row ──────────────────────────
function planFields(csv) {
  const bankDetails = {
    ...(csv.bankName ? { bank_name: csv.bankName } : {}),
    ...(csv.acctName ? { account_holder_name: csv.acctName } : {}),
    ...(csv.acct ? { account_number: csv.acct } : {}),
    ...(csv.swift ? { swift_code: csv.swift } : {}),
  };
  if (csv.hurupayEmail) {
    return {
      processor: "hurupay",
      fields: { bank_preferred: "hurupay", hurupay_email: csv.hurupayEmail, ...bankDetails },
    };
  }
  if (csv.higlobeEmail) {
    const name = csv.higlobeName || csv.acctName;
    return {
      processor: "higlobe",
      fields: {
        bank_preferred: "higlobe",
        higlobe_email: csv.higlobeEmail,
        ...(name ? { higlobe_account_name: name } : {}),
        ...bankDetails,
      },
      note: !csv.higlobeName && name ? "higlobe_account_name from Primary Bank Account Name" : null,
    };
  }
  if (csv.from === "wise" || csv.from === "x1161") {
    if (!csv.acct) return { processor: null, reason: `From=${csv.from} but no usable account number` };
    if (!csv.bankName) return { processor: null, reason: `From=${csv.from} but no bank name (wire details would stay incomplete)` };
    return {
      processor: csv.from === "wise" ? "wise" : "wires",
      fields: { bank_preferred: csv.from === "wise" ? "wise" : "wires", ...bankDetails },
    };
  }
  return { processor: null, reason: `no hurupay/higlobe email and From="${csv.from}" is not wise/x1161` };
}

// ── Load everything the readiness endpoint loads ─────────────────────────────
const csvByEmail = parseCsv();
console.log(`CSV: ${csvByEmail.size} unique work emails from ${CSV_PATH}`);

const uploads = await fetchAll("hubstaff_uploads", "source_file, uploaded_at, is_current");
const upload =
  uploads.find((u) => (u.source_file ?? "").includes(`_${TARGET_WEEK}_`)) ??
  uploads.find((u) => u.is_current) ??
  null;
if (!upload) {
  console.error("No hubstaff upload found — cannot scope the readiness week.");
  process.exit(1);
}
const weekStart = (() => {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(upload.source_file ?? "");
  return m ? m[1] : null;
})();
if (weekStart !== TARGET_WEEK) {
  console.warn(`WARNING: resolved upload ${upload.source_file} is week ${weekStart}, not ${TARGET_WEEK}.`);
}
const weekEnd = (() => {
  if (!weekStart) return null;
  const [y, mo, d] = weekStart.split("-").map(Number);
  const e = new Date(y, mo - 1, d + 6);
  return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
})();
console.log(`Readiness week: ${weekStart}..${weekEnd} (upload: ${upload.source_file})\n`);

const employees = await fetchAll(
  "active_employees",
  'Department,Name,"Personal Email","Work Email","Alternate Work Email","Alternate Work Email 2",employee_id,off_boarded_at',
);
const idsAll = await fetchAll("employee_ids", "*", (q) => q.order("employee_id"));
const ids = idsAll.filter((r) => r.employee_id && r.name);
const pendingRows = await fetchAll("hr_pending_employees").catch(() => []);

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

let pausedKeys = new Set();
try {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", `payroll.wizard.dept_pay_paused.${upload.source_file}`)
    .maybeSingle();
  const arr = data?.value ? JSON.parse(data.value) : [];
  if (Array.isArray(arr)) pausedKeys = new Set(arr.filter((k) => typeof k === "string"));
} catch {}
if (pausedKeys.size) console.log(`Paused depts this week (excluded from readiness): ${[...pausedKeys].join(", ")}\n`);

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

// readiness view: email → row (last-wins, mirrors buildMissingBank)
const idRowByEmail = new Map();
for (const r of ids) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (em) idRowByEmail.set(em, r);
  }
}
// audit view: email → ALL rows (unfiltered table)
const allRowsByEmail = new Map();
const idRowsByEmployeeId = new Map();
for (const r of idsAll) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (!em) continue;
    if (!allRowsByEmail.has(em)) allRowsByEmail.set(em, []);
    allRowsByEmail.get(em).push(r);
  }
  const eid = String(r.employee_id ?? "").trim();
  if (eid) {
    if (!idRowsByEmployeeId.has(eid)) idRowsByEmployeeId.set(eid, []);
    idRowsByEmployeeId.get(eid).push(r);
  }
}
const ratesByEmail = new Map();
for (const r of rates) {
  const w = norm(r.work_email);
  const p = norm(r.personal_email);
  if (w) ratesByEmail.set(w, r);
  if (p) ratesByEmail.set(p, r);
}

// ── The missing-bank list, exactly as the endpoint builds it ─────────────────
const seen = new Set();
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
    const aliases = [w, p, norm(e["Alternate Work Email"]), norm(e["Alternate Work Email 2"])].filter(Boolean);
    missing.push({
      name,
      dept,
      w,
      p,
      aliases,
      reason,
      extras,
      pickedRow: idRow,
      activeEmployeeId: e.employee_id ? String(e.employee_id).trim() : null,
    });
  }
}
console.log(`No Bank Info list (week ${weekStart}): ${missing.length} people\n`);

// ── HRIS / External-Link submission evidence ─────────────────────────────────
let history = [];
try {
  history = await fetchAll("bank_update_history", "work_email, created_at");
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
  auditRows = await fetchAll("audit_log", "resource_id, action, created_at", (q) => q.eq("action", "bank_update.saved"));
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

// ── Classify every flagged person against the CSV ────────────────────────────
const toUpdate = [];
const toCreate = [];
const skipSubmitted = [];   // HRIS/external-link evidence → hands off
const skipPayable = [];     // payable row exists somewhere (misread) → hands off
const unseedable = [];      // in CSV but no seedable rule/data
const conflicts = [];       // planned processor vs existing filled bank_preferred
const residuals = [];       // seeded but still incomplete afterwards
const blocked = [];         // create blocked
const notInCsv = [];        // flagged but not in the CSV
const claimedPkIds = new Set();
const claimedEmployeeIds = new Set();

for (const m of missing) {
  const csv = m.aliases.map((a) => csvByEmail.get(a)).find(Boolean);
  if (!csv) {
    notInCsv.push(m);
    continue;
  }

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

  // Gate 1: payable row exists anywhere → readiness misread, not a seed case.
  if (rows.some((r) => whyIncomplete(r, m.extras) === null)) {
    skipPayable.push(m);
    continue;
  }

  // Gate 2: submitted via HRIS / external link → do not clobber.
  const hist = m.aliases.flatMap((a) => historyByEmail.get(a) ?? []);
  const audits = m.aliases.flatMap((a) => auditByEmail.get(a) ?? []);
  const stamped = rows.filter((r) => r.bank_last_self_updated_at);
  const selfRows = rows.filter((r) => String(r.employee_id ?? "").startsWith("SELF-"));
  const pendingReq = m.aliases.map((a) => pendingPrefByEmail.get(a)).find(Boolean);
  if (hist.length || audits.length || stamped.length || selfRows.length || pendingReq) {
    const src = [
      hist.length ? `history×${hist.length}` : "",
      audits.length ? `audit×${audits.length}` : "",
      stamped.length ? "self-stamp" : "",
      selfRows.length ? "SELF-row" : "",
      pendingReq ? "pending-approval" : "",
    ]
      .filter(Boolean)
      .join(", ");
    skipSubmitted.push({ ...m, evidence: src });
    continue;
  }

  const plan = planFields(csv);
  if (!plan.processor) {
    unseedable.push({ ...m, csv, why: plan.reason });
    continue;
  }

  if (rows.length) {
    // Target the row readiness actually picks; else repair the best row.
    let target = m.pickedRow ? rows.find((r) => r.id === m.pickedRow.id) ?? m.pickedRow : null;
    const repair = {};
    if (!target) {
      target =
        rows.find((r) => norm(r.work_email) === m.w) ??
        rows.find((r) => norm(r.personal_email) === m.p && m.p) ??
        rows[0];
      // Make it visible to readiness (employee_id && name filter) and keyed
      // by an email the roster looks up (work/personal).
      if (!filled(target.employee_id) && m.activeEmployeeId) repair.employee_id = m.activeEmployeeId;
      if (!filled(target.name) && m.name) repair.name = m.name;
      const keys = [norm(target.work_email), norm(target.personal_email)].filter(Boolean);
      if (!keys.includes(m.w) && !keys.includes(m.p)) {
        if (!filled(target.work_email) && m.w) repair.work_email = m.w;
        else if (!filled(target.personal_email) && m.p) repair.personal_email = m.p;
      }
      const stillInvisible =
        (!filled(target.employee_id) && !repair.employee_id) || (!filled(target.name) && !repair.name);
      const stillUnkeyed =
        ![norm(target.work_email), norm(target.personal_email), repair.work_email, repair.personal_email]
          .filter(Boolean)
          .some((k) => k === m.w || (m.p && k === m.p));
      if (stillInvisible || stillUnkeyed) {
        blocked.push({
          ...m,
          why: `existing row ${target.employee_id ?? target.id} cannot be made visible to readiness (${stillInvisible ? "no id/name" : "not keyable by roster email"})`,
        });
        continue;
      }
    }
    if (claimedPkIds.has(target.id)) {
      blocked.push({ ...m, why: `row ${target.id} already claimed by another CSV email` });
      continue;
    }

    // Fill-empty only; collect conflicts on already-filled fields.
    const fields = { ...repair };
    const fieldConflicts = [];
    for (const [k, v] of Object.entries(plan.fields)) {
      if (!filled(target[k])) fields[k] = v;
      else if (norm(target[k]) !== norm(v)) fieldConflicts.push(`${k}: has "${target[k]}", csv "${v}"`);
    }
    if (fieldConflicts.length) conflicts.push({ ...m, target, fieldConflicts });
    if (!Object.keys(fields).length) {
      residuals.push({ ...m, note: "nothing to fill (all planned fields already set) yet still flagged", after: m.reason });
      continue;
    }

    // Will the merged row actually be complete?
    const after = whyIncomplete({ ...target, ...fields }, m.extras);
    claimedPkIds.add(target.id);
    toUpdate.push({
      m,
      csv,
      plan,
      pk: target.id,
      row: target,
      fields,
      after,
      rowLabel: `${target.employee_id ?? "?"} ${target.name ?? ""} <${target.work_email ?? target.personal_email ?? ""}>`,
    });
    if (after) residuals.push({ ...m, note: `seeded but still incomplete: ${after}`, after });
    continue;
  }

  // No employee_ids row at all → create with the person's real id.
  if (!m.activeEmployeeId) {
    blocked.push({ ...m, why: "no employee_ids row and no active_employees id" });
    continue;
  }
  if ((idRowsByEmployeeId.get(m.activeEmployeeId) ?? []).length || claimedEmployeeIds.has(m.activeEmployeeId)) {
    blocked.push({ ...m, why: `employee_id ${m.activeEmployeeId} already occupied/claimed` });
    continue;
  }
  claimedEmployeeIds.add(m.activeEmployeeId);
  const insertRow = {
    employee_id: m.activeEmployeeId,
    name: m.name,
    work_email: m.w || null,
    personal_email: m.p || null,
    ...plan.fields,
  };
  const after = whyIncomplete(insertRow, m.extras);
  toCreate.push({ m, csv, plan, insertRow, after });
  if (after) residuals.push({ ...m, note: `created but still incomplete: ${after}`, after });
}

// CSV rows that matched nobody on the missing list (info only).
const flaggedAliases = new Set(missing.flatMap((m) => m.aliases));
const csvNotFlagged = [...csvByEmail.keys()].filter((e) => !flaggedAliases.has(e));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — NPD Bank List (Hogan) → No Bank Info seed, week ${weekStart}\n`);
console.log(`Will UPDATE existing row     : ${toUpdate.length}`);
console.log(`Will CREATE payout row       : ${toCreate.length}`);
console.log(`Skip — submitted (HRIS/link) : ${skipSubmitted.length}`);
console.log(`Skip — payable row exists    : ${skipPayable.length}`);
console.log(`Skip — unseedable CSV row    : ${unseedable.length}`);
console.log(`Blocked                      : ${blocked.length}`);
console.log(`Flagged but NOT in CSV       : ${notInCsv.length}`);
console.log(`CSV rows not on the list     : ${csvNotFlagged.length}`);
console.log(`Field conflicts (kept as-is) : ${conflicts.length}`);
console.log(`Still incomplete after seed  : ${residuals.length}`);

const label = (m) => `${m.name} [${m.dept}] ${m.w || m.p}`;

if (toUpdate.length) {
  console.log(`\nUpdates (fill empty fields on the row readiness reads):`);
  for (const t of toUpdate) {
    console.log(`  ${label(t.m)}  → ${t.plan.processor}  row: ${t.rowLabel}`);
    console.log(`      sets: ${JSON.stringify(t.fields)}`);
    if (t.csv.notes.length) console.log(`      csv notes: ${t.csv.notes.join("; ")}`);
    if (t.plan.note) console.log(`      note: ${t.plan.note}`);
    if (t.after) console.log(`      STILL INCOMPLETE AFTER: ${t.after}`);
  }
}
if (toCreate.length) {
  console.log(`\nCreates:`);
  for (const c of toCreate) {
    console.log(`  ${label(c.m)}  → ${c.plan.processor}  id=${c.insertRow.employee_id}`);
    console.log(`      row: ${JSON.stringify(c.insertRow)}`);
    if (c.csv.notes.length) console.log(`      csv notes: ${c.csv.notes.join("; ")}`);
    if (c.after) console.log(`      STILL INCOMPLETE AFTER: ${c.after}`);
  }
}
if (skipSubmitted.length) {
  console.log(`\nSkipped — submitted via HRIS/external link (NOT touched):`);
  for (const x of skipSubmitted) console.log(`  ${label(x)} · ${x.reason} · evidence: ${x.evidence}`);
}
if (skipPayable.length) {
  console.log(`\nSkipped — payable row already exists (readiness misread, NOT touched):`);
  for (const x of skipPayable) console.log(`  ${label(x)} · listed because: ${x.reason}`);
}
if (unseedable.length) {
  console.log(`\nUnseedable CSV rows (on the list, but no rule/data applies):`);
  for (const x of unseedable) console.log(`  ${label(x)} · ${x.why}${x.csv.notes.length ? ` · csv notes: ${x.csv.notes.join("; ")}` : ""}`);
}
if (blocked.length) {
  console.log(`\nBlocked:`);
  for (const x of blocked) console.log(`  ${label(x)} · ${x.why}`);
}
if (conflicts.length) {
  console.log(`\nConflicts (existing values kept, CSV value NOT written):`);
  for (const x of conflicts) for (const c of x.fieldConflicts) console.log(`  ${label(x)} · ${c}`);
}
if (notInCsv.length) {
  const byDept = new Map();
  for (const m of notInCsv) byDept.set(m.dept, (byDept.get(m.dept) ?? 0) + 1);
  console.log(`\nFlagged but not in CSV, by dept:`);
  for (const [d, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${d}`);
  if (VERBOSE) for (const m of notInCsv) console.log(`    ${label(m)} · ${m.reason}`);
}

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
  process.exit(0);
}

// ── Backup, then write ───────────────────────────────────────────────────────
const outDir = path.join("references", "backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);

if (toUpdate.length) {
  const backupPath = path.join(outDir, `${stamp}_seed_hsl_npd_bank_backup.json`);
  fs.writeFileSync(backupPath, JSON.stringify(toUpdate.map((t) => t.row), null, 2));
  console.log(`\nBacked up ${toUpdate.length} pre-update row(s) → ${backupPath}`);
}

let updated = 0;
let created = 0;
let failed = 0;
const createdRows = [];
const createdPath = path.join(outDir, `${stamp}_seed_hsl_npd_bank_created_rows.json`);

for (const t of toUpdate) {
  // Re-read by PK and re-verify each field is STILL empty (no clobber race).
  const { data: cur, error: curErr } = await supabase.from("employee_ids").select("*").eq("id", t.pk).maybeSingle();
  if (curErr || !cur) {
    failed += 1;
    console.error(`  FAIL ${t.m.w}: re-read failed (${curErr?.message ?? "row gone"})`);
    continue;
  }
  if (cur.bank_last_self_updated_at || String(cur.employee_id ?? "").startsWith("SELF-")) {
    console.log(`  SKIP ${t.m.w}: self-service submission appeared since selection — untouched`);
    continue;
  }
  const fields = Object.fromEntries(Object.entries(t.fields).filter(([k]) => !filled(cur[k])));
  if (!Object.keys(fields).length) {
    console.log(`  SKIP ${t.m.w}: nothing left to fill`);
    continue;
  }
  const { data, error } = await supabase.from("employee_ids").update(fields).eq("id", t.pk).select("id");
  if (error || !data?.length) {
    failed += 1;
    console.error(`  FAIL ${t.m.w}: ${error?.message ?? "no row updated"}`);
  } else {
    updated += 1;
    console.log(`  OK   ${t.m.w} UPDATED ${Object.keys(fields).join(", ")}`);
  }
}

for (const c of toCreate) {
  // Re-check nothing appeared under this id/email since selection (idempotent).
  const ors = [`employee_id.eq.${c.insertRow.employee_id}`];
  if (c.insertRow.work_email) ors.push(`work_email.ilike.${c.insertRow.work_email}`);
  if (c.insertRow.personal_email) ors.push(`personal_email.ilike.${c.insertRow.personal_email}`);
  const { data: existing, error: preErr } = await supabase
    .from("employee_ids")
    .select("id")
    .or(ors.join(","))
    .limit(1);
  if (preErr) {
    failed += 1;
    console.error(`  FAIL ${c.m.w} (pre-check): ${preErr.message}`);
    continue;
  }
  if (existing && existing.length) {
    console.log(`  SKIP ${c.m.w}: employee_ids row appeared since selection — untouched`);
    continue;
  }
  const { error } = await supabase.from("employee_ids").insert(c.insertRow);
  if (error) {
    failed += 1;
    console.error(`  FAIL ${c.m.w} (create): ${error.message}`);
  } else {
    created += 1;
    createdRows.push(c.insertRow);
    fs.writeFileSync(createdPath, JSON.stringify(createdRows, null, 2));
    console.log(`  OK   ${c.m.w} CREATED id=${c.insertRow.employee_id}`);
  }
}

if (createdRows.length) console.log(`\nRecorded ${createdRows.length} created row(s) → ${createdPath}`);
console.log(`\nDone. Updated: ${updated}, Created: ${created}, Failed: ${failed}`);
process.exit(failed ? 1 : 0);

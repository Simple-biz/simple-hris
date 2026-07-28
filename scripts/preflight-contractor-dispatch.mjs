/**
 * READ-ONLY pre-flight for the "contractors in Payment Dispatch" feature.
 *
 * Run BEFORE references/sql/alter/add_contractor_dispatch_link.sql to see what
 * the live schema already has, and AFTER to confirm every part landed:
 *
 *   node scripts/preflight-contractor-dispatch.mjs
 *
 * Reports
 *   1. Schema state  — the new columns on contractor_invoices / payment_dispatches
 *   2. Cycle state   — the is_current Hubstaff upload + its paused departments
 *   3. Payability    — every approved, unclaimed invoice with its resolved rail
 *   4. Role set      — how many people hold the contractor role (badge population)
 *
 * Never writes. Safe to run at any time, including mid-payroll.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const norm = (e) => (e == null ? "" : String(e).trim().toLowerCase());

/** Retry a probe on a THROWN/transport error — `TypeError: fetch failed` is a real flake here. */
async function withRetry(label, run) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await run();
      // postgrest-js returns transport failures as an error object, not a throw.
      if (res?.error && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(res.error.message ?? '')) {
        last = res.error;
      } else {
        return res;
      }
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`${label}: ${last?.message ?? String(last)}`);
}

/** Does `table.column` exist? Probed by selecting it — PostgREST 42703s when it doesn't. */
async function hasColumn(table, column) {
  const { error } = await withRetry(`${table}.${column}`, () =>
    supabase.from(table).select(column).limit(1),
  );
  if (!error) return true;
  if (/does not exist|column/i.test(error.message)) return false;
  throw new Error(`${table}.${column}: ${error.message}`);
}

console.log("=== 1. SCHEMA STATE ===");
const schema = {};
for (const [table, column] of [
  ["contractor_invoices", "dispatch_id"],
  ["contractor_invoices", "dispatch_claimed_at"],
  ["contractor_invoices", "last_dispatched_at"],
  ["payment_dispatches", "payee_type"],
  ["payment_dispatches", "contractor_invoice_id"],
]) {
  schema[`${table}.${column}`] = await hasColumn(table, column);
  console.log(`  ${schema[`${table}.${column}`] ? "PRESENT" : "MISSING "}  ${table}.${column}`);
}
const migrated = Object.values(schema).every(Boolean);
console.log(`  → migration ${migrated ? "HAS been applied" : "has NOT been applied (run the SQL first)"}`);

console.log("\n=== 2. CYCLE + PAUSED DEPARTMENTS ===");
const { data: uploads, error: upErr } = await supabase
  .from("hubstaff_uploads")
  .select("id, source_file, is_current, uploaded_at")
  .eq("is_current", true)
  .order("uploaded_at", { ascending: false });
if (upErr) console.log("  hubstaff_uploads unreadable:", upErr.message);
const current = uploads?.[0] ?? null;
console.log("  is_current upload:", current ? `${current.source_file} (uploaded ${current.uploaded_at})` : "NONE");
if ((uploads?.length ?? 0) > 1) {
  console.log(`  !! ${uploads.length} rows flagged is_current — duplicate-ingest landmine, readers may disagree on the week`);
}
const { data: pausedRows } = await supabase
  .from("app_settings")
  .select("key, value")
  .like("key", "payroll.wizard.dept_pay_paused%");
for (const r of pausedRows ?? []) console.log(`  ${r.key} = ${r.value}`);
let pausedKeys = [];
if (current) {
  const row = (pausedRows ?? []).find((r) => r.key === `payroll.wizard.dept_pay_paused.${current.source_file}`);
  try {
    pausedKeys = row ? JSON.parse(row.value) : [];
  } catch {
    pausedKeys = [];
  }
}
console.log("  paused keys for the current file:", JSON.stringify(pausedKeys));

console.log("\n=== 3. PAYABLE CONTRACTOR INVOICES ===");
const invSelect = migrated
  ? "id, contractor_email, invoice_number, total, currency, status, invoice_date, created_at, payment_method, dispatch_id, dispatch_claimed_at"
  : "id, contractor_email, invoice_number, total, currency, status, invoice_date, created_at, payment_method";
const { data: invoices, error: invErr } = await supabase.from("contractor_invoices").select(invSelect);
if (invErr) throw invErr;
const byStatus = invoices.reduce((a, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {});
console.log("  invoice statuses:", JSON.stringify(byStatus));

const approved = invoices.filter(
  (i) => i.status === "approved" && (!migrated || (!i.dispatch_id && !i.dispatch_claimed_at)),
);
const emails = [...new Set(approved.map((i) => norm(i.contractor_email)))];

const { data: ids } = await supabase
  .from("employee_ids")
  .select("work_email, personal_email, name, bank_preferred, preferred_processor, hurupay_email, higlobe_email, bank_name, account_number, account_holder_name, swift_code")
  .or(emails.map((e) => `work_email.ilike.${e}`).join(",") || "work_email.ilike.__none__");
const idsByEmail = new Map();
for (const r of ids ?? []) {
  if (r.work_email) idsByEmail.set(norm(r.work_email), r);
  if (r.personal_email && !idsByEmail.has(norm(r.personal_email))) idsByEmail.set(norm(r.personal_email), r);
}
const { data: profiles } = await supabase.from("contractor_profiles").select("*").in("contractor_email", emails);
const profByEmail = new Map((profiles ?? []).map((p) => [norm(p.contractor_email), p]));
const { data: master } = await supabase
  .from("active_employees")
  .select('"Name", "Work Email", "Personal Email", "Department"');
const deptByEmail = new Map();
for (const r of master ?? []) {
  const d = r["Department"] ?? null;
  if (r["Work Email"]) deptByEmail.set(norm(r["Work Email"]), d);
  if (r["Personal Email"] && !deptByEmail.has(norm(r["Personal Email"]))) deptByEmail.set(norm(r["Personal Email"]), d);
}

console.log(`  ${approved.length} approved+unclaimed invoice(s) across ${emails.length} contractor(s):`);
for (const inv of approved) {
  const e = norm(inv.contractor_email);
  const idRow = idsByEmail.get(e);
  const prof = profByEmail.get(e);
  const rail =
    idRow?.bank_preferred?.trim() ||
    idRow?.preferred_processor?.trim() ||
    prof?.preferred_processor?.trim() ||
    inv.payment_method?.processor ||
    null;
  console.log(
    `   ${inv.invoice_number.padEnd(22)} ${e.padEnd(26)} ${String(inv.total).padStart(10)} ${inv.currency ?? "?"}` +
      ` | dept=${deptByEmail.get(e) ?? "NONE"} | rail=${rail ?? "NONE → Excluded/no_bank"}` +
      ` | ids_row=${idRow ? "yes" : "NO"} | profile=${prof ? "yes" : "no"} | pm=${inv.payment_method ? "set" : "null"}`,
  );
}
const sums = approved.reduce((a, i) => {
  const c = (i.currency ?? "PHP").toUpperCase();
  a[c] = (a[c] ?? 0) + Number(i.total ?? 0);
  return a;
}, {});
console.log("  payable totals by currency:", JSON.stringify(sums));

console.log("\n=== 4. CONTRACTOR ROLE SET (badge population) ===");
const { data: roles, error: roleErr } = await supabase
  .from("employee_roles")
  .select("work_email, role, revoked_at")
  .eq("role", "contractor")
  .is("revoked_at", null);
if (roleErr) console.log("  employee_roles unreadable:", roleErr.message);
else {
  const set = [...new Set((roles ?? []).map((r) => norm(r.work_email)))];
  console.log(`  ${set.length} active contractor-role holder(s)`);
  console.log("  with an approved invoice:", set.filter((e) => emails.includes(e)).join(", ") || "none");
  console.log("  without any payable invoice:", set.filter((e) => !emails.includes(e)).length, "(badge-only if they appear via hourly payroll)");
}

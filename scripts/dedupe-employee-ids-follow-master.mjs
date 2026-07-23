/**
 * De-duplicate employee_ids, following the Global Master List as the identity
 * source of truth.
 *
 * A "person group" = a set of employee_ids rows that share ANY email (work or
 * personal, case-insensitive). Duplicates arise when a SELF-xxxx row (created
 * when the employee filled in their own payout details) coexists with a numeric
 * YYMM-NNNN row minted from the master-list sync.
 *
 * CLEAN pattern (the only thing this script mutates):
 *   - exactly 2 rows in the group
 *   - exactly one row carries payout data (emails / bank / processor / etc.)
 *   - exactly one row's employee_id matches an ACTIVE active_employees.employee_id
 *   - the master-ID row and the data row are resolvable (either same row, or the
 *     data row's id is NOT a master id and the empty row's id IS)
 *
 * Action for a clean group (follow the master list):
 *   SURVIVOR = the row whose employee_id is the master-list id.
 *   Copy every non-empty payout field from the data row onto the survivor
 *   (only filling BLANKS on the survivor — never clobber a value it already has),
 *   then DELETE the other row.
 *   If the survivor already IS the data row (its id is the master id and it holds
 *   the data), just delete the empty duplicate.
 *
 * Everything else (both rows have data, different work-email aliases, >2 rows,
 * neither/both ids match master) is MESSY → left untouched and reported.
 *
 * Usage:
 *   node scripts/dedupe-employee-ids-follow-master.mjs            # dry run
 *   node scripts/dedupe-employee-ids-follow-master.mjs --apply    # backup + merge + delete
 *
 * Backup: full JSON of every row in every touched group (pre-change) →
 * references/backups/<date>_dedupe_employee_ids.json
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

// Payout / bank / contact fields we carry over. NOT employee_id, name, or emails
// (identity comes from the master-ID survivor row).
const PAYOUT_FIELDS = [
  "bank_preferred",
  "preferred_processor",
  "preferred_bank_slot",
  "hurupay_email",
  "wepay_email",
  "higlobe_email",
  "higlobe_account_name",
  "wise_email",
  "wise_tag",
  "bank_name",
  "account_holder_name",
  "account_number",
  "routing_number",
  "swift_code",
  "alt_bank_name",
  "alt_account_holder_name",
  "alt_account_number",
  "alt_routing_number",
  "phone_number",
  "full_address",
];

const norm = (e) => (e ?? "").trim().toLowerCase() || null;
const nonEmpty = (v) => v != null && String(v).trim() !== "";
const hasPayoutData = (r) => PAYOUT_FIELDS.some((k) => nonEmpty(r[k]));

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

const ids = await fetchAll("employee_ids");
const master = await fetchAll(
  "active_employees",
  '"Name","Work Email","Personal Email",employee_id,off_boarded_at',
);

// Active master-list employee_ids (identity source of truth).
const masterIds = new Set();
for (const m of master) {
  if (m.off_boarded_at) continue;
  const id = m.employee_id ? String(m.employee_id).trim() : null;
  if (id) masterIds.add(id);
}

// Group employee_ids rows by shared email (union via first-seen key).
const groups = new Map();
const emailToKey = new Map();
function keyFor(r) {
  const we = norm(r.work_email);
  const pe = norm(r.personal_email);
  const existing = (we && emailToKey.get(we)) || (pe && emailToKey.get(pe));
  const k = existing || we || pe || `id:${r.employee_id}`;
  if (we) emailToKey.set(we, k);
  if (pe) emailToKey.set(pe, k);
  return k;
}
for (const r of ids) {
  const k = keyFor(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const dupeGroups = [...groups.values()].filter((g) => g.length > 1);

const plan = []; // { survivor, deleteRow, carryFields, name }
const messy = []; // groups left untouched

for (const g of dupeGroups) {
  const withData = g.filter(hasPayoutData);
  const masterRows = g.filter((r) => masterIds.has(String(r.employee_id).trim()));

  // Strict CLEAN test.
  const clean =
    g.length === 2 &&
    withData.length <= 1 &&
    masterRows.length === 1; // exactly one row is the canonical master-list id

  if (!clean) {
    messy.push(g);
    continue;
  }

  const survivor = masterRows[0]; // keep the master-list id
  const other = g.find((r) => r !== survivor);

  // Determine which fields to carry over: any payout field the survivor is
  // MISSING but the other row has. (When the data row already IS the survivor,
  // carryFields is empty and we just delete the empty stub.)
  const carryFields = {};
  for (const f of PAYOUT_FIELDS) {
    if (!nonEmpty(survivor[f]) && nonEmpty(other[f])) carryFields[f] = other[f];
  }

  plan.push({
    name: survivor.name || other.name || "?",
    survivorId: survivor.employee_id,
    deleteId: other.employee_id,
    survivorWork: survivor.work_email,
    otherWork: other.work_email,
    carryFields,
    survivorRow: survivor,
    deleteRow: other,
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — dedupe employee_ids (follow master list)\n`);
console.log(`Duplicate person-groups: ${dupeGroups.length}`);
console.log(`  CLEAN → will merge+delete: ${plan.length}`);
console.log(`  MESSY → left untouched (reported): ${messy.length}`);

const carrying = plan.filter((p) => Object.keys(p.carryFields).length > 0);
console.log(`\nOf the ${plan.length} clean merges, ${carrying.length} need payout data carried onto the master-ID row; ${plan.length - carrying.length} just drop an empty stub.\n`);

for (const p of plan) {
  const cf = Object.keys(p.carryFields);
  console.log(
    `  KEEP ${String(p.survivorId).padEnd(16)} DELETE ${String(p.deleteId).padEnd(20)} ${(p.name).padEnd(34)}` +
      (cf.length ? ` carry: ${cf.join(", ")}` : ` (stub, no carry)`),
  );
}

if (messy.length) {
  console.log(`\n── MESSY groups left untouched (${messy.length}) — decide by hand ──`);
  for (const g of messy) {
    console.log(`\n### ${g[0].name || "?"} (${g.length} rows)`);
    for (const r of g) {
      console.log(
        `  id=${String(r.employee_id).padEnd(18)} masterID=${masterIds.has(String(r.employee_id).trim()) ? "YES" : "no "} ` +
          `we=${String(r.work_email || "-").padEnd(22)} pe=${String(r.personal_email || "-").padEnd(30)} ` +
          `data=${hasPayoutData(r) ? "YES" : "-"} huru=${r.hurupay_email ? "Y" : "-"} higl=${r.higlobe_email ? "Y" : "-"} bank=${r.bank_name ? "Y" : "-"}`,
      );
    }
  }
}

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to backup + merge + delete.");
  process.exit(0);
}

if (plan.length === 0) {
  console.log("\nNothing to merge. Done.");
  process.exit(0);
}

// ── Backup every touched row (both survivor + deleted), pre-change ───────────
const backupDir = path.join("references", "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `${new Date().toISOString().slice(0, 10)}_dedupe_employee_ids.json`);
fs.writeFileSync(
  backupPath,
  JSON.stringify(
    plan.map((p) => ({
      name: p.name,
      survivorId: p.survivorId,
      deleteId: p.deleteId,
      carryFields: p.carryFields,
      survivorRow: p.survivorRow,
      deletedRow: p.deleteRow,
    })),
    null,
    2,
  ),
);
console.log(`\nBacked up ${plan.length} groups (both rows each) → ${backupPath}`);

let merged = 0;
let deleted = 0;
let failed = 0;
for (const p of plan) {
  // 1) Carry payout data onto the survivor (only if there's anything to carry).
  if (Object.keys(p.carryFields).length > 0) {
    const { error: upErr } = await supabase
      .from("employee_ids")
      .update(p.carryFields)
      .eq("employee_id", p.survivorId);
    if (upErr) {
      failed += 1;
      console.error(`  FAIL carry ${p.name} (${p.survivorId}): ${upErr.message}`);
      continue; // don't delete the source if the carry failed
    }
    merged += 1;
  }

  // 2) Delete the duplicate row.
  const { error: delErr, count } = await supabase
    .from("employee_ids")
    .delete({ count: "exact" })
    .eq("employee_id", p.deleteId);
  if (delErr) {
    failed += 1;
    console.error(`  FAIL delete ${p.name} (${p.deleteId}): ${delErr.message}`);
  } else if (!count) {
    console.warn(`  WARN ${p.name}: delete matched 0 rows (${p.deleteId})`);
  } else {
    deleted += 1;
    console.log(`  OK   ${p.name}: kept ${p.survivorId}, deleted ${p.deleteId}` +
      (Object.keys(p.carryFields).length ? ` (carried ${Object.keys(p.carryFields).length} fields)` : ""));
  }
}
console.log(`\nDone: ${deleted} duplicates deleted, ${merged} data-carries, ${failed} failed. Backup at ${backupPath}`);

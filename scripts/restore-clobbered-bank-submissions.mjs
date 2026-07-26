/**
 * Restore employee bank submissions clobbered by the 2026-07-22 PD-Data
 * preferred_processor overwrite (the "No-Bank list clobbered submissions"
 * incident — e.g. Mitch Briones: submitted higlobe via the external link on
 * Jul 22 03:22, bulk-overwritten to 'wires' at 14:51 the same day).
 *
 * Signature required to restore (ALL must hold — anything else is untouched):
 *   1. bank_update_history shows the person set preferred_processor = X
 *      themselves (changed: true), X != 'wires'.
 *   2. Their employee_ids row NOW has preferred_processor = 'wires' and an
 *      empty bank_preferred (so 'wires' is what the row resolves to).
 *   3. The row was updated AFTER the submission (the overwrite came later).
 *   4. The row is payable under X using the data already sitting on it (their
 *      own submitted fields). NOTE: the row being payable as 'wires' right now
 *      does NOT protect it — with the receiving bank details seeded from the
 *      NPD sheet, 'wires' can read payable while still being the overwrite
 *      artifact rather than the person's choice (e.g. Mitch Briones chose
 *      higlobe). The submitted processor always wins.
 *
 * The ONLY field written is preferred_processor (back to the submitted value).
 *
 * Usage:
 *   node scripts/restore-clobbered-bank-submissions.mjs          # dry run
 *   node scripts/restore-clobbered-bank-submissions.mjs --apply  # write
 *
 * Backup: pre-update rows → references/backups/<date>_restore_clobbered_bank_backup.json
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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const supabase = createClient(url, key);

const norm = (e) => (e == null ? "" : String(e).trim().toLowerCase());
const filled = (v) => v != null && String(v).trim() !== "";

async function fetchAll(table, select = "*", filter = null) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── mirror of src/lib/employee/payout-completeness.ts (current, strict wise) ──
const PROCESSOR_IDS = ["hurupay", "wepay", "higlobe", "wise", "jeeves", "wires"];
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
const pick = (row, ...keys) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
};
function isPayoutComplete(row) {
  const bankPreferred = processorIdFromBankPreferredText(pick(row, "bank_preferred"));
  const disbursement = pick(row, "preferred_processor").toLowerCase();
  const processor = bankPreferred ?? (PROCESSOR_IDS.includes(disbursement) ? disbursement : null);
  if (!processor) return false;
  const hasWireDetails =
    !!(pick(row, "bank_name") || pick(row, "alt_bank_name")) &&
    !!(pick(row, "account_number") || pick(row, "alt_account_number"));
  switch (processor) {
    case "hurupay":
      return !!pick(row, "hurupay_email");
    case "wepay":
      return !!pick(row, "wepay_email");
    case "higlobe":
      return !!pick(row, "higlobe_email") && !!pick(row, "higlobe_account_name");
    case "wise":
    case "jeeves":
    case "wires":
      return hasWireDetails;
    default:
      return false;
  }
}

// ── scan ──────────────────────────────────────────────────────────────────────
const history = await fetchAll("bank_update_history", "work_email, employee_name, via, changes, created_at");
const idsAll = await fetchAll("employee_ids", "*", (q) => q.order("employee_id"));

const rowsByEmail = new Map();
for (const r of idsAll) {
  for (const e of [r.work_email, r.personal_email]) {
    const em = norm(e);
    if (!em) continue;
    if (!rowsByEmail.has(em)) rowsByEmail.set(em, []);
    rowsByEmail.get(em).push(r);
  }
}

// Latest self-set processor per person (last submission wins).
const submittedByEmail = new Map(); // email → {processor, at, via}
for (const h of [...history].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
  const em = norm(h.work_email);
  if (!em) continue;
  const changes = Array.isArray(h.changes) ? h.changes : [];
  const procChange = changes.find((c) => c.field === "preferred_processor" && c.changed && filled(c.after));
  if (!procChange) continue;
  submittedByEmail.set(em, { processor: String(procChange.after).toLowerCase(), at: h.created_at, via: h.via });
}

const toRestore = [];
const skipped = [];
for (const [email, sub] of submittedByEmail) {
  if (sub.processor === "wires") continue; // nothing clobbered to detect
  for (const row of rowsByEmail.get(email) ?? []) {
    if (norm(row.preferred_processor) !== "wires") continue; // not overwritten
    if (filled(row.bank_preferred)) continue;                // bank_preferred would win anyway
    if (String(row.updated_at ?? "") <= String(sub.at)) continue; // overwrite must postdate the submission
    const restored = { ...row, preferred_processor: sub.processor };
    if (!isPayoutComplete(restored)) {
      skipped.push(`${row.name ?? email} <${email}>: submitted ${sub.processor} but row lacks its fields — restore wouldn't make them payable`);
      continue;
    }
    toRestore.push({ email, sub, row });
  }
}

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — restore clobbered bank submissions\n`);
console.log(`History rows with a self-set processor : ${submittedByEmail.size}`);
console.log(`Will RESTORE preferred_processor       : ${toRestore.length}`);
console.log(`Skipped (restore wouldn't complete)    : ${skipped.length}\n`);

for (const t of toRestore) {
  console.log(
    `  ${t.row.name ?? t.email} <${t.email}> [${t.row.employee_id ?? t.row.id}]  wires → ${t.sub.processor}` +
      `  (submitted ${String(t.sub.at).slice(0, 16)} via ${t.sub.via}, row overwritten ${String(t.row.updated_at).slice(0, 16)})`,
  );
}
if (skipped.length) console.log(`\nSkipped:\n  ${skipped.join("\n  ")}`);

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
  process.exit(0);
}

const outDir = path.join("references", "backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const backupPath = path.join(outDir, `${stamp}_restore_clobbered_bank_backup.json`);
fs.writeFileSync(backupPath, JSON.stringify(toRestore.map((t) => t.row), null, 2));
console.log(`\nBacked up ${toRestore.length} pre-update row(s) → ${backupPath}`);

let ok = 0;
let failed = 0;
for (const t of toRestore) {
  // Re-read and re-verify the exact signature at write time (no clobber race).
  const { data: cur, error: curErr } = await supabase.from("employee_ids").select("*").eq("id", t.row.id).maybeSingle();
  if (curErr || !cur) {
    failed += 1;
    console.error(`  FAIL ${t.email}: re-read failed (${curErr?.message ?? "row gone"})`);
    continue;
  }
  if (norm(cur.preferred_processor) !== "wires" || filled(cur.bank_preferred)) {
    console.log(`  SKIP ${t.email}: row changed since selection — untouched`);
    continue;
  }
  if (!isPayoutComplete({ ...cur, preferred_processor: t.sub.processor })) {
    console.log(`  SKIP ${t.email}: restore would no longer complete the row — untouched`);
    continue;
  }
  const { data, error } = await supabase
    .from("employee_ids")
    .update({ preferred_processor: t.sub.processor })
    .eq("id", t.row.id)
    .select("id");
  if (error || !data?.length) {
    failed += 1;
    console.error(`  FAIL ${t.email}: ${error?.message ?? "no row updated"}`);
  } else {
    ok += 1;
    console.log(`  OK   ${t.email} restored → ${t.sub.processor}`);
  }
}
console.log(`\nDone. Restored: ${ok}, Failed: ${failed}`);
process.exit(failed ? 1 : 0);

/**
 * Repair for dedupe-employee-ids-follow-master.mjs: the merge kept payout fields
 * but NOT the work_email / name identity, so 161 survivor rows ended up with a
 * NULL work_email. Every view that resolves a person by WORK email (People →
 * Banking, Payment Dispatch, employee profile) then misses their row — the
 * symptom Lovely showed ("No payout details on file" though her HiGlobe data is
 * in the row, resolvable only by personal email).
 *
 * Fix: for each survivor that lost its work_email, restore the work_email (and
 * name) from the row that was deleted (recorded in the dedupe backup).
 *
 * Safety: NEVER restore a work_email that another employee_ids row already holds
 * (would recreate a duplicate). Such cases are skipped + reported.
 *
 * Usage:
 *   node scripts/repair-dedupe-restore-work-email.mjs            # dry run
 *   node scripts/repair-dedupe-restore-work-email.mjs --apply    # restore
 *
 * Source of truth for what to restore: the dedupe backup JSON.
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

const BACKUP = path.join("references", "backups", "2026-07-23_dedupe_employee_ids.json");
const norm = (e) => (e ?? "").trim().toLowerCase() || null;

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

const plan = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
const ids = await fetchAll("employee_ids", "employee_id,name,work_email,personal_email");
const byId = new Map(ids.map((r) => [String(r.employee_id).trim(), r]));

// Work-email → set of employee_ids currently using it (to detect would-be dupes).
const workEmailOwners = new Map();
for (const r of ids) {
  const we = norm(r.work_email);
  if (!we) continue;
  if (!workEmailOwners.has(we)) workEmailOwners.set(we, new Set());
  workEmailOwners.get(we).add(String(r.employee_id).trim());
}

const toRestore = [];
const skipped = [];

for (const p of plan) {
  const survId = String(p.survivorId).trim();
  const surv = byId.get(survId);
  if (!surv) continue; // survivor gone (shouldn't happen)
  const deletedWork = norm(p.deletedRow.work_email);
  if (norm(surv.work_email)) continue; // already has a work email — nothing to do
  if (!deletedWork) continue; // deleted row had none either

  // Would restoring this work email collide with a DIFFERENT existing row?
  const owners = workEmailOwners.get(deletedWork);
  const collidesWith = owners
    ? [...owners].filter((id) => id !== survId)
    : [];
  if (collidesWith.length > 0) {
    skipped.push({
      survId,
      name: p.deletedRow.name || surv.name,
      work: p.deletedRow.work_email,
      reason: `work_email already on ${collidesWith.join(", ")}`,
    });
    continue;
  }

  toRestore.push({
    survId,
    name: p.deletedRow.name || surv.name,
    work: p.deletedRow.work_email,
    // Restore the deleted row's name too when the survivor's name looks like the
    // OTHER person (its id master-maps elsewhere) — but only if different; harmless.
    restoreName: p.deletedRow.name || surv.name,
    survPersonal: surv.personal_email,
  });
}

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — restore work_email lost in dedupe\n`);
console.log(`Survivors to repair: ${toRestore.length}`);
console.log(`Skipped (work_email would collide): ${skipped.length}`);
for (const t of toRestore.slice(0, 20)) {
  console.log(`  ${t.survId.padEnd(16)} ← work=${String(t.work).padEnd(28)} name=${t.name}`);
}
if (toRestore.length > 20) console.log(`  … +${toRestore.length - 20} more`);
if (skipped.length) {
  console.log(`\nSkipped:`);
  for (const skp of skipped) console.log(`  ${skp.survId.padEnd(16)} work=${skp.work} — ${skp.reason}`);
}

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply.");
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const t of toRestore) {
  const patch = { work_email: t.work };
  if (t.restoreName) patch.name = t.restoreName;
  const { data, error } = await supabase
    .from("employee_ids")
    .update(patch)
    .eq("employee_id", t.survId)
    .is("work_email", null) // only if still null (no clobber race)
    .select("employee_id");
  if (error) {
    failed += 1;
    console.error(`  FAIL ${t.survId} (${t.work}): ${error.message}`);
  } else if (!data?.length) {
    failed += 1;
    console.error(`  SKIP ${t.survId}: work_email no longer null`);
  } else {
    ok += 1;
    console.log(`  OK   ${t.survId} → ${t.work}`);
  }
}
console.log(`\nDone: ${ok} restored, ${failed} failed/skipped.`);

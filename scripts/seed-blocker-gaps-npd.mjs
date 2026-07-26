/**
 * Targeted fill for the remaining Jul-12-18 No-Bank BLOCKERS whose single
 * missing field is sitting in the NPD Bank List CSVs (Kane 2026-07-26:
 * "seed them properly"). Fill-EMPTY-only, exact person/field list — the
 * wallet emails complete the processor the person THEMSELVES picked; the
 * two higlobe names + Ivan's wire details come straight from the sheet.
 *
 * NOT here on purpose:
 *   - chtistinec@ (Del Carmen): the CSV row is christinec@ / cancioc590@ —
 *     surname says a different person; needs Kane's eyes.
 *   - karenr@ (wise): sheet account number is float-mangled (9.16105E+11,
 *     AUB ends 2922) — real digits unrecoverable.
 *   - aliviah@ / alissar@ (Accounting Team): in neither CSV, no rows at all.
 *
 * Usage: node scripts/seed-blocker-gaps-npd.mjs [--apply]
 * Backup: references/backups/<date>_seed_blocker_gaps_backup.json
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
  console.error("Missing Supabase env.");
  process.exit(1);
}
const supabase = createClient(url, key);
const filled = (v) => v != null && String(v).trim() !== "";

// work_email → fields to fill (values verbatim from the NPD sheets).
const PLAN = {
  "kingslyc@simple.biz": { higlobe_account_name: "Kingsly Cajilig" },
  "maycp@simple.biz": { hurupay_email: "casulprincemay@gmail.com" },
  "nield@simple.biz": { hurupay_email: "damianniel26@gmail.com" },
  "janicer@simple.biz": { hurupay_email: "revillasnice@gmail.com" },
  "marissat@simple.biz": { hurupay_email: "taguinodmarissa1974@gmail.com" },
  "kimv@simple.biz": { hurupay_email: "kimie23_10@live.com" },
  "roses@simple.biz": {
    higlobe_account_name: "Rosemarie Marquez Sardan",
    bank_name: "Sea Bank",
    account_number: "14177080013",
    swift_code: "LAUIPHM2XXX",
  },
  // Column-shifted Hogan row repaired: acct was in Address (ends 7389 = To),
  // SWIFT in the acct column.
  "ivanmm@simple.biz": {
    bank_name: "BPI",
    account_holder_name: "Ivan Rhey Martinez",
    account_number: "129327389",
    swift_code: "BOPIPHMM",
  },
};

const backups = [];
let planned = 0;
for (const [email, fields] of Object.entries(PLAN)) {
  const { data: rows, error } = await supabase
    .from("employee_ids")
    .select("*")
    .or(`work_email.ilike.${email},personal_email.ilike.${email}`);
  if (error) {
    console.error(`FAIL ${email}: ${error.message}`);
    continue;
  }
  if (!rows?.length) {
    // No row at all (Ivan) → create one keyed by the person's real active id,
    // only if that id is completely unoccupied.
    const { data: ae } = await supabase
      .from("active_employees")
      .select('"Name","Work Email","Personal Email",employee_id')
      .ilike('"Work Email"', email)
      .limit(1);
    const a = ae?.[0];
    const eid = a?.employee_id ? String(a.employee_id).trim() : null;
    if (!a || !eid) {
      console.log(`SKIP ${email}: no employee_ids row and no active_employees id`);
      continue;
    }
    const { data: occ } = await supabase.from("employee_ids").select("id").eq("employee_id", eid).limit(1);
    if (occ?.length) {
      console.log(`SKIP ${email}: employee_id ${eid} already occupied`);
      continue;
    }
    planned += 1;
    const insertRow = {
      employee_id: eid,
      name: a["Name"],
      work_email: a["Work Email"],
      personal_email: a["Personal Email"] || null,
      ...fields,
    };
    console.log(`${APPLY ? "CREATE" : "PLAN-CREATE"} ${email} ${JSON.stringify(insertRow)}`);
    if (APPLY) {
      const { error: insErr } = await supabase.from("employee_ids").insert(insertRow);
      if (insErr) console.error(`FAIL ${email} (create): ${insErr.message}`);
      else console.log(`OK   ${email} created id=${eid}`);
    }
    continue;
  }
  // Prefer the row keyed by the work email (the one readiness reads).
  const target =
    rows.find((r) => String(r.work_email ?? "").toLowerCase() === email) ?? rows[0];
  const toSet = Object.fromEntries(Object.entries(fields).filter(([k]) => !filled(target[k])));
  const conflicts = Object.entries(fields).filter(
    ([k, v]) => filled(target[k]) && String(target[k]).trim().toLowerCase() !== String(v).trim().toLowerCase(),
  );
  for (const [k, v] of conflicts) console.log(`CONFLICT ${email} ${k}: row has "${target[k]}", sheet "${v}" — kept`);
  if (!Object.keys(toSet).length) {
    console.log(`SKIP ${email}: nothing to fill`);
    continue;
  }
  planned += 1;
  console.log(`${APPLY ? "SET " : "PLAN"} ${email} [${target.employee_id ?? target.id}] ← ${JSON.stringify(toSet)}`);
  if (!APPLY) continue;
  backups.push(target);
  const { data: upd, error: updErr } = await supabase
    .from("employee_ids")
    .update(toSet)
    .eq("id", target.id)
    .select("id");
  if (updErr || !upd?.length) console.error(`FAIL ${email}: ${updErr?.message ?? "no row updated"}`);
  else console.log(`OK   ${email}`);
}

if (APPLY && backups.length) {
  const outDir = path.join("references", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, `${new Date().toISOString().slice(0, 10)}_seed_blocker_gaps_backup.json`);
  fs.writeFileSync(p, JSON.stringify(backups, null, 2));
  console.log(`Backed up ${backups.length} pre-update row(s) → ${p}`);
}
console.log(`${APPLY ? "Applied" : "Planned"}: ${planned}`);

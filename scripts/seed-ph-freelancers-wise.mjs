/**
 * Seed Wise payout info for the "PH Global Freelancers" Wise list.
 *
 * Source: references/docs/PH Global Freelancers .xlsx (columns: Email / From / To,
 * where From is always "Wise" and To is the last-4 of the Wise card/account).
 *
 * For each list email that resolves to a person who is (a) in global_master_list,
 * (b) not off-boarded, and (c) has NO payout info anywhere in employee_ids, writes:
 *   employee_ids.wise_email     = the list email
 *   employee_ids.wise_tag       = "last4:<To>"        (hint only; healed later via
 *                                 Payment Dispatch or employee self-service)
 *   employee_ids.bank_preferred = 'wise'              (send-from rail for PD routing)
 *   employee_ids.work_email     = master work email   (only if currently NULL — payroll
 *                                 lookups key on work_email, so the row must be findable)
 *
 * Matching is PERSON-first, not email-first: many employee_ids rows are keyed only by
 * a personal gmail (from onboarding) with a STALE employee_id, so we resolve the person
 * via global_master_list + active_employees, collect ALL their known emails, and match
 * employee_ids rows on any of them. employee_id values in employee_ids are known-stale
 * (2603-xxxx block is shifted) and are NEVER used for matching or rewritten.
 *
 * Strict rules:
 *   - ANY payout signal on ANY of the person's rows → skipped untouched.
 *   - Updates key on the primary key `id` and fill EMPTY fields only.
 *   - Insert only when the person has no employee_ids row under any known email,
 *     reusing their real employee_id from active_employees — and only if that id is
 *     not already occupied by someone else's row (no duplicate ids ever minted).
 *   - Not in global_master_list → reported, skipped (per request).
 *
 * Usage:
 *   node scripts/seed-ph-freelancers-wise.mjs          # dry run (default)
 *   node scripts/seed-ph-freelancers-wise.mjs --apply  # write
 *
 * Backup: pre-update employee_ids rows → references/backups/<date>_seed_ph_freelancers_wise_backup.json
 *         created rows               → references/backups/<date>_seed_ph_freelancers_wise_created_rows.json
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import XLSX from "xlsx";
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

const XLSX_PATH = path.join("references", "docs", "PH Global Freelancers .xlsx");

const norm = (e) => (e == null ? "" : String(e).trim().toLowerCase());
const filled = (v) => v != null && String(v).trim() !== "";

/** "9382" stays; numeric-only shorter than 4 gets Excel's lost leading zeros back ("210" → "0210"). */
function normalizeLast4(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
}

async function fetchAll(table, select = "*", orderCol = null) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (orderCol) q = q.order(orderCol); // stable page boundaries on multi-page tables
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** ANY payout signal at all → we do not touch this person. */
function hasAnyPayoutInfo(e) {
  if (!e) return false;
  return [
    e.wise_email,
    e.wise_tag,
    e.bank_name,
    e.account_number,
    e.routing_number,
    e.swift_code,
    e.alt_bank_name,
    e.alt_account_number,
    e.alt_routing_number,
    e.hurupay_email,
    e.higlobe_email,
    e.higlobe_account_name,
    e.wepay_email,
    e.bank_preferred,
    e.preferred_processor,
    e.account_holder_name,
    e.alt_account_holder_name,
    e.preferred_bank_slot,
    e.phone_number, // Jeeves / wire pickups
    e.full_address, // wires + Jeeves
  ].some(filled);
}

// ── Read the Wise list (dedupe by email, last row wins) ──────────────────────
const wb = XLSX.readFile(XLSX_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }).slice(1); // drop header
const listByEmail = new Map(); // email → { email, last4 }
for (const r of rows) {
  const email = norm(r[0]);
  if (!email) continue;
  listByEmail.set(email, { email, last4: normalizeLast4(r[2]) });
}

// ── Load master list, active_employees, employee_ids ────────────────────────
const gml = await fetchAll(
  "global_master_list",
  '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Employement Status",off_boarded_at',
);
const gmlByEmail = new Map();
for (const r of gml) {
  for (const e of [r["Work Email"], r["Personal Email"], r["Alternate Work Email"], r["Alternate Work Email 2"]]) {
    const k = norm(e);
    if (k && !gmlByEmail.has(k)) gmlByEmail.set(k, r);
  }
}

const active = await fetchAll(
  "active_employees",
  '"Name","Work Email","Personal Email",employee_id,off_boarded_at',
);
const activeByEmail = new Map();
for (const r of active) {
  if (r.off_boarded_at) continue;
  const rec = {
    name: r["Name"]?.trim() || null,
    work_email: r["Work Email"]?.trim() || null,
    personal_email: r["Personal Email"]?.trim() || null,
    employee_id: r.employee_id ? String(r.employee_id).trim() : null,
  };
  for (const k of [norm(r["Work Email"]), norm(r["Personal Email"])]) {
    if (k && !activeByEmail.has(k)) activeByEmail.set(k, rec);
  }
}

const ids = await fetchAll("employee_ids", "*", "id");
const idRowsByEmail = new Map(); // email → row[] (a person can have several rows)
const idRowsByEmployeeId = new Map(); // employee_id → row[] (occupancy check for inserts)
for (const r of ids) {
  for (const k of [norm(r.work_email), norm(r.personal_email)]) {
    if (!k) continue;
    if (!idRowsByEmail.has(k)) idRowsByEmail.set(k, []);
    idRowsByEmail.get(k).push(r);
  }
  const eid = String(r.employee_id ?? "").trim();
  if (eid) {
    if (!idRowsByEmployeeId.has(eid)) idRowsByEmployeeId.set(eid, []);
    idRowsByEmployeeId.get(eid).push(r);
  }
}

// ── Classify every list email (person-first) ─────────────────────────────────
const toUpdate = []; // existing row for the person, zero payout info → fill empty fields
const toCreate = []; // truly no row for the person → insert with real employee_id
const skipHasInfo = []; // already has some payout signal — untouched
const skipNotInMaster = []; // not in global_master_list
const skipOffboarded = []; // in master but off-boarded
const cannotCreate = []; // needs a row but blocked (no active id / id occupied)
const blockedByOccupancy = []; // create blocked by stale-id rows; maybe unblockable below
const claimedPkIds = new Set(); // two list emails resolving to the same row guard
const claimedEmployeeIds = new Set();

for (const f of listByEmail.values()) {
  const m = gmlByEmail.get(f.email);
  if (!m) {
    skipNotInMaster.push(f.email);
    continue;
  }
  if (m.off_boarded_at) {
    skipOffboarded.push(`${f.email} (${m["Name"] ?? ""})`);
    continue;
  }

  // Every email we know for this person: list + master's 4 columns + active's 2.
  const personEmails = new Set([f.email]);
  for (const e of [m["Work Email"], m["Personal Email"], m["Alternate Work Email"], m["Alternate Work Email 2"]]) {
    if (norm(e)) personEmails.add(norm(e));
  }
  const a = activeByEmail.get(f.email) ?? [...personEmails].map((k) => activeByEmail.get(k)).find(Boolean) ?? null;
  for (const e of [a?.work_email, a?.personal_email]) {
    if (norm(e)) personEmails.add(norm(e));
  }

  // All employee_ids rows belonging to this person, by any known email.
  const personRows = [];
  const seenPk = new Set();
  for (const k of personEmails) {
    for (const r of idRowsByEmail.get(k) ?? []) {
      if (!seenPk.has(r.id)) {
        seenPk.add(r.id);
        personRows.push(r);
      }
    }
  }

  if (personRows.some(hasAnyPayoutInfo)) {
    skipHasInfo.push(`${f.email} (${m["Name"] ?? ""})`);
    continue;
  }

  const wiseTag = f.last4 ? `last4:${f.last4}` : null;
  const masterWorkEmail = (m["Work Email"] ?? a?.work_email ?? "").trim() || null;

  if (personRows.length) {
    // Prefer the row already keyed by the person's work email, else the first match.
    const target =
      personRows.find((r) => norm(r.work_email) && personEmails.has(norm(r.work_email))) ?? personRows[0];
    if (claimedPkIds.has(target.id)) {
      cannotCreate.push(`${f.email} — row ${target.id} already claimed by another list email`);
      continue;
    }
    claimedPkIds.add(target.id);
    toUpdate.push({
      email: f.email,
      name: m["Name"] ?? target.name ?? "",
      dept: m["Department"] ?? "",
      pk: target.id,
      activeId: a?.employee_id ?? null, // the person's REAL id per active_employees
      row: target,
      rowLabel: `${target.employee_id ?? "?"} ${target.name ?? ""} <${target.work_email ?? target.personal_email ?? ""}>`,
      multiRow: personRows.length > 1 ? personRows.length : 0,
      fields: {
        ...(filled(target.wise_email) ? {} : { wise_email: f.email }),
        ...(filled(target.wise_tag) || !wiseTag ? {} : { wise_tag: wiseTag }),
        ...(filled(target.bank_preferred) ? {} : { bank_preferred: "wise" }),
        ...(filled(target.work_email) || !masterWorkEmail ? {} : { work_email: masterWorkEmail }),
      },
    });
    continue;
  }

  // Truly no row → create, reusing the real id from active_employees.
  if (!a?.employee_id) {
    cannotCreate.push(`${f.email} (${m["Name"] ?? ""}) — no employee_ids row and no active_employees id`);
    continue;
  }
  const occupants = idRowsByEmployeeId.get(a.employee_id) ?? [];
  if (occupants.length) {
    // Maybe unblockable: if every occupant is a row we're updating in this run and can
    // be re-keyed to its person's real (free) id, resolve it in the post-pass below.
    blockedByOccupancy.push({ f, m, a, occupants, wiseTag });
    continue;
  }
  if (claimedEmployeeIds.has(a.employee_id)) {
    cannotCreate.push(`${f.email} — employee_id ${a.employee_id} already claimed by another list email`);
    continue;
  }
  claimedEmployeeIds.add(a.employee_id);
  toCreate.push({
    email: f.email,
    dept: m["Department"] ?? "",
    insertRow: {
      employee_id: a.employee_id,
      name: a.name ?? m["Name"] ?? f.email,
      work_email: a.work_email,
      personal_email: a.personal_email,
      wise_email: f.email,
      ...(wiseTag ? { wise_tag: wiseTag } : {}),
      bank_preferred: "wise",
    },
  });
}

// ── Post-pass: unblock creates whose id is squatted by stale rows we already
//    update in this run. Re-key each occupant to its person's real id (only if
//    that id is completely free), which frees the id for the blocked create.
const rekeyReservedIds = new Set();
for (const b of blockedByOccupancy) {
  const plans = [];
  let blockedReason = null;
  for (const occ of b.occupants) {
    const upd = toUpdate.find((t) => t.pk === occ.id);
    if (!upd) {
      blockedReason = `occupant "${occ.name}" (row ${occ.employee_id}) is not part of this run`;
      break;
    }
    const realId = upd.activeId;
    if (!realId || realId === occ.employee_id) {
      blockedReason = `occupant "${occ.name}" has no distinct real id to move to`;
      break;
    }
    const occupied = (idRowsByEmployeeId.get(realId) ?? []).length > 0;
    if (occupied || claimedEmployeeIds.has(realId) || rekeyReservedIds.has(realId)) {
      blockedReason = `occupant "${occ.name}" real id ${realId} is not free`;
      break;
    }
    plans.push({ upd, occ, realId });
  }
  if (blockedReason || !plans.length) {
    cannotCreate.push(
      `${b.f.email} (${b.m["Name"] ?? ""}) — active id ${b.a.employee_id} occupied; ${blockedReason ?? "no re-key plan"}`,
    );
    continue;
  }
  for (const p of plans) {
    rekeyReservedIds.add(p.realId);
    p.upd.fields.employee_id = p.realId;
    p.upd.rekeyNote = `re-keys stale employee_id ${p.occ.employee_id} → ${p.realId} (frees id for ${b.f.email})`;
  }
  claimedEmployeeIds.add(b.a.employee_id);
  toCreate.push({
    email: b.f.email,
    dept: b.m["Department"] ?? "",
    insertRow: {
      employee_id: b.a.employee_id,
      name: b.a.name ?? b.m["Name"] ?? b.f.email,
      work_email: b.a.work_email,
      personal_email: b.a.personal_email,
      wise_email: b.f.email,
      ...(b.wiseTag ? { wise_tag: b.wiseTag } : {}),
      bank_preferred: "wise",
    },
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — PH Global Freelancers → Wise seed\n`);
console.log(`List emails (deduped)      : ${listByEmail.size}`);
console.log(`Will UPDATE (fill empty)   : ${toUpdate.length}`);
console.log(`Will CREATE payout row     : ${toCreate.length}`);
console.log(`Skip — already has payout  : ${skipHasInfo.length}`);
console.log(`Skip — not in master list  : ${skipNotInMaster.length}`);
console.log(`Skip — off-boarded         : ${skipOffboarded.length}`);
console.log(`Cannot create / blocked    : ${cannotCreate.length}`);

if (toUpdate.length) {
  console.log(`\nUpdates (existing row → fill empty fields):`);
  for (const t of toUpdate) {
    const multi = t.multiRow ? `  [!person has ${t.multiRow} rows]` : "";
    console.log(`  ${t.email}  [${t.dept}]  row: ${t.rowLabel}${multi}`);
    console.log(`      sets: ${JSON.stringify(t.fields)}`);
    if (t.rekeyNote) console.log(`      NOTE: ${t.rekeyNote}`);
  }
}
if (toCreate.length) {
  console.log(`\nCreates:`);
  for (const c of toCreate) {
    const r = c.insertRow;
    console.log(
      `  ${c.email}  [${c.dept}] id=${r.employee_id}  ${r.name}  wise_email=${r.wise_email} wise_tag=${r.wise_tag ?? "-"} bank_preferred=wise`,
    );
  }
}
if (skipHasInfo.length) console.log(`\nSkipped (already has payout info):\n  ${skipHasInfo.join("\n  ")}`);
if (skipNotInMaster.length) console.log(`\nSkipped (not in master):\n  ${skipNotInMaster.join("\n  ")}`);
if (skipOffboarded.length) console.log(`\nSkipped (off-boarded):\n  ${skipOffboarded.join("\n  ")}`);
if (cannotCreate.length) console.log(`\nBlocked:\n  ${cannotCreate.join("\n  ")}`);

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
  process.exit(0);
}

// ── Backup, then write ───────────────────────────────────────────────────────
const outDir = path.join("references", "backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);

if (toUpdate.length) {
  const backupPath = path.join(outDir, `${stamp}_seed_ph_freelancers_wise_backup.json`);
  fs.writeFileSync(backupPath, JSON.stringify(toUpdate.map((t) => t.row), null, 2));
  console.log(`\nBacked up ${toUpdate.length} pre-update row(s) → ${backupPath}`);
}

let updated = 0;
let created = 0;
let failed = 0;
const createdRows = [];
const createdPath = path.join(outDir, `${stamp}_seed_ph_freelancers_wise_created_rows.json`);

for (const t of toUpdate) {
  if (!Object.keys(t.fields).length) continue;
  // Re-read by PK and re-verify the person is STILL payout-empty (no clobber race).
  const { data: cur, error: curErr } = await supabase.from("employee_ids").select("*").eq("id", t.pk).maybeSingle();
  if (curErr || !cur) {
    failed += 1;
    console.error(`  FAIL ${t.email}: re-read failed (${curErr?.message ?? "row gone"})`);
    continue;
  }
  if (hasAnyPayoutInfo(cur)) {
    console.log(`  SKIP ${t.email}: payout info appeared since selection — untouched`);
    continue;
  }
  // Drop any field that got filled between selection and now. employee_id is the
  // exception (a re-key of a known-stale value): keep it only while the row still
  // holds exactly the stale value we selected against.
  const fields = Object.fromEntries(
    Object.entries(t.fields).filter(([k, v]) =>
      k === "employee_id" ? cur.employee_id === t.row.employee_id && cur.employee_id !== v : !filled(cur[k]),
    ),
  );
  if (!Object.keys(fields).length) {
    console.log(`  SKIP ${t.email}: nothing left to fill`);
    continue;
  }
  const { data, error } = await supabase.from("employee_ids").update(fields).eq("id", t.pk).select("id");
  if (error || !data?.length) {
    failed += 1;
    console.error(`  FAIL ${t.email}: ${error?.message ?? "no row updated"}`);
  } else {
    updated += 1;
    console.log(`  OK   ${t.email} UPDATED ${Object.keys(fields).join(", ")}`);
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
    // Never insert with the guard blind — a failed pre-check must fail the row.
    failed += 1;
    console.error(`  FAIL ${c.email} (pre-check): ${preErr.message}`);
    continue;
  }
  if (existing && existing.length) {
    console.log(`  SKIP ${c.email}: employee_ids row appeared since selection — untouched`);
    continue;
  }
  const { error } = await supabase.from("employee_ids").insert(c.insertRow);
  if (error) {
    failed += 1;
    console.error(`  FAIL ${c.email} (create): ${error.message}`);
  } else {
    created += 1;
    createdRows.push(c.insertRow);
    // Flush the manifest after every insert so a mid-run crash loses nothing.
    fs.writeFileSync(createdPath, JSON.stringify(createdRows, null, 2));
    console.log(`  OK   ${c.email} CREATED id=${c.insertRow.employee_id}`);
  }
}

if (createdRows.length) console.log(`\nRecorded ${createdRows.length} created row(s) → ${createdPath}`);

console.log(`\nDone. Updated: ${updated}, Created: ${created}, Failed: ${failed}`);
process.exit(failed ? 1 : 0);

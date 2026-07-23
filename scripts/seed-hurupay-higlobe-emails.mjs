/**
 * Backfill Employee Dashboard payment emails for HURUPAY and HIGLOBE ONLY.
 *
 * Source: references/docs/BD for HRIS.csv (columns: s=work email, From=processor,
 * To=payout target). Fills:
 *   From = Hurupay          → employee_ids.hurupay_email
 *   From = HiGlobe/Higlobe  → employee_ids.higlobe_email
 *
 * Strict rules (per request):
 *   - ONLY Hurupay and HiGlobe rows are considered. Wise / x1161 / x1153 / Jeeves
 *     rows are WIRES-style rails and are ignored completely — we never touch them.
 *   - Only fills when the target column is currently EMPTY. If the person already
 *     has that email set, the row is IGNORED (never clobbered).
 *   - Only fills when the CSV "To" is a real email address (has "@"). Blank or
 *     numeric "To" values (which belong to wire rails) are skipped.
 *   - Match CSV "s" to employee_ids by work_email first, then personal_email
 *     (case-insensitive). No employee_ids row → nothing to write, reported.
 *   - Duplicate (email, processor) rows in the CSV: the LAST occurrence wins,
 *     mirroring the app's last-row-wins convention for the rates feed.
 *
 * Usage:
 *   node scripts/seed-hurupay-higlobe-emails.mjs                          # dry run
 *   node scripts/seed-hurupay-higlobe-emails.mjs --apply                  # fill empty only
 *   node scripts/seed-hurupay-higlobe-emails.mjs --apply --overwrite-conflicts
 *                                    # also replace values that DIFFER from the CSV
 *                                    # (e.g. a work email misfiled in the payout slot)
 *   node scripts/seed-hurupay-higlobe-emails.mjs --apply --create-missing-rows
 *                                    # ALSO create a payout row for active people who
 *                                    # have NO employee_ids row yet, reusing their real
 *                                    # employee_id from active_employees, and set the
 *                                    # Hurupay/HiGlobe email in the same insert.
 *
 * Note: employee_ids is the banking/payout-details table (NOT the list of IDs).
 * Bucket-B people already HAVE an employee_id on active_employees — we never mint
 * one; we reuse it. Insert mirrors the app's own pattern in hr-pending-employees.ts.
 *
 * Backup: writes the affected employee_ids rows (full row JSON, pre-update) to
 * references/backups/<date>_seed_hurupay_higlobe_emails.json before writing.
 * Created rows are recorded to <date>_seed_hurupay_higlobe_created_rows.json.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const OVERWRITE_CONFLICTS = process.argv.includes("--overwrite-conflicts");
const CREATE_MISSING_ROWS = process.argv.includes("--create-missing-rows");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (writes need service role).");
  process.exit(1);
}
const supabase = createClient(url, key);

const CSV_PATH = path.join("references", "docs", "BD for HRIS.csv");

/**
 * Normalise the CSV "From" cell to one of our two seedable processors, or null.
 * Hurupay variants → 'hurupay'; HiGlobe variants → 'higlobe'.
 * Everything else (Wise, x1161, x1153, Jeeves, wire codes) → null (ignored).
 */
function seedableProcessor(rawFrom) {
  if (!rawFrom) return null;
  const v = String(rawFrom).trim().toLowerCase().replace(/\s+/g, "");
  if (v === "hurupay" || v === "huru" || v === "huropay") return "hurupay";
  if (v === "higlobe" || v === "higloble" || v === "higlobel") return "higlobe";
  return null;
}

function isEmail(s) {
  return typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

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

// ── Parse the CSV ────────────────────────────────────────────────────────────
// Simple line split is safe here: the file has no quoted fields / embedded commas.
const raw = fs.readFileSync(CSV_PATH, "utf8");
const lines = raw.split(/\r?\n/);
const header = lines.shift(); // "s,From,To"
if (!/^\s*s\s*,\s*From\s*,\s*To/i.test(header ?? "")) {
  console.error(`Unexpected CSV header: ${JSON.stringify(header)}`);
  process.exit(1);
}

// Last (email, processor) wins → keyed map.
const wanted = new Map(); // key `${email}|${processor}` → { email, processor, targetEmail, line }
let hurupayRows = 0;
let higlobeRows = 0;
let skippedNonSeedable = 0;
let skippedNoEmailCell = 0;
let skippedNonEmailTarget = 0;

lines.forEach((line, i) => {
  if (!line.trim()) return;
  // Take the first three comma-separated cells; the "To" cell may contain trailing
  // junk (e.g. "email   4688") — keep only up to the first whitespace run in To.
  const parts = line.split(",");
  const emailCell = (parts[0] ?? "").trim().toLowerCase();
  const fromCell = (parts[1] ?? "").trim();
  const toCell = (parts.slice(2).join(",") ?? "").trim();

  const processor = seedableProcessor(fromCell);
  if (!processor) {
    skippedNonSeedable += 1;
    return;
  }
  if (!emailCell) {
    skippedNoEmailCell += 1;
    return;
  }
  // "To" can carry a trailing token (kaner row: "devkane2343@gmail.com   4688").
  const targetEmail = toCell.split(/\s+/)[0]?.trim().toLowerCase() ?? "";
  if (!isEmail(targetEmail)) {
    skippedNonEmailTarget += 1;
    return;
  }

  if (processor === "hurupay") hurupayRows += 1;
  else higlobeRows += 1;

  // Last occurrence wins.
  wanted.set(`${emailCell}|${processor}`, {
    email: emailCell,
    processor,
    targetEmail,
    line: i + 2, // +2: 1-based + shifted header
  });
});

// ── Load employee_ids, index by work/personal email ─────────────────────────
const ids = await fetchAll(
  "employee_ids",
  "employee_id, name, work_email, personal_email, hurupay_email, higlobe_email",
);

const idsByWork = new Map();
const idsByPersonal = new Map();
const idsByEmployeeId = new Map(); // employee_id → payout row
for (const r of ids) {
  const we = r.work_email?.trim().toLowerCase();
  const pe = r.personal_email?.trim().toLowerCase();
  if (we && !idsByWork.has(we)) idsByWork.set(we, r);
  if (pe && !idsByPersonal.has(pe)) idsByPersonal.set(pe, r);
  if (r.employee_id && !idsByEmployeeId.has(String(r.employee_id).trim())) {
    idsByEmployeeId.set(String(r.employee_id).trim(), r);
  }
}

// ── Load active_employees master list (the source of truth for the real
//    employee_id + name + emails). Used only to CREATE a payout row for active
//    people who have no employee_ids row yet — we NEVER mint an id; we reuse this.
const master = await fetchAll(
  "active_employees",
  '"Name","Work Email","Personal Email",employee_id,off_boarded_at',
);
const masterByEmail = new Map();
for (const r of master) {
  if (r.off_boarded_at) continue; // active only
  const we = r["Work Email"]?.trim().toLowerCase();
  const pe = r["Personal Email"]?.trim().toLowerCase();
  const rec = {
    name: r["Name"]?.trim() || we || pe || "",
    work_email: r["Work Email"]?.trim() || null,
    personal_email: r["Personal Email"]?.trim() || null,
    employee_id: r.employee_id ? String(r.employee_id).trim() : null,
  };
  if (we && !masterByEmail.has(we)) masterByEmail.set(we, rec);
  if (pe && !masterByEmail.has(pe)) masterByEmail.set(pe, rec);
}

// ── Resolve each wanted row against employee_ids ─────────────────────────────
const toApply = []; // { employee_id, name, csvEmail, matchedVia, processor, column, targetEmail, row }
const alreadySet = []; // { csvEmail, processor, existing, csvValue, matches }
const noMatch = []; // { csvEmail, processor, targetEmail }
const toCreate = []; // { employee_id, name, work_email, personal_email, csvEmail, processor, column, targetEmail }
const cannotCreate = []; // no employee_ids row AND not resolvable on active_employees

for (const w of wanted.values()) {
  const column = w.processor === "hurupay" ? "hurupay_email" : "higlobe_email";

  // The CSV key is a WORK email. Resolve the person on the master list first so we
  // can also match their payout row by PERSONAL email (some rows are keyed that way).
  const m = masterByEmail.get(w.email);
  const masterWork = m?.work_email?.trim().toLowerCase() || w.email;
  const masterPersonal = m?.personal_email?.trim().toLowerCase() || null;

  let row = idsByWork.get(w.email) || idsByWork.get(masterWork);
  let matchedVia = "work_email";
  if (!row && masterPersonal) {
    row = idsByPersonal.get(masterPersonal);
    matchedVia = "personal_email";
  }
  if (!row) {
    row = idsByPersonal.get(w.email);
    if (row) matchedVia = "personal_email";
  }

  if (!row) {
    // No payout row for this person by email. If they're ACTIVE with a real
    // employee_id on the master list, we may create their payout row (reusing id).
    if (!m || !m.employee_id) {
      noMatch.push({
        csvEmail: w.email,
        processor: w.processor,
        targetEmail: w.targetEmail,
        reason: m ? "on master but no employee_id" : "not on active master list",
      });
      continue;
    }
    const idRow = idsByEmployeeId.get(m.employee_id);
    if (!idRow) {
      // id is free in employee_ids — safe to create.
      toCreate.push({
        employee_id: m.employee_id,
        name: m.name || w.email,
        work_email: m.work_email,
        personal_email: m.personal_email,
        csvEmail: w.email,
        processor: w.processor,
        column,
        targetEmail: w.targetEmail,
      });
    } else {
      // A payout row exists under this employee_id but its email didn't match this
      // person's work/personal email → the id is shared by a DIFFERENT person
      // (recycled/duplicate employee_id). NEVER write — would pay the wrong person.
      cannotCreate.push({
        csvEmail: w.email,
        processor: w.processor,
        targetEmail: w.targetEmail,
        reason:
          `employee_id ${m.employee_id} is held in employee_ids by a different person ` +
          `(${idRow.name?.trim() || idRow.work_email || idRow.personal_email})`,
      });
    }
    continue;
  }

  const existing = (row[column] ?? "").trim();
  if (existing) {
    alreadySet.push({
      employee_id: row.employee_id,
      csvEmail: w.email,
      name: row.name?.trim() || w.email,
      matchedVia,
      processor: w.processor,
      column,
      existing,
      csvValue: w.targetEmail,
      targetEmail: w.targetEmail,
      matches: existing.toLowerCase() === w.targetEmail.toLowerCase(),
      row,
    });
    continue; // never clobber (unless --overwrite-conflicts, handled below)
  }

  toApply.push({
    employee_id: row.employee_id,
    name: row.name?.trim() || w.email,
    csvEmail: w.email,
    matchedVia,
    processor: w.processor,
    column,
    targetEmail: w.targetEmail,
    isOverwrite: false,
    row,
  });
}

// With --overwrite-conflicts, promote the rows that hold a DIFFERENT value into
// the apply set (rows whose existing value already matches the CSV stay ignored —
// nothing to change there).
if (OVERWRITE_CONFLICTS) {
  for (const c of alreadySet) {
    if (c.matches) continue;
    toApply.push({
      employee_id: c.employee_id,
      name: c.name,
      csvEmail: c.csvEmail,
      matchedVia: c.matchedVia,
      processor: c.processor,
      column: c.column,
      targetEmail: c.targetEmail,
      isOverwrite: true,
      overwriteFrom: c.existing,
      row: c.row,
    });
  }
}

toApply.sort(
  (a, b) => a.processor.localeCompare(b.processor) || a.name.localeCompare(b.name),
);

// Dedupe toCreate by employee_id — a person can appear under both work & personal
// email as separate CSV keys, but we only insert ONE payout row per employee_id.
const toCreateById = new Map();
for (const c of toCreate) {
  const prev = toCreateById.get(c.employee_id);
  if (!prev) {
    toCreateById.set(c.employee_id, c);
  } else if (prev.processor !== c.processor || prev.targetEmail !== c.targetEmail) {
    // Conflicting instructions for the same person across two CSV rows — keep the
    // first, flag the collision so it's visible rather than silently dropped.
    prev._conflict = `also saw ${c.processor}:${c.targetEmail} for ${c.csvEmail}`;
  }
}
const creates = [...toCreateById.values()];
creates.sort((a, b) => a.processor.localeCompare(b.processor) || a.name.localeCompare(b.name));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — seed Hurupay/HiGlobe emails from ${CSV_PATH}\n`);
console.log("CSV parse:");
console.log(`  Hurupay rows (email target): ${hurupayRows}`);
console.log(`  HiGlobe rows (email target): ${higlobeRows}`);
console.log(`  distinct (email, processor) after last-wins dedupe: ${wanted.size}`);
console.log(`  skipped — not Hurupay/HiGlobe (Wise/x-codes/Jeeves/wires): ${skippedNonSeedable}`);
console.log(`  skipped — blank work-email cell: ${skippedNoEmailCell}`);
console.log(`  skipped — "To" is not an email (blank/numeric wire target): ${skippedNonEmailTarget}`);

const fills = toApply.filter((t) => !t.isOverwrite);
const overwrites = toApply.filter((t) => t.isOverwrite);
const conflicts = alreadySet.filter((a) => !a.matches);

console.log(`\nResolution:`);
console.log(`  WILL FILL (column empty): ${fills.length}`);
console.log(
  `  WILL OVERWRITE (differing value): ${overwrites.length}` +
    (OVERWRITE_CONFLICTS ? "" : `  (add --overwrite-conflicts to include the ${conflicts.length} conflicts)`),
);
console.log(`  already set & matching CSV (ignored): ${alreadySet.length - conflicts.length}`);
console.log(
  `  WILL CREATE payout row (active, no employee_ids row): ${creates.length}` +
    (CREATE_MISSING_ROWS ? "" : `  (add --create-missing-rows to include these)`),
);
console.log(`  cannot create (id already has a row under another email): ${cannotCreate.length}`);
console.log(`  no employee_ids row & not active-resolvable (skipped): ${noMatch.length}`);

const fillHuru = fills.filter((t) => t.processor === "hurupay");
const fillHigl = fills.filter((t) => t.processor === "higlobe");
console.log(`\nTo fill — HURUPAY (${fillHuru.length}) then HIGLOBE (${fillHigl.length}):\n`);
for (const t of fills) {
  const via = t.matchedVia === "personal_email" ? " [matched personal_email]" : "";
  console.log(
    `  ${t.processor.toUpperCase().padEnd(8)} ${t.name.padEnd(34)} ${t.csvEmail.padEnd(30)} → ${t.targetEmail}${via}`,
  );
}

if (OVERWRITE_CONFLICTS && overwrites.length) {
  console.log(`\nTo OVERWRITE — ${overwrites.length} (existing value differs from CSV):\n`);
  for (const t of overwrites) {
    console.log(
      `  ${t.processor.toUpperCase().padEnd(8)} ${t.name.padEnd(34)} ${t.overwriteFrom}  →  ${t.targetEmail}`,
    );
  }
} else if (conflicts.length) {
  console.log(`\nHeads up — ${conflicts.length} already have a DIFFERENT value (left untouched):`);
  for (const c of conflicts) {
    console.log(
      `  ${c.processor.toUpperCase().padEnd(8)} ${(c.name ?? c.csvEmail).padEnd(34)} existing=${c.existing}  csv=${c.csvValue}`,
    );
  }
}

if (creates.length) {
  const cHuru = creates.filter((c) => c.processor === "hurupay").length;
  const cHigl = creates.filter((c) => c.processor === "higlobe").length;
  console.log(
    `\nTo CREATE a payout row (active, no employee_ids row yet) — ${creates.length} ` +
      `(HURUPAY ${cHuru}, HIGLOBE ${cHigl})` +
      (CREATE_MISSING_ROWS ? ":" : " — NOT creating (pass --create-missing-rows):") +
      `\n`,
  );
  for (const c of creates) {
    console.log(
      `  ${c.processor.toUpperCase().padEnd(8)} ${c.name.padEnd(34)} ${(c.csvEmail).padEnd(30)} ` +
        `id=${c.employee_id}  → ${c.targetEmail}` +
        (c._conflict ? `   ⚠ ${c._conflict}` : ""),
    );
  }
}

if (cannotCreate.length) {
  console.log(`\nCannot auto-create — ${cannotCreate.length} (id already has a payout row under another email):`);
  for (const c of cannotCreate) {
    console.log(`  ${c.processor.toUpperCase().padEnd(8)} ${c.csvEmail.padEnd(30)} → ${c.targetEmail}   (${c.reason})`);
  }
}

if (noMatch.length) {
  console.log(`\nNo employee_ids row & not active-resolvable (skipped) — ${noMatch.length}:`);
  for (const n of noMatch.slice(0, 40)) {
    console.log(`  ${n.processor.toUpperCase().padEnd(8)} ${n.csvEmail.padEnd(30)} → ${n.targetEmail}  (${n.reason})`);
  }
  if (noMatch.length > 40) console.log(`  … and ${noMatch.length - 40} more`);
}

const willCreate = CREATE_MISSING_ROWS ? creates : [];

if (!APPLY) {
  console.log(
    "\nDry run only. Re-run with --apply to backup + update" +
      (CREATE_MISSING_ROWS ? " + create rows." : " (add --create-missing-rows to also create payout rows)."),
  );
  process.exit(0);
}

if (toApply.length === 0 && willCreate.length === 0) {
  console.log("\nNothing to fill or create. Done.");
  process.exit(0);
}

// ── Backup, then update ──────────────────────────────────────────────────────
const backupDir = path.join("references", "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(
  backupDir,
  `${new Date().toISOString().slice(0, 10)}_seed_hurupay_higlobe_emails.json`,
);
fs.writeFileSync(
  backupPath,
  JSON.stringify(
    toApply.map((t) => ({
      employee_id: t.employee_id,
      name: t.name,
      column: t.column,
      willSet: t.targetEmail,
      before: t.row,
    })),
    null,
    2,
  ),
);
console.log(`\nBacked up ${toApply.length} employee_ids rows (pre-update) → ${backupPath}`);

if (willCreate.length) {
  const createLogPath = path.join(
    backupDir,
    `${new Date().toISOString().slice(0, 10)}_seed_hurupay_higlobe_created_rows.json`,
  );
  fs.writeFileSync(createLogPath, JSON.stringify(willCreate, null, 2));
  console.log(`Recorded ${willCreate.length} rows to be CREATED → ${createLogPath}`);
}

let ok = 0;
let failed = 0;
for (const t of toApply) {
  if (t.isOverwrite) {
    // Existing (differing) value → replace unconditionally. Backed up above.
    const { data, error } = await supabase
      .from("employee_ids")
      .update({ [t.column]: t.targetEmail })
      .eq("employee_id", t.employee_id)
      .select("employee_id");
    if (error || !data?.length) {
      failed += 1;
      console.error(`  FAIL ${t.csvEmail} (${t.column}, overwrite): ${error?.message ?? "no row updated"}`);
    } else {
      ok += 1;
      console.log(`  OK   ${t.csvEmail} ${t.column} ${t.overwriteFrom} → ${t.targetEmail}`);
    }
    continue;
  }

  const { data, error } = await supabase
    .from("employee_ids")
    .update({ [t.column]: t.targetEmail })
    .eq("employee_id", t.employee_id)
    .is(t.column, null) // only if still unset (no clobber race)
    .select("employee_id");
  if (error) {
    failed += 1;
    console.error(`  FAIL ${t.csvEmail} (${t.column}): ${error.message}`);
  } else if (!data || data.length === 0) {
    // Column was empty-string rather than NULL, or filled since selection — retry
    // once guarding on empty string is not supported by .is(); re-check the row.
    const { data: cur } = await supabase
      .from("employee_ids")
      .select(`employee_id, ${t.column}`)
      .eq("employee_id", t.employee_id)
      .maybeSingle();
    const curVal = (cur?.[t.column] ?? "").trim();
    if (!curVal) {
      const retry = await supabase
        .from("employee_ids")
        .update({ [t.column]: t.targetEmail })
        .eq("employee_id", t.employee_id)
        .select("employee_id");
      if (retry.error || !retry.data?.length) {
        failed += 1;
        console.error(`  SKIP ${t.csvEmail} (${t.column}): ${retry.error?.message ?? "no row updated"}`);
      } else {
        ok += 1;
        console.log(`  OK   ${t.csvEmail} ${t.column} → ${t.targetEmail}`);
      }
    } else {
      failed += 1;
      console.error(`  SKIP ${t.csvEmail} (${t.column}): filled since selection ('${curVal}')`);
    }
  } else {
    ok += 1;
    console.log(`  OK   ${t.csvEmail} ${t.column} → ${t.targetEmail}`);
  }
}
console.log(`\nDone (updates): ${ok} filled, ${failed} failed/skipped. Backup at ${backupPath}`);

// ── Create missing payout rows ───────────────────────────────────────────────
let created = 0;
let createFailed = 0;
if (willCreate.length) {
  console.log(`\nCreating ${willCreate.length} payout rows (reusing real employee_id from active_employees):\n`);
  for (const c of willCreate) {
    // Re-check nothing appeared under this id/email since selection (idempotent).
    const { data: existing } = await supabase
      .from("employee_ids")
      .select("employee_id")
      .or(
        [
          `employee_id.eq.${c.employee_id}`,
          c.work_email ? `work_email.ilike.${c.work_email}` : null,
        ]
          .filter(Boolean)
          .join(","),
      )
      .limit(1);
    if (existing && existing.length) {
      // A row now exists — fall back to an in-place update of the email column.
      const { data: upd, error: updErr } = await supabase
        .from("employee_ids")
        .update({ [c.column]: c.targetEmail })
        .eq("employee_id", c.employee_id)
        .is(c.column, null)
        .select("employee_id");
      if (updErr || !upd?.length) {
        createFailed += 1;
        console.error(`  SKIP ${c.csvEmail}: row appeared since selection (${updErr?.message ?? "not empty"})`);
      } else {
        created += 1;
        console.log(`  OK   ${c.csvEmail} (row appeared → filled ${c.column}) → ${c.targetEmail}`);
      }
      continue;
    }

    const insertRow = {
      employee_id: c.employee_id,
      name: c.name,
      work_email: c.work_email,
      personal_email: c.personal_email,
      [c.column]: c.targetEmail,
    };
    const { error: insErr } = await supabase.from("employee_ids").insert(insertRow);
    if (insErr) {
      createFailed += 1;
      console.error(`  FAIL ${c.csvEmail} (create): ${insErr.message}`);
    } else {
      created += 1;
      console.log(`  OK   ${c.csvEmail} CREATED id=${c.employee_id} ${c.column} → ${c.targetEmail}`);
    }
  }
  console.log(`\nDone (creates): ${created} created, ${createFailed} failed/skipped.`);
}

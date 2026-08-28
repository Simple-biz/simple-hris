/**
 * ONE-OFF import: the master sheet's "Offboarded" tab, exported as JSON, into
 * the `offboarded_sheet` ledger as `origin='google_sheet'` rows.
 *
 *   node scripts/import-offboarded-from-json.mjs            # DRY RUN — reports, writes nothing
 *   node scripts/import-offboarded-from-json.mjs --apply    # writes (after a backup)
 *   node scripts/import-offboarded-from-json.mjs --apply --file <path>
 *
 * Requires scripts/apply-offboarded-origin-migration.mjs to have run first —
 * this writes `origin` explicitly and will fail loudly without the column.
 *
 * WHY THIS IS SAFE TO RUN AGAINST THE LEDGER THAT WAS CLOSED TO THE SHEET
 * ----------------------------------------------------------------------
 * `/api/cron/sync-offboarded-from-sheet` is a 410 tombstone: offboarding does
 * not depend on the spreadsheet, and `offboarded_sheet` is HRIS-owned. What got
 * retired was a RECURRING, REPLACING sync — DELETE-all + re-INSERT from a
 * hand-edited tab. Its specific failure was that a typo could not be fixed:
 * franm@simple.biz was stamped 2027-04-20 (a year-typo for 2026), and every
 * correction to the DB was copied back over on the next run.
 *
 * This import is the opposite shape on both axes, and each is enforced here
 * rather than merely intended:
 *
 *   1. ONE-OFF. Nothing schedules it. It is a script with a manual --apply gate,
 *      not a route and not a cron.
 *   2. INSERT-ONLY. It never UPDATEs and never DELETEs. A person already on the
 *      ledger is skipped, full stop. That is what makes hand-corrections
 *      durable — including franm@'s, whose row (id 45266) is currently the
 *      correct 2026-04-20 while THIS VERY EXPORT still carries the 2027 typo.
 *      The import must leave her alone, and the run report says so by name.
 *
 * DATES ARE SANITIZED, NEVER GUESSED
 * ----------------------------------
 * The export's date column is free text and dirty: 301 rows are unparseable
 * (`6//3/2026`, `July 9, 2026`) and one is future-dated. A future off-board date
 * is uniquely dangerous — every recency window downstream is a lower-bound
 * compare, so a 2027 stamp sails through all of them at once
 * (src/lib/roster/offboard-date-sanity.ts). Both parsing and the future check
 * mirror `normalizeMasterDate` + `sanitizeOffboardDay` exactly, and anything
 * that fails either lands as NULL rather than a guess. A NULL date is a record
 * whose consumers fall back to evidence that cannot be typo'd; a wrong date is
 * a record that lies confidently for months.
 *
 * WHAT IT REFUSES TO DECIDE
 * -------------------------
 * `off_boarded_reason` is stored VERBATIM. The column is already free text
 * holding 30 distinct values in both casings, and every consumer that matters
 * reads it through an ALLOWLIST of canonical departures
 * (src/lib/payment-catalog/catalog-roster-visibility.ts) — so an unrecognised
 * sheet label keeps the person visible, which is the safe direction. Shoehorning
 * these into the enum here would invent departures the sheet never asserted.
 *
 * `off_boarded_by` stays NULL: nobody in the HRIS pressed a button for these.
 * Attributing them to an actor would fabricate an audit trail.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const apply = process.argv.includes("--apply");
const fileArg = process.argv.indexOf("--file");
const JSON_PATH =
  fileArg > -1 && process.argv[fileArg + 1]
    ? process.argv[fileArg + 1]
    : "references/data/Global Master List (PH) - Offboarded.json";

const BACKUP_DIR = "references/backups";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** PostgREST truncates at db.max-rows (1000) even with .range(), so page. */
async function selectAllPaged(table, columns, modify) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (modify) q = modify(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Byte-for-byte the parsing rules of `normalizeMasterDate`
 * (src/lib/roster/master-date.ts). Kept in lockstep deliberately: a date that
 * parses here but not there — or the reverse — is a person aged off one surface
 * and kept on another.
 */
function normalizeMasterDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const year = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `sanitizeOffboardDay` (src/lib/roster/offboard-date-sanity.ts): a day more
 *  than one day in the future is garbage, and uniquely dangerous garbage. */
function sanitizeOffboardDay(day, now = new Date()) {
  if (!day) return null;
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return day > tomorrow ? null : day;
}

/** The export's Start Date column occasionally carries the REST OF THE ROW after
 *  a tab (adjacent columns bled into the cell). Take the first segment — that is
 *  reading the delimiter, not guessing the value — and treat 'N/A' as absent.
 *  Otherwise stored verbatim, matching how existing rows hold "05/18/26". */
function cleanStartDate(raw) {
  const first = String(raw ?? "").split(/[\t\n\r]/)[0].trim();
  if (!first || first.toUpperCase() === "N/A") return null;
  return first;
}

async function main() {
  console.log(apply ? "APPLY — this will WRITE.\n" : "DRY RUN — nothing will be written.\n");

  const raw = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${JSON_PATH} is not a JSON array.`);
  console.log(`Source: ${JSON_PATH}  (${raw.length} rows)`);

  // Fail loudly if the migration has not run — writing without `origin` would
  // silently produce rows the merged tab mislabels "HRIS".
  {
    const { error } = await sb.from("offboarded_sheet").select("origin").limit(1);
    if (error) {
      console.error(
        `\noffboarded_sheet.origin is not readable: ${error.message}\n` +
          "Run scripts/apply-offboarded-origin-migration.mjs first.",
      );
      process.exit(1);
    }
  }

  const existing = await selectAllPaged(
    "offboarded_sheet",
    "id, personal_email, work_email, name, off_boarded_at, off_boarded_reason, off_boarded_by, origin",
  );
  const active = await selectAllPaged("active_employees", '"Work Email","Personal Email","Department"');
  console.log(`Ledger: ${existing.length} rows   Active roster: ${active.length} rows\n`);

  const byPersonal = new Map();
  const byWork = new Map();
  for (const r of existing) {
    const p = norm(r.personal_email);
    const w = norm(r.work_email);
    if (p && !byPersonal.has(p)) byPersonal.set(p, r);
    if (w && !byWork.has(w)) byWork.set(w, r);
  }
  const activeByWork = new Map();
  const activeByPersonal = new Map();
  for (const r of active) {
    const w = norm(r["Work Email"]);
    const p = norm(r["Personal Email"]);
    if (w && !activeByWork.has(w)) activeByWork.set(w, r);
    if (p && !activeByPersonal.has(p)) activeByPersonal.set(p, r);
  }

  const inserts = [];
  const skippedPersonal = [];
  const skippedWork = [];
  const refusedNoEmail = [];
  const datesNulled = [];
  const activeCollisions = [];

  for (const row of raw) {
    const personal = norm(row["Personal Email"]);
    const work = norm(row["Work Email"]);
    const name = String(row["Name"] ?? "").trim() || null;

    // personal_email is the person key here — work emails are recycled across
    // humans (markg@simple.biz has held at least four). A row with neither is
    // not a record of anybody.
    if (!personal) {
      refusedNoEmail.push({ name, work });
      continue;
    }

    // Already on the ledger, keyed on the stable identity. Skip — never update.
    if (byPersonal.has(personal)) {
      skippedPersonal.push({ name, personal, existing: byPersonal.get(personal) });
      continue;
    }

    // The work email is on the ledger under a DIFFERENT personal email. That is
    // either the same person with a new inbox, or a recycled work email held by
    // someone else entirely — the export cannot tell us which. Skipping is the
    // only safe read: a missing historical record is cosmetic, while a second
    // off-board record on a live work email becomes off-board EVIDENCE against
    // whoever holds it now (src/lib/roster/offboard-evidence.ts).
    if (work && byWork.has(work)) {
      skippedWork.push({ name, work, personal, existing: byWork.get(work) });
      continue;
    }

    const rawDate = row["Offboarded Date"];
    const parsed = normalizeMasterDate(rawDate);
    const day = sanitizeOffboardDay(parsed);
    if (String(rawDate ?? "").trim() && !day) {
      datesNulled.push({ name, work: work || personal, raw: String(rawDate).trim(), parsed });
    }

    const hit = activeByWork.get(work) ?? activeByPersonal.get(personal);
    if (hit) {
      activeCollisions.push({
        name,
        work: work || "(none)",
        personal,
        department: (hit["Department"] ?? "").trim() || "(none)",
        date: day ?? "(no date)",
        reason: String(row["Offboard Reason"] ?? "").trim() || "(blank)",
      });
    }

    inserts.push({
      personal_email: row["Personal Email"].trim(),
      work_email: work ? row["Work Email"].trim() : null,
      name,
      // FIELD1 is the export's department column.
      department: String(row["FIELD1"] ?? "").trim() || null,
      start_date: cleanStartDate(row["Start Date"]),
      // Day-precision, midnight UTC — the shape the sheet-era rows already use.
      off_boarded_at: day ? `${day}T00:00:00+00:00` : null,
      // Verbatim. The column is free text by design and every consumer that
      // matters reads it through an allowlist, so an unrecognised label keeps
      // the person visible rather than hiding them.
      off_boarded_reason: String(row["Offboard Reason"] ?? "").trim() || null,
      off_boarded_note: null,
      // Nobody in the HRIS did this. Inventing an actor would fabricate audit.
      off_boarded_by: null,
      origin: "google_sheet",
    });
  }

  console.log("─".repeat(72));
  console.log(`  to INSERT (new, origin='google_sheet') : ${inserts.length}`);
  console.log(`  skipped — already on the ledger        : ${skippedPersonal.length}`);
  console.log(`  skipped — work email already on ledger : ${skippedWork.length}`);
  console.log(`  refused — no personal email            : ${refusedNoEmail.length}`);
  console.log(`  dates NULLED (unparseable or future)   : ${datesNulled.length}`);
  console.log("─".repeat(72));

  // franm@ is the named reason the sheet sync was retired. Prove, every run,
  // that the import leaves her hand-fixed row alone.
  const franmSource = raw.find((r) => norm(r["Work Email"]) === "franm@simple.biz");
  const franmLedger = byWork.get("franm@simple.biz");
  if (franmSource || franmLedger) {
    console.log("\nfranm@simple.biz (the typo the sheet sync was retired over):");
    console.log(`  export says : ${String(franmSource?.["Offboarded Date"] ?? "(absent)")}`);
    console.log(`  ledger says : ${String(franmLedger?.off_boarded_at ?? "(absent)")}`);
    const willInsert = inserts.some((i) => norm(i.work_email) === "franm@simple.biz");
    console.log(`  action      : ${willInsert ? "!!! WOULD INSERT — STOP" : "skipped (row untouched)"}`);
    if (willInsert) {
      console.error("\nRefusing to run: the import would create a second franm@ record.");
      process.exit(1);
    }
  }

  if (datesNulled.length) {
    console.log(`\nDates stored as NULL rather than guessed (${datesNulled.length}), first 20:`);
    for (const d of datesNulled.slice(0, 20)) {
      console.log(`  ${String(d.work).padEnd(30)} ${JSON.stringify(d.raw)}`);
    }
  }

  if (activeCollisions.length) {
    console.log(
      `\n!! REVIEW — ${activeCollisions.length} incoming record(s) name someone on the ACTIVE roster.`,
    );
    console.log(
      "   These become off-board evidence. Downstream guards are built for exactly this\n" +
        "   (the record must post-date the person's Start Date, they must have no hours in\n" +
        "   the current cycle, and the reason must be a canonical departure — a suspension\n" +
        "   like Temporary Pause never counts), so a re-hire stays visible. Read them anyway:\n",
    );
    for (const c of activeCollisions) {
      console.log(`   ${c.name ?? "(no name)"}`);
      console.log(`     ${c.work}  ·  active in ${c.department}`);
      console.log(`     off-boarded ${c.date}  ·  ${c.reason}`);
    }
  }

  if (skippedWork.length) {
    console.log(`\nSkipped on a work-email collision (${skippedWork.length}), first 20:`);
    for (const s of skippedWork.slice(0, 20)) {
      console.log(
        `  ${String(s.work).padEnd(28)} incoming ${s.personal}  vs ledger ${s.existing.personal_email}`,
      );
    }
  }

  if (refusedNoEmail.length) {
    console.log(`\nRefused for having no personal email (${refusedNoEmail.length}):`);
    for (const r of refusedNoEmail) console.log(`  ${r.name ?? "(no name)"}  ${r.work || "(no work email)"}`);
  }

  if (!inserts.length) {
    console.log("\nNothing to insert.");
    return;
  }

  if (!apply) {
    console.log("\nDry run — re-run with --apply to write.");
    return;
  }

  // Backup BEFORE the write. Insert-only means nothing is overwritten, but the
  // pre-state is what makes the insert reversible by id difference.
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `offboarded_sheet_pre_json_import_${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(existing, null, 2), "utf8");
  console.log(`\nBackup written: ${backupPath}  (${existing.length} rows)`);

  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const batch = inserts.slice(i, i + CHUNK);
    const { data, error } = await sb.from("offboarded_sheet").insert(batch).select("id");
    if (error) {
      console.error(`\nINSERT failed at row ${i}: ${error.message}`);
      console.error(`${written} row(s) were written before the failure; the backup above is the pre-state.`);
      process.exit(1);
    }
    written += data.length;
    console.log(`  inserted ${written}/${inserts.length}`);
  }

  // Read back, rather than trusting the write. An empty result is not proof of
  // success (memory/postgrest-head-true-hides-missing-table) — count the rows.
  const after = await selectAllPaged("offboarded_sheet", "id, origin");
  const bySheet = after.filter((r) => r.origin === "google_sheet").length;
  const byHris = after.filter((r) => r.origin === "hris").length;
  console.log(`\nLedger now: ${after.length} rows  (google_sheet ${bySheet} · hris ${byHris})`);
  console.log(`Expected  : ${existing.length + inserts.length} rows`);
  if (after.length !== existing.length + inserts.length) {
    console.error("Row count does not match the expectation — investigate before trusting the tab.");
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});

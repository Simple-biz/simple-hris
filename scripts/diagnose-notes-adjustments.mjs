/**
 * READ-ONLY diagnostic: why a Payroll Notes "Adjustment" cell does (or does
 * not) reach the Payroll Wizard's Additions "Adj." column.
 *
 * Replays the bridge's exact rules (src/lib/payroll/adjustment-bridge.ts +
 * pullNotesAdjustments in src/components/PayrollWizard.tsx) against every
 * board row, the CURRENT Hubstaff upload, and the persisted additions blob:
 *   1. row not Done                     (done rows are skipped by the pull)
 *   2. worker_email linked              (null = row never applies)
 *   3. Adjustment parses as pure amount (prose like "+500 bonus" is rejected)
 *   4. worker HAS a row in this week's Hubstaff CSV (else nothing to key to)
 *   5. is the amount actually IN payroll.wizard.additions.<source_file>?
 *
 * Usage: node scripts/diagnose-notes-adjustments.mjs
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

/** Mirror of parseAdjustmentAmount (adjustment-bridge.ts). */
function currencyFromMarker(marker) {
  const m = (marker ?? "").toUpperCase();
  if (m === "") return null;
  if (m === "COP" || m === "$COP") return "COP";
  if (m === "$" || m === "USD" || m === "US$") return "USD";
  if (m === "₱" || m === "PHP" || m === "P") return "PHP";
  return null;
}
function parseAdjustmentAmount(text) {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const m =
    /^([+-])?\s*(\$COP|US\$|COP|USD|PHP|₱|\$|P)?\s*([\d,]+(?:\.\d+)?)\s*(\$COP|US\$|COP|USD|PHP|₱|\$|P)?$/i.exec(t);
  if (!m) return null;
  const prefix = currencyFromMarker(m[2]);
  const suffix = currencyFromMarker(m[4]);
  if (prefix && suffix && prefix !== suffix) return null;
  const value = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { amount: m[1] === "-" ? -value : value, currency: prefix ?? suffix ?? "PHP" };
}

// ── The live pay cycle ──────────────────────────────────────────────────────
const up = await supabase
  .from("hubstaff_uploads")
  .select("id, source_file, uploaded_at, is_current")
  .eq("is_current", true)
  .limit(1)
  .maybeSingle();
if (up.error) console.error("hubstaff_uploads:", up.error.message);
const uploadId = up.data?.id ?? null;
const sourceFile = up.data?.source_file ?? null;

const csv = new Map(); // norm email -> raw email
if (uploadId) {
  for (let from = 0; ; from += 1000) {
    const page = await supabase
      .from(process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours")
      .select("*")
      .eq("upload_id", uploadId)
      .range(from, from + 999);
    if (page.error) {
      console.error("hubstaff_hours:", page.error.message);
      break;
    }
    const rows = page.data ?? [];
    for (const r of rows) {
      // The hours table keeps the CSV's own headers — find the email-ish column.
      const raw = String(r.Email ?? r.email ?? r["Member email"] ?? "").trim();
      if (!raw || !raw.includes("@")) continue;
      if (!csv.has(raw.toLowerCase())) csv.set(raw.toLowerCase(), raw);
    }
    if (rows.length < 1000) break;
  }
}

// ── The persisted additions blob for that cycle ─────────────────────────────
let blobOverrides = {};
let blobFound = false;
if (sourceFile) {
  const s = await supabase
    .from("app_settings")
    .select("key, value, updated_at")
    .eq("key", `payroll.wizard.additions.${sourceFile}`)
    .maybeSingle();
  if (s.error) console.error("app_settings:", s.error.message);
  if (s.data?.value) {
    blobFound = true;
    try {
      const parsed = JSON.parse(s.data.value);
      blobOverrides = parsed.bonusOverrides ?? {};
      console.log(`\nAdditions blob: payroll.wizard.additions.${sourceFile}`);
      console.log(`  saved ${s.data.updated_at} · bonusOverrides entries: ${Object.keys(blobOverrides).length}`);
    } catch (e) {
      console.log("  blob parse failed:", e.message);
    }
  } else {
    console.log(`\nAdditions blob: payroll.wizard.additions.${sourceFile} — NOT SAVED (no row)`);
  }
}
const blobByNorm = new Map(Object.entries(blobOverrides).map(([k, v]) => [k.trim().toLowerCase(), v]));

// ── The board ───────────────────────────────────────────────────────────────
const rowsRes = await supabase
  .from("payroll_wizard_notes")
  .select("id, note_date, payroll_clerk, done, worker, worker_email, adjustment, notes, week_start, created_at, updated_at")
  .order("updated_at", { ascending: true })
  .range(0, 1999);
if (rowsRes.error) {
  console.error("payroll_wizard_notes read failed:", rowsRes.error.message);
  process.exit(1);
}
const rows = rowsRes.data ?? [];
const withText = rows.filter((r) => (r.adjustment ?? "").trim() !== "");

console.log(`\nLive cycle: ${sourceFile ?? "(none)"} · upload ${uploadId ?? "-"} · ${csv.size} CSV emails`);
console.log(`Board rows: ${rows.length} · with an Adjustment cell filled: ${withText.length}\n`);

// ── The cycle's pay week, and its dispatch lock ─────────────────────────────
/** Mirror of payWeekStartFromSourceFile (adjustment-bridge.ts). */
function payWeekStartFromSourceFile(file) {
  const m = /(\d{4}-\d{2}-\d{2})_to_\d{4}-\d{2}-\d{2}/.exec(file ?? "");
  if (!m) return null;
  const [y, mo, d] = m[1].split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}
const cycleWeek = payWeekStartFromSourceFile(sourceFile);
let locked = false;
if (sourceFile) {
  const l = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", `payroll.dispatch_lock.${sourceFile}`)
    .maybeSingle();
  const v = (l.data?.value ?? "").trim();
  locked = v === "true" || (v.startsWith("{") && JSON.parse(v).locked === true);
}
console.log(`Cycle pay week: ${cycleWeek ?? "(unparseable filename)"} · dispatch lock: ${locked ? "LOCKED" : "unlocked"}`);

const buckets = { applies: [], recovered: [], history: [], future: [], unlinked: [], unparseable: [], notInCsv: [] };
for (const r of withText) {
  const text = (r.adjustment ?? "").trim();
  const email = (r.worker_email ?? "").trim().toLowerCase();
  const parsed = parseAdjustmentAmount(text);
  const label = `${(r.worker ?? "(no worker)").slice(0, 26).padEnd(26)} ${text.padEnd(12)} wk=${r.week_start ?? "null"}`;
  const isCycleWeek = cycleWeek !== null && r.week_start === cycleWeek;
  if (!email) buckets.unlinked.push(label);
  else if (!parsed) buckets.unparseable.push(label);
  else if (cycleWeek !== null && r.week_start !== null && r.week_start > cycleWeek) buckets.future.push(label);
  else if (r.done && !isCycleWeek) buckets.history.push(label);
  else if (csv.size > 0 && !csv.has(email)) buckets.notInCsv.push(`${label} <${email}>`);
  else {
    const line = `${label} <${email}> → ${parsed.amount} ${parsed.currency}${blobByNorm.has(email) ? "" : "  [not in blob]"}`;
    // NEW rule: a Done row stamped to the week being paid stays eligible, so a
    // lost apply is recovered on the next step entry.
    (r.done ? buckets.recovered : buckets.applies).push(line);
  }
}

const show = (title, list, cap = 200) => {
  console.log(`── ${title}: ${list.length}`);
  for (const l of list.slice(0, cap)) console.log(`   ${l}`);
  if (list.length > cap) console.log(`   … +${list.length - cap} more`);
  console.log("");
};
show("PRE-FILLS on step entry — open rows for this cycle", buckets.applies, 12);
show("RECOVERED by the fix — Done rows stamped to the week being paid", buckets.recovered);
show("History — Done under an earlier week, never re-applied (correct)", buckets.history, 6);
show("Staged for an upcoming week — excluded from this cycle (correct)", buckets.future, 12);
show("Worker not linked (worker_email null) — now flagged on the board", buckets.unlinked);
show("Adjustment is not a plain amount — now flagged on the board", buckets.unparseable);
show("Worker has no row in the live Hubstaff CSV", buckets.notInCsv, 20);

// Same worker, same week, several amounts → only the newest is applied.
const byWorkerWeek = new Map();
for (const r of withText) {
  const email = (r.worker_email ?? "").trim().toLowerCase();
  if (!email || !parseAdjustmentAmount(r.adjustment)) continue;
  if (r.done && r.week_start !== cycleWeek) continue;
  if (cycleWeek !== null && r.week_start !== null && r.week_start > cycleWeek) continue;
  const k = `${email}|${r.week_start}`;
  byWorkerWeek.set(k, [...(byWorkerWeek.get(k) ?? []), `${r.worker ?? email}=${(r.adjustment ?? "").trim()}`]);
}
const dupes = [...byWorkerWeek.entries()].filter(([, v]) => v.length > 1);
show("COMPETING amounts (same worker+week, only the newest applies)", dupes.map(([k, v]) => `${k}  ${v.join("  |  ")}`));

// The gap that actually matters: an amount the board holds for the week being
// paid that the wizard's SAVED additions do not (the newest row wins per worker).
const boardWinner = new Map(); // norm email -> {name, amount}
for (const r of withText) {
  const email = (r.worker_email ?? "").trim().toLowerCase();
  const parsed = parseAdjustmentAmount(r.adjustment);
  if (!email || !parsed) continue;
  if (r.week_start !== cycleWeek) continue;
  if (csv.size > 0 && !csv.has(email)) continue;
  boardWinner.set(email, { name: r.worker ?? email, amount: parsed.amount });
}
const gap = [...boardWinner.entries()].filter(([e]) => !blobByNorm.has(e));
const drift = [...boardWinner.entries()].filter(
  ([e, v]) => blobByNorm.has(e) && Math.abs(Number(blobByNorm.get(e)) - v.amount) > 0.01,
);
show(
  "ON THE BOARD but NOT in the wizard's saved additions (would be paid short)",
  gap.map(([e, v]) => `${v.name.slice(0, 26).padEnd(26)} ${String(v.amount).padEnd(12)} <${e}>`),
);
show(
  "DIFFERENT amount saved vs. board (board is newer)",
  drift.map(([e, v]) => `${v.name.slice(0, 26).padEnd(26)} board=${v.amount}  saved=${blobByNorm.get(e)}  <${e}>`),
);
console.log(
  `board holds ${boardWinner.size} amounts for week ${cycleWeek} · blob holds ${blobByNorm.size} · cycle ${locked ? "LOCKED (auto-pull suspended until Unlock in Validation)" : "unlocked"}`,
);

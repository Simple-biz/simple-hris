/**
 * juliar@simple.biz's approved 2026-09-10 time adjustment carries a stored
 * `approved_hours` computed against the WRONG DAY. Clearing it lets the one shared
 * rule derive the correct total (Kane, 2026-09-15: "I want the time adjustment to
 * actually change her hours ... it should add her hours that she was approved off").
 *
 * THE DEFECT
 *
 *   time_adjustment_requests/002e9630-6875-4314-9cbf-61425dc23372
 *     adjust_date        2026-09-10  (a THURSDAY)
 *     requested_segments [{ time_in 17:10, time_out 17:15 }]  -> 5 minutes
 *     requested_hours    0.08333...
 *     approved_hours     7.28333...   <-- WRONG
 *
 *   Her tracked hours that week (simple-biz_daily_report_2026-09-06_to_2026-09-12.csv):
 *     sun 0.0000  mon 3.5789  tue 9.3419  wed 8.2536
 *     thu 8.5933  <-- 2026-09-10, the day the request names
 *     fri 7.2053  <-- 2026-09-11
 *     sat 1.0208
 *
 *   7.2 + 0.08333 == 7.28333 exactly. The stored total was computed from FRIDAY's
 *   7:12 plus the requested 5 minutes, for a request filed against THURSDAY. That is
 *   the deleted `timeAdjustmentHoursPrefill` reading one day off.
 *
 * WHY THIS MATTERS - IT IS A PAY CUT, NOT A PAY RISE
 *
 * `approvedAdjustmentDayHours` rule 1: a stored `approved_hours` WINS OUTRIGHT and is
 * SET-semantics - it REPLACES the tracked seconds for that date. So 7.2833 against a
 * tracked 8.5933 is a delta of -1.3100 h. Re-locking the 2026-09-06->09-12 week with
 * this row intact would have REDUCED her pay by ~PHP 366.80 at her corrected PHP 280
 * rate, which is the opposite of what was asked.
 *
 * THE FIX - FIX THE PRODUCER'S OUTPUT, DO NOT LOOSEN THE RULE
 *
 * Rule 1 stays exactly as it is: a stored total is a human's statement and is never
 * recomputed. What is wrong here is the STORED VALUE, not the rule that honours it.
 * Setting `approved_hours` to NULL drops the row through to rule 2 - segments present,
 * so the day becomes `tracked + requested_hours` = 8.5933 + 0.0833 = 8.6767 - which is
 * the post-2026-09-15 design (Accounting approves with NO hours; the total is derived
 * at read time) and, unlike a frozen number, follows any later Hubstaff correction to
 * the same day.
 *
 * Deliberately NOT done: writing 8.6767 into `approved_hours`. That would re-freeze a
 * total on a money path and re-create the exact class of defect being fixed here.
 *
 * SCOPE: this ONE row. The paged audit over all 10 rows in the table found no other
 * row whose stored total sits below its day's tracked hours (`adriant@` 2026-05-08 is
 * a legacy segment-less DAY TOTAL, correctly stored, and is left alone).
 *
 * AFTER THIS RUNS: re-lock the 2026-09-06->09-12 week in the Payroll Wizard, or
 * disbursement_records keeps 37.99 h. The re-lock also applies her corrected PHP 280
 * rate (scripts/fix-juliar-rate-279-99.mts).
 * WARNING: upsertPaystubDispatchQueue re-stages money onto PAID rows on a re-lock
 * (OPEN since 2026-08-26). Her row is `pending`, but the re-lock touches the whole week.
 *
 * Usage:
 *   node --import tsx scripts/fix-juliar-adjustment-wrong-day-total.mts           # dry run
 *   node --import tsx scripts/fix-juliar-adjustment-wrong-day-total.mts --apply   # write
 *
 * A SELECT backup of the row is written to references/backups/ BEFORE any write.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ROW_ID = "002e9630-6875-4314-9cbf-61425dc23372";
const EMAIL = "juliar@simple.biz";
const ADJUST_DATE = "2026-09-10";
const BAD_STORED = 7.283333333333333;
const TRACKED_THU = 8.5933; // 8:35:36
const EPS = 1e-6;

const { data: rows, error } = await sb.from("time_adjustment_requests").select("*").eq("id", ROW_ID);
if (error) {
  console.error(`Read failed: ${error.message}`);
  process.exit(1);
}
const row = (rows ?? [])[0] as Record<string, any> | undefined;
if (!row) {
  console.error(`Row ${ROW_ID} not found - refusing to guess.`);
  process.exit(1);
}

const backupPath = "references/backups/2026-09-15_juliar_adjustment_wrong_day_total.json";
writeFileSync(backupPath, JSON.stringify({ taken_at: new Date().toISOString(), row }, null, 2));
console.log(`Backup written: ${backupPath}`);

// -- Guards: refuse on anything but the exact state this script was written for --
if (row.work_email !== EMAIL) {
  console.error(`Row belongs to ${row.work_email}, not ${EMAIL}. Refusing.`);
  process.exit(1);
}
if (row.adjust_date !== ADJUST_DATE) {
  console.error(`Row adjust_date is ${row.adjust_date}, expected ${ADJUST_DATE}. Refusing.`);
  process.exit(1);
}
if (row.approved_hours == null) {
  console.log("approved_hours is already NULL - nothing to do.");
  process.exit(0);
}
if (Math.abs(Number(row.approved_hours) - BAD_STORED) > 1e-4) {
  console.error(
    `approved_hours is ${row.approved_hours}, expected ${BAD_STORED}. ` +
      `Someone changed it since this script was written - re-probe, do not run.`,
  );
  process.exit(1);
}
if ((row.requested_segments ?? []).length === 0) {
  console.error(
    "Row has NO requested_segments. Clearing approved_hours would make it apply NOTHING " +
      "(rule 3: a segment-less row stored a legacy DAY TOTAL). Refusing.",
  );
  process.exit(1);
}
const requested = Number(row.requested_hours);
if (!Number.isFinite(requested) || requested <= 0) {
  console.error(`requested_hours is ${row.requested_hours} - rule 2 would apply nothing. Refusing.`);
  process.exit(1);
}
// The whole premise: the stored total must actually sit BELOW the tracked day.
if (!(Number(row.approved_hours) < TRACKED_THU - EPS)) {
  console.error(
    `Stored ${row.approved_hours} is not below tracked ${TRACKED_THU} - the premise of this ` +
      `fix does not hold. Refusing.`,
  );
  process.exit(1);
}

const derived = TRACKED_THU + requested;
console.log("\nCurrent state:");
console.log(`  ${EMAIL}  ${ADJUST_DATE} (Thursday)  status=${row.status}`);
console.log(`  requested_segments : ${JSON.stringify(row.requested_segments)}`);
console.log(`  requested_hours    : ${requested.toFixed(4)}`);
console.log(`  approved_hours     : ${Number(row.approved_hours).toFixed(4)}  <-- from FRIDAY's 7.2053 + 0.0833`);
console.log(`  tracked Thursday   : ${TRACKED_THU.toFixed(4)}`);
console.log(`  => applying as stored: ${(Number(row.approved_hours) - TRACKED_THU).toFixed(4)} h  (A PAY CUT)`);
console.log(`  => after this fix   : ${derived.toFixed(4)} h, delta +${requested.toFixed(4)} h`);

console.log("\nPlanned write:");
console.log(`  UPDATE time_adjustment_requests/${ROW_ID} SET approved_hours = NULL`);
console.log("  (rule 2 then derives tracked + requested at read time, on every surface)");

if (!APPLY) {
  console.log("\nDRY RUN - nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const upd = await sb
  .from("time_adjustment_requests")
  .update({ approved_hours: null })
  .eq("id", ROW_ID)
  .not("approved_hours", "is", null) // compare-and-swap: refuse if it moved under us
  .select();
if (upd.error) {
  console.error(`Update FAILED: ${upd.error.message}`);
  process.exit(1);
}
if ((upd.data ?? []).length !== 1) {
  console.error(`Update matched ${(upd.data ?? []).length} rows, expected 1. Value moved - stopping.`);
  process.exit(1);
}
console.log(`  OK approved_hours cleared; the day now derives to ${derived.toFixed(4)} h`);
console.log("\nNEXT: re-lock the 2026-09-06->09-12 week in the Payroll Wizard.");

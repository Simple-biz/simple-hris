/**
 * READ-ONLY verifier: runs the REAL `listRecentlyOffboardedPeople()` — the
 * exact production function behind /api/manager/transfer-candidates?offboarded=1
 * (the KPI calculators' "Offboarded" picker group) — from the command line.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-offboarded-people.mts [--week=YYYY-MM-DD] [email ...]
 *
 * --week=YYYY-MM-DD: also apply the calculators' week-scoping filter
 * (offboardedRelevantToWeek) and show who a calculator viewing that pay week
 * would actually offer vs. hide.
 *
 * Optional emails: assert each one appears in the (week-filtered) result under
 * any identity column, printing its resolved row; exits 1 if any is missing.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { listRecentlyOffboardedPeople } = await import("../src/lib/roster/recently-offboarded");
const { offboardedRelevantToWeek } = await import("../src/lib/roster/offboarded-week-relevance");

const args = process.argv.slice(2);
const weekArg = args.find((a) => a.startsWith("--week="))?.slice("--week=".length) ?? null;
if (weekArg && !/^\d{4}-\d{2}-\d{2}$/.test(weekArg)) {
  console.error(`invalid --week value: ${weekArg} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const { people, hoursWeekFloor, error } = await listRecentlyOffboardedPeople();
if (error) {
  console.error(`ERROR: ${error}`);
  process.exit(1);
}
console.log(`hours-evidence window floor: ${hoursWeekFloor ?? "(none)"}`);

const fmt = (p: (typeof people)[number]) =>
  `${p.off_boarded_at ?? "(no date)"} · ${p.name} [${p.department ?? "—"}] work=${p.work_email ?? "—"} hub=${p.hubstaff_email ?? "—"} lastHrsWk=${p.last_hours_week_start ?? "—"}`;

console.log(`recently offboarded people: ${people.length}`);
for (const p of people.slice(0, 15)) console.log(`  ${fmt(p)}`);

let pool = people;
if (weekArg) {
  const shown = people.filter((p) => offboardedRelevantToWeek(p, weekArg, hoursWeekFloor));
  const hidden = people.filter((p) => !offboardedRelevantToWeek(p, weekArg, hoursWeekFloor));
  console.log(`\nweek ${weekArg}: calculators would OFFER ${shown.length}, HIDE ${hidden.length}`);
  for (const p of shown) console.log(`  OFFER ${fmt(p)}`);
  for (const p of hidden.slice(0, 15)) console.log(`  hide  ${fmt(p)}`);
  if (hidden.length > 15) console.log(`  … +${hidden.length - 15} more hidden`);
  pool = shown;
}

const want = args.filter((a) => !a.startsWith("--")).map((e) => e.trim().toLowerCase()).filter(Boolean);
if (want.length > 0) {
  console.log("\nassertions:");
  let missing = 0;
  for (const em of want) {
    const hit = pool.find((p) =>
      [p.work_email, p.personal_email, p.hubstaff_email].some((x) => (x ?? "").toLowerCase() === em),
    );
    if (hit) {
      console.log(
        `  OK   ${em} -> ${hit.name} [${hit.department ?? "—"}] off=${hit.off_boarded_at ?? "(no date)"} pays-as=${hit.hubstaff_email ?? hit.work_email ?? "?"}`,
      );
    } else {
      console.log(`  MISS ${em}`);
      missing += 1;
    }
  }
  process.exit(missing > 0 ? 1 : 0);
}

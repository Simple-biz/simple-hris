/**
 * READ-ONLY verifier: runs the REAL `listRecentlyOffboardedPeople()` — the
 * exact production function behind /api/manager/transfer-candidates?offboarded=1
 * (the KPI calculators' "Offboarded" picker group) — from the command line.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-offboarded-people.mts [email ...]
 *
 * Optional emails: assert each one appears in the result (any identity column),
 * printing its resolved row; exits 1 if any is missing.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { listRecentlyOffboardedPeople } = await import("../src/lib/roster/recently-offboarded");

const { people, error } = await listRecentlyOffboardedPeople();
if (error) {
  console.error(`ERROR: ${error}`);
  process.exit(1);
}
console.log(`recently offboarded people: ${people.length}`);
for (const p of people.slice(0, 15)) {
  console.log(
    `  ${p.off_boarded_at ?? "(no date)"} · ${p.name} [${p.department ?? "—"}] work=${p.work_email ?? "—"} hub=${p.hubstaff_email ?? "—"}`,
  );
}

const want = process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean);
if (want.length > 0) {
  console.log("\nassertions:");
  let missing = 0;
  for (const em of want) {
    const hit = people.find((p) =>
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

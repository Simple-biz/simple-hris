/**
 * READ-ONLY verifier for the SETTLEMENT-currency marker — who is paid in a
 * currency other than the peso, and what their figures convert to.
 *
 * Exercises the same shared resolver the Manager KPI Calculator, the Payroll
 * Wizard and `current-pay.ts` all go through, against LIVE data, so a marker
 * that stops reaching a work email shows up here rather than as a Colombian
 * quietly reading peso figures.
 *
 * It also reports the FX PROVENANCE (`live` / `unset` / `fallback`), because a
 * marker with an unlicensed rate is the one state where the surfaces
 * deliberately keep showing pesos.
 *
 * Writes nothing. Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-settlement-currency.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

// Import AFTER dotenv so the Supabase client sees the env when constructed.
const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const { getAppSettings } = await import("../src/lib/supabase/app-settings");
const { getEmployeeHourlyRatesRows } = await import(
  "../src/lib/supabase/employee-hourly-rates"
);
const { USD_TO_PHP_SETTINGS_KEY, USD_TO_COP_SETTINGS_KEY } = await import(
  "../src/lib/fx/currency-fx"
);
const {
  buildSettlementCurrencyByEmail,
  resolveSettlementRate,
  settlementAmountFromPhp,
} = await import("../src/lib/payroll/settlement-currency");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("Supabase service role not configured — check .env.local");
  process.exit(1);
}

const { rows: masterRows, error: masterErr } = await selectAllPaged<{
  Name: string | null;
  Department: string | null;
  "Work Email": string | null;
  "Personal Email": string | null;
  "Alternate Work Email": string | null;
  "Alternate Work Email 2": string | null;
}>((from, to) =>
  supabase
    .from("global_master_list")
    .select(
      'Name, Department, "Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2"',
    )
    .order("Work Email", { ascending: true })
    .range(from, to),
);
if (masterErr) throw new Error(`master list: ${masterErr}`);

const { rows: onboardingRows, error: onboardErr } = await selectAllPaged<{
  email: string | null;
  invite_personal_email: string | null;
  country: string | null;
}>((from, to) =>
  supabase
    .from("hr_onboarding_submissions")
    .select("email, invite_personal_email, country")
    .order("email", { ascending: true })
    .range(from, to),
);
if (onboardErr) throw new Error(`onboarding: ${onboardErr}`);

// Through the shared helper, never a hand-rolled select: `employee_hourly_rates`
// is CSV-seeded, so its columns are quoted and capitalised ("Work Email") and a
// snake_case projection fails outright. The helper also knows the env-var table
// name, the deduplicated view, and the 1000-row paging.
const ratesResult = await getEmployeeHourlyRatesRows();
const ratePairs = ratesResult.rows.map((r) => ({
  work_email: r.work_email ?? null,
  personal_email: r.personal_email ?? null,
}));
if (ratesResult.error) throw new Error(`rates: ${ratesResult.error}`);

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase() || null;

const aliasesByEmail = new Map<string, string[]>();
for (const m of masterRows) {
  const group = [
    norm(m["Work Email"]),
    norm(m["Personal Email"]),
    norm(m["Alternate Work Email"]),
    norm(m["Alternate Work Email 2"]),
  ].filter((e): e is string => !!e);
  for (const e of group) {
    const existing = aliasesByEmail.get(e);
    if (existing) {
      for (const x of group) if (!existing.includes(x)) existing.push(x);
    } else {
      aliasesByEmail.set(e, [...group]);
    }
  }
}

const byEmail = buildSettlementCurrencyByEmail(onboardingRows, aliasesByEmail, ratePairs);

const settings = await getAppSettings([USD_TO_PHP_SETTINGS_KEY, USD_TO_COP_SETTINGS_KEY]);
const rate = resolveSettlementRate(
  settings[USD_TO_PHP_SETTINGS_KEY],
  settings[USD_TO_COP_SETTINGS_KEY],
);

console.log(
  `master rows ${masterRows.length} · onboarding rows ${onboardingRows.length} · rate pairs ${ratePairs.length}`,
);
console.log(
  `FX rate provenance: ${rate.status}${
    rate.status === "live" ? `  (usd→php ${rate.fx.usdToPhp}, usd→cop ${rate.fx.usdToCop})` : ""
  }`,
);
if (rate.status !== "live") {
  console.log(
    "  → every surface will keep showing PESOS and flag the chip amber. That is the",
  );
  console.log("    designed behaviour, not a defect: no confirmed rate, no native figure.");
}

const spread: Record<string, number> = {};
for (const cur of byEmail.values()) spread[cur] = (spread[cur] ?? 0) + 1;
console.log(`marked emails: ${byEmail.size}  spread ${JSON.stringify(spread)}`);

// Every NON-PHP settled human on the master list, by their work email.
type Row = { name: string; dept: string; work: string; personal: string; cur: string };
const people: Row[] = [];
for (const m of masterRows) {
  const work = norm(m["Work Email"]);
  const personal = norm(m["Personal Email"]);
  const cur =
    (work ? byEmail.get(work) : null) ??
    (personal ? byEmail.get(personal) : null) ??
    null;
  if (!cur || cur === "PHP") continue;
  people.push({
    name: m.Name ?? "?",
    dept: m.Department ?? "?",
    work: work ?? "(none)",
    personal: personal ?? "(none)",
    cur,
  });
}

console.log(`\nnon-PHP settled people on the master list: ${people.length}`);
for (const p of people.sort((a, b) => a.dept.localeCompare(b.dept))) {
  const marked = byEmail.get(p.work) ? "work+" : "personal-only!";
  console.log(`  ${p.cur.padEnd(4)} ${p.dept.padEnd(22)} ${p.work.padEnd(32)} ${p.name}  [${marked}]`);
}

// A marker that resolves ONLY on the personal email is the failure mode that
// matters: pay surfaces key on the work email, so that person silently reads
// peso figures despite having a settlement currency on file.
const personalOnly = people.filter((p) => !byEmail.get(p.work));
if (personalOnly.length > 0) {
  console.log(
    `\n!! ${personalOnly.length} person(s) marked on their PERSONAL email only — the identity bridge missed their work email, so pay surfaces will show them pesos:`,
  );
  for (const p of personalOnly) console.log(`   ${p.work}  (${p.personal})  ${p.name}`);
} else {
  console.log("\nOK — every non-PHP settled person is marked on their WORK email too.");
}

// Worked example, so the conversion is visible rather than asserted.
if (rate.status === "live") {
  const sample = 1200;
  const cop = settlementAmountFromPhp(sample, "COP", rate);
  console.log(
    `\nworked example: a ${String.fromCharCode(0x20b1)}${sample} KPI bonus settles as $COP${cop?.toLocaleString("es-CO")}`,
  );
}

/**
 * Regression guard for the 2026-08-03 "422 Unassigned" incident.
 *
 * Supabase Advisor's "Security Definer View" quick-fix set security_invoker=true on
 * active_employees. That view filters global_master_list by the is_current row of
 * master_list_uploads — a table anon is RLS-blocked on — so under invoker semantics
 * the view returned an EMPTY SET to anon with HTTP 200 and no error. getEmployees()
 * fed that phantom roster into the Payroll Wizard, whose department source of truth
 * went blank: 422 of 1045 people fell through to "Unassigned".
 *
 * This script asserts, READ-ONLY:
 *   1. The roster path the app actually uses returns a full roster with departments.
 *   2. The self-heal path (anon + global_master_list rebuild) also returns a full
 *      roster — so the app survives even without the service key.
 *   3. The two views that were a REAL anon leak stay closed to anon. Their base
 *      tables are locked to anon, so an anon-visible view is a privilege bypass.
 *
 *   node scripts/verify-active-employees-roster.mjs
 *
 * Exits non-zero on any failure. NO WRITES.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const anon = createClient(url, anonKey);
const svc = svcKey ? createClient(url, svcKey) : null;

/** Roster is considered healthy above this. The active roster was 1345 on 2026-08-03;
 *  a floor well under that catches "blank" without breaking on normal attrition. */
const MIN_ROSTER = 500;
/** Departments must resolve for the overwhelming majority — a blank-department roster
 *  is what silently produced the Unassigned pile. */
const MIN_DEPT_COVERAGE = 0.9;

const failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failures.push(m);
};

async function pageAll(client, table, sel, tweak) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = client.from(table).select(sel).range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) return { rows: null, error: error.message };
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
  return { rows: out, error: null };
}

const SEL = 'Department,Name,"Work Email"';
const norm = (v) => (v == null ? "" : String(v).trim());

function reportRoster(label, rows) {
  if (rows.length < MIN_ROSTER) {
    bad(`${label}: only ${rows.length} rows (expected >= ${MIN_ROSTER}) — roster looks blank`);
    return;
  }
  const withDept = rows.filter((r) => norm(r.Department)).length;
  const coverage = withDept / rows.length;
  const depts = new Set(rows.map((r) => norm(r.Department)).filter(Boolean));
  if (coverage < MIN_DEPT_COVERAGE) {
    bad(
      `${label}: ${rows.length} rows but only ${(coverage * 100).toFixed(1)}% carry a Department ` +
        `(expected >= ${MIN_DEPT_COVERAGE * 100}%)`,
    );
    return;
  }
  ok(
    `${label}: ${rows.length} rows, ${(coverage * 100).toFixed(1)}% with Department, ` +
      `${depts.size} distinct departments`,
  );
}

console.log("\n1. The roster path the app uses (service-role-first, as getEmployees does)");
{
  const client = svc ?? anon;
  if (!svc) console.log("  ! SUPABASE_SERVICE_ROLE_KEY absent — exercising the anon path");
  const { rows, error } = await pageAll(client, "active_employees", SEL);
  if (error) bad(`active_employees read failed: ${error}`);
  else reportRoster("active_employees", rows);
}

console.log("\n2. The self-heal path (rebuild from global_master_list, no view, no uploads table)");
{
  const { rows, error } = await pageAll(anon, "global_master_list", `${SEL},last_seen_upload_id`, (q) =>
    q.is("off_boarded_at", null),
  );
  if (error) {
    bad(`global_master_list rebuild failed: ${error}`);
  } else {
    const tally = new Map();
    for (const r of rows) {
      const k = r.last_seen_upload_id ?? "";
      if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const live = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    reportRoster("global_master_list @ modal upload id", rows.filter((r) => (r.last_seen_upload_id ?? "") === live));
  }
}

console.log("\n3. Views that must stay CLOSED to anon (their base tables are locked to anon)");
for (const [view, base] of [
  ["employee_hourly_rates_current", "employee_hourly_rates"],
  ["active_hsl_agents", "hsl_team_members"],
]) {
  const { count: viewCount, error: viewErr } = await anon
    .from(view)
    .select("*", { count: "exact", head: true });
  const { count: baseCount } = await anon.from(base).select("*", { count: "exact", head: true });
  const viewVisible = !viewErr && (viewCount ?? 0) > 0;
  const baseVisible = (baseCount ?? 0) > 0;
  if (viewVisible && !baseVisible) {
    bad(
      `${view}: anon reads ${viewCount} rows while base table ${base} is locked to anon ` +
        `— the view is bypassing the lockdown (needs security_invoker = true)`,
    );
  } else {
    ok(`${view}: anon sees ${viewErr ? "error (blocked)" : (viewCount ?? 0)} — no bypass of ${base}`);
  }
}

console.log();
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("All roster + view-visibility checks passed.");

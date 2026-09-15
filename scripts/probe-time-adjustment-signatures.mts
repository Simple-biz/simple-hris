/**
 * READ-ONLY probe: time adjustments — do two signatures reach Accounting, and who is in
 * the second-approver pool for a given request?
 *
 * Carla, 2026-09-15 (via Kane): "When a time adjustment has two signatures, it should go
 * to Accounting > Issues for one last approval/check. Right now, two signatures happen,
 * nothing changes, but HRIS tells us we're waiting on something. Also, my second
 * signature person is Claire. She is no longer on this list."
 *
 * Measures, never mutates:
 *   1. status distribution of time_adjustment_requests, and every row whose two
 *      decisions disagree with its derived status (a derivation defect would show here)
 *   2. rows currently owed a decision, with who owes it
 *   3. the named request (juliar@, 2026-09-10) in full
 *   4. roster rows for the people named (Julia, Carla, Claire), and Carla's
 *      department_managers assignments — which decides Claire's pool membership
 *
 * Usage: node --import tsx scripts/probe-time-adjustment-signatures.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const { deriveAdjustmentStatus } = await import("../src/lib/supabase/time-adjustments");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const line = (s: string) => console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);

type Row = {
  id: string;
  work_email: string;
  adjust_date: string;
  status: string;
  manager_decision: string | null;
  manager_decided_by: string | null;
  manager_decided_at: string | null;
  second_approver_email: string | null;
  second_approver_assigned_by: string | null;
  second_decision: string | null;
  second_decided_by: string | null;
  second_decided_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  approved_hours: number | null;
  requested_hours: number | null;
  /** Present only once the 2026-09-15 migration has landed. */
  stage1_waived_reason?: string | null;
  created_at: string;
  updated_at: string;
};

// `*` rather than a column list so the probe runs both before and after the
// stage1_waived_reason migration (an explicit missing column is a PostgREST error).
const { rows, error: rowsErr } = await selectAllPaged<Row>((from, to) =>
  supabase
    .from("time_adjustment_requests")
    .select("*")
    .order("created_at", { ascending: true })
    .range(from, to),
);

if (rowsErr) { console.error("read failed:", rowsErr); process.exit(1); }
line(`1. time_adjustment_requests - ${rows.length} rows, status distribution`);
{
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k.padEnd(28)} ${v}`);
}

line("1b. rows whose stored status differs from the derived status (derivation defect if any)");
{
  let n = 0;
  for (const r of rows) {
    if (r.status === "approved" || r.status === "denied") continue; // Accounting wrote these
    const derived = deriveAdjustmentStatus({
      managerDecision: r.manager_decision as "approved" | "denied" | null,
      secondDecision: r.second_decision as "approved" | "denied" | null,
      secondApproverEmail: r.second_approver_email,
      // Absent before the 2026-09-15 migration; a missing column reads as "not waived".
      stage1Waived: r.stage1_waived_reason === "manager_filed",
    });
    if (derived !== r.status) {
      n++;
      console.log(
        `  ${r.id.slice(0, 8)} ${r.work_email} ${r.adjust_date} stored=${r.status} derived=${derived} mgr=${r.manager_decision} 2nd=${r.second_decision} named=${r.second_approver_email}`,
      );
    }
  }
  if (n === 0) console.log("  none - every open/stage-1 row matches deriveAdjustmentStatus");
}

line("2. rows still owed a decision (created 2026-08-19 or later)");
{
  const open = rows.filter(
    (r) => (r.status === "pending" || r.status === "awaiting_second_approval" || r.status === "manager_approved")
      && r.created_at >= "2026-08-19",
  );
  for (const r of open) {
    const owes =
      r.status === "manager_approved" ? "ACCOUNTING"
      : r.manager_decision == null && r.second_approver_email && r.second_decision == null ? "manager + second"
      : r.manager_decision == null ? "manager (no second approver named yet)"
      : r.second_decision == null ? `second approver (${r.second_approver_email})`
      : "?";
    console.log(
      `  ${r.id.slice(0, 8)} ${r.work_email.padEnd(26)} ${r.adjust_date} ${r.status.padEnd(26)} owes: ${owes}` +
      `  mgr=${r.manager_decision ?? "-"}@${(r.manager_decided_at ?? "").slice(0, 10) || "-"} 2nd=${r.second_decision ?? "-"}@${(r.second_decided_at ?? "").slice(0, 10) || "-"} named=${r.second_approver_email ?? "-"} by=${r.second_approver_assigned_by ?? "-"}`,
    );
  }
  console.log(`  (${open.length} rows)`);
}

line("2b. rows with BOTH stage-1 signatures since 2026-08-19, and what Accounting did");
{
  const both = rows.filter(
    (r) => r.manager_decision === "approved" && r.second_decision === "approved" && r.created_at >= "2026-08-19",
  );
  for (const r of both) {
    console.log(
      `  ${r.id.slice(0, 8)} ${r.work_email.padEnd(26)} ${r.adjust_date} status=${r.status.padEnd(18)} mgr=${r.manager_decided_by ?? "-"}@${(r.manager_decided_at ?? "").slice(0, 16)} 2nd=${r.second_decided_by ?? "-"}@${(r.second_decided_at ?? "").slice(0, 16)} acct=${r.decided_by ?? "-"}@${(r.decided_at ?? "").slice(0, 16) || "-"} hrs=${r.approved_hours ?? "-"}`,
    );
  }
  console.log(`  (${both.length} rows with both signatures)`);
}

line("3. juliar@ rows");
for (const r of rows.filter((r) => r.work_email.toLowerCase().startsWith("juliar@"))) {
  console.log(JSON.stringify(r, null, 2));
}

line("4. roster - Julia / Carla / Claire (active_employees view)");
{
  const { data, error } = await supabase
    .from("active_employees")
    .select("*")
    .or('"Name".ilike.%carla%,"Name".ilike.%claire%,"Work Email".ilike.juliar@%,"Work Email".ilike.carla@%,"Work Email".ilike.claire@%');
  if (error) console.log("  active_employees read failed:", error.message);
  const list = (data ?? []) as Record<string, unknown>[];
  if (list[0]) console.log("  columns:", Object.keys(list[0]).join(" | "));
  for (const r of list) {
    console.log(`  ${String(r["Work Email"] ?? "").padEnd(28)} ${String(r["Name"] ?? "").padEnd(36)} dept=${String(r["Department"])}`);
  }
}

line("4b. global_master_list - anyone named Claire or Julia R, any status");
{
  const { data, error } = await supabase
    .from("global_master_list")
    .select("*")
    .or('"Name".ilike.%claire%,"Work Email".ilike.claire@%,"Work Email".ilike.juliar@%');
  if (error) console.log("  global_master_list read failed:", error.message);
  const list = (data ?? []) as Record<string, unknown>[];
  if (list[0]) console.log("  columns:", Object.keys(list[0]).join(" | "));
  for (const r of list) {
    const pick = (k: string) => (k in r ? `${k}=${String(r[k])}` : "");
    console.log(`  ${String(r["Work Email"] ?? "").padEnd(28)} ${String(r["Name"] ?? "").padEnd(36)} ${pick("Department")} ${pick("Status")} ${pick("status")} ${pick("offboarded")} ${pick("Offboarded")} ${pick("Employment Status")}`);
  }
}

line("5. department_managers - Carla, and every active assignment for cross-reference");
{
  const { data, error } = await supabase
    .from("department_managers")
    .select("manager_email,department,revoked_at,assigned_at")
    .order("department");
  if (error) console.log("  department_managers read failed:", error.message);
  const all = (data ?? []) as { manager_email: string; department: string; revoked_at: string | null; assigned_at: string }[];
  for (const r of all.filter((r) => /carla/i.test(r.manager_email))) {
    console.log(`  ${r.manager_email.padEnd(28)} ${r.department.padEnd(30)} revoked=${r.revoked_at ?? "-"} assigned=${r.assigned_at.slice(0, 10)}`);
  }
  console.log("  -- every active assignment:");
  for (const r of all.filter((r) => !r.revoked_at)) {
    console.log(`  ${r.manager_email.padEnd(28)} ${r.department}`);
  }
}

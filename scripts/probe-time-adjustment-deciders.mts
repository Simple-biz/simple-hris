/**
 * READ-ONLY probe: who may decide a time adjustment at the Accounting stage?
 *
 * Kane, 2026-09-15: "any one with Acct>Issues>Edit can adjust. (Exclude Jake/April/Lenny)"
 * and "Claire signs Carla's time." So: who holds Accounting → Issues edit today, what
 * roles do Jake / April / Lenny / Claire hold, and is there a role-shaped line that
 * separates the three from everyone else — or does the exclusion need its own rule?
 *
 * Usage: node --import tsx scripts/probe-time-adjustment-deciders.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}
const line = (s: string) => console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);

type Roster = Record<string, string | null>;
line("1. roster rows matching Jake / April / Lenny / Claire / Carla");
const { data: rosterData, error: rosterErr } = await supabase
  .from("active_employees")
  .select('"Work Email","Name","Department"')
  .or('"Name".ilike.%jake%,"Name".ilike.%april%,"Name".ilike.%lenny%,"Name".ilike.%claire%,"Work Email".ilike.carla@%,"Work Email".ilike.claire@%');
if (rosterErr) console.log("  roster read failed:", rosterErr.message);
const roster = (rosterData ?? []) as Roster[];
for (const r of roster) {
  console.log(`  ${String(r["Work Email"] ?? "").padEnd(28)} ${String(r["Name"] ?? "").padEnd(40)} dept=${r["Department"]}`);
}

line("2. employee_feature_permissions — accounting / disputes (Issues), every holder");
type Perm = { work_email: string; view_key: string; feature: string; access: string };
const { rows: perms, error: permErr } = await selectAllPaged<Perm>((from, to) =>
  supabase
    .from("employee_feature_permissions")
    .select("work_email,view_key,feature,access")
    .eq("view_key", "accounting")
    .eq("feature", "disputes")
    .order("work_email")
    .range(from, to),
);
if (permErr) console.log("  perms read failed:", permErr);
for (const p of perms) console.log(`  ${p.work_email.padEnd(28)} ${p.access}`);
console.log(`  (${perms.length} rows)`);

line("2b. accounting / payroll_wizard edit holders (today's gate) for comparison");
const { rows: pwPerms } = await selectAllPaged<Perm>((from, to) =>
  supabase
    .from("employee_feature_permissions")
    .select("work_email,view_key,feature,access")
    .eq("view_key", "accounting")
    .eq("feature", "payroll_wizard")
    .order("work_email")
    .range(from, to),
);
for (const p of pwPerms) console.log(`  ${p.work_email.padEnd(28)} ${p.access}`);

line("3. active employee_roles for every Issues holder + the named people");
type RoleRow = { work_email: string; role: string; revoked_at: string | null };
const interesting = new Set<string>([
  ...perms.map((p) => p.work_email.toLowerCase()),
  ...roster.map((r) => String(r["Work Email"] ?? "").toLowerCase()).filter(Boolean),
  "claire@simple.biz",
  "carla@simple.biz",
]);
const { rows: roles, error: roleErr } = await selectAllPaged<RoleRow>((from, to) =>
  supabase
    .from("employee_roles")
    .select("work_email,role,revoked_at")
    .is("revoked_at", null)
    .order("work_email")
    .range(from, to),
);
if (roleErr) console.log("  roles read failed:", roleErr);
const rolesByEmail = new Map<string, string[]>();
for (const r of roles) {
  const k = r.work_email.toLowerCase();
  rolesByEmail.set(k, [...(rolesByEmail.get(k) ?? []), r.role]);
}
const issuesEdit = new Set(perms.filter((p) => p.access === "edit").map((p) => p.work_email.toLowerCase()));
for (const email of [...interesting].sort()) {
  const rs = rolesByEmail.get(email) ?? [];
  const rosterRow = roster.find((r) => String(r["Work Email"] ?? "").toLowerCase() === email);
  console.log(
    `  ${email.padEnd(28)} issuesEdit=${issuesEdit.has(email) ? "YES" : "no "} roles=[${rs.join(", ")}]` +
      (rosterRow ? `  name=${rosterRow["Name"]} dept=${rosterRow["Department"]}` : ""),
  );
}

line("4. summary — Issues edit holders grouped by role set");
const groups = new Map<string, string[]>();
for (const email of [...issuesEdit].sort()) {
  const key = (rolesByEmail.get(email) ?? []).slice().sort().join("+") || "(no active role)";
  groups.set(key, [...(groups.get(key) ?? []), email]);
}
for (const [k, v] of groups) console.log(`  ${k.padEnd(30)} ${v.join(", ")}`);

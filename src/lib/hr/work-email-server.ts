import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

/**
 * The set of work addresses that are NOT available to mint (lower-cased full
 * addresses). Checks four sources so no existing @simple.biz address is ever
 * suggested or accepted as available, even if the holder isn't a payroll row:
 *
 *   1. global_master_list — active (non-off-boarded) rows, including both
 *      Alternate Work Email columns. Off-boarded rows free up every address
 *      for recycling (per HR), so they are excluded.
 *   2. employee_ids — every work email in the canonical identity table.
 *      Covers admins, HR staff, and team members who have a workspace account
 *      but may not appear on the payroll roster (e.g. kaner@simple.biz).
 *   3. employee_roles — role assignments keyed by work_email, catching
 *      remaining addresses not in the two tables above.
 *   4. hr_pending_employees — in-flight staged hires (status
 *      pending_work_email | ready) so two simultaneous hires can't collide.
 *
 * Shared by /api/hr/work-email/suggest (suggestion + availability check) and
 * the onboarding set-work-email route (race-safe re-check before minting).
 */
export async function loadTakenWorkEmails(): Promise<Set<string>> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) throw new Error("Supabase client missing");

  const taken = new Set<string>();

  const add = (v: unknown) => {
    const e = String(v ?? "").trim().toLowerCase();
    if (e) taken.add(e);
  };

  // 1. Global master list (payroll roster)
  const { data: gml, error: gmlErr } = await sb
    .from("global_master_list")
    .select('"Work Email", "Alternate Work Email", "Alternate Work Email 2", off_boarded_at')
    .range(0, 99999);
  if (gmlErr) throw new Error(`global_master_list: ${gmlErr.message}`);
  for (const r of (gml ?? []) as Array<Record<string, unknown>>) {
    if (r["off_boarded_at"]) continue;
    add(r["Work Email"]);
    add(r["Alternate Work Email"]);
    add(r["Alternate Work Email 2"]);
  }

  // 2. employee_ids — covers admins and non-payroll staff with workspace accounts
  const { data: ids, error: idsErr } = await sb
    .from("employee_ids")
    .select("work_email")
    .range(0, 9999);
  if (!idsErr) {
    for (const r of (ids ?? []) as Array<{ work_email: string | null }>) {
      add(r.work_email);
    }
  }

  // 3. employee_roles — catches remaining addresses not covered above
  const { data: roles, error: rolesErr } = await sb
    .from("employee_roles")
    .select("work_email")
    .is("revoked_at", null)
    .range(0, 9999);
  if (!rolesErr) {
    for (const r of (roles ?? []) as Array<{ work_email: string | null }>) {
      add(r.work_email);
    }
  }

  // 4. In-flight pending hires (not yet promoted or cancelled)
  const { data: pend, error: pendErr } = await sb
    .from("hr_pending_employees")
    .select("work_email, status")
    .in("status", ["pending_work_email", "ready"]);
  if (pendErr) throw new Error(`hr_pending_employees: ${pendErr.message}`);
  for (const r of (pend ?? []) as Array<{ work_email: string | null }>) {
    add(r.work_email);
  }

  return taken;
}

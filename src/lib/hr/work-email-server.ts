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
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const add = (v: unknown) => {
    const e = norm(v);
    if (e) taken.add(e);
  };

  // Off-boarded addresses are recyclable (per HR), so we DON'T reserve them.
  // But the same address also lingers in employee_ids / employee_roles (which
  // have no off-boarded flag), so we track which master addresses are active vs
  // off-boarded and drop the off-boarded-only ones from those tables too —
  // otherwise an off-boarded person's address would stay reserved forever.
  const activeEmails = new Set<string>();
  const offboardedEmails = new Set<string>();

  // 1. Global master list (payroll roster)
  const { data: gml, error: gmlErr } = await sb
    .from("global_master_list")
    .select('"Work Email", "Alternate Work Email", "Alternate Work Email 2", off_boarded_at')
    .range(0, 99999);
  if (gmlErr) throw new Error(`global_master_list: ${gmlErr.message}`);
  for (const r of (gml ?? []) as Array<Record<string, unknown>>) {
    const emails = [r["Work Email"], r["Alternate Work Email"], r["Alternate Work Email 2"]]
      .map(norm)
      .filter(Boolean);
    if (r["off_boarded_at"]) {
      emails.forEach((e) => offboardedEmails.add(e));
      continue; // off-boarded → recyclable, don't reserve
    }
    emails.forEach((e) => {
      taken.add(e);
      activeEmails.add(e);
    });
  }

  // Addresses whose ONLY active presence is an off-boarded master row — recycle
  // them, i.e. ignore any lingering employee_ids / employee_roles rows below.
  const freed = new Set([...offboardedEmails].filter((e) => !activeEmails.has(e)));

  // 2. employee_ids — covers admins and non-payroll staff with workspace accounts
  const { data: ids, error: idsErr } = await sb
    .from("employee_ids")
    .select("work_email")
    .range(0, 9999);
  if (!idsErr) {
    for (const r of (ids ?? []) as Array<{ work_email: string | null }>) {
      const e = norm(r.work_email);
      if (e && !freed.has(e)) taken.add(e);
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
      const e = norm(r.work_email);
      if (e && !freed.has(e)) taken.add(e);
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

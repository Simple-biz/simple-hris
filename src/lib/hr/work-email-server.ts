import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

/**
 * The set of work addresses that are NOT available to mint (lower-cased full
 * addresses):
 *   - every `global_master_list` Work Email whose row is NOT off-boarded.
 *     Off-boarded people free up their address for recycling (per HR), so we
 *     deliberately skip them.
 *   - every in-flight `hr_pending_employees` work_email (status
 *     pending_work_email | ready) so two simultaneous hires can't be handed the
 *     same address. Promoted rows already live in the master list; cancelled
 *     ones are recyclable — neither is included.
 *
 * Shared by /api/hr/work-email/suggest (suggestion + availability) and the
 * onboarding set-work-email route (race-safe re-check before it mints).
 */
export async function loadTakenWorkEmails(): Promise<Set<string>> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) throw new Error("Supabase client missing");

  const taken = new Set<string>();

  const { data: gml, error: gmlErr } = await sb
    .from("global_master_list")
    .select('"Work Email", off_boarded_at')
    .range(0, 99999);
  if (gmlErr) throw new Error(`global_master_list: ${gmlErr.message}`);
  for (const r of (gml ?? []) as Array<Record<string, unknown>>) {
    if (r["off_boarded_at"]) continue; // off-boarded -> recyclable
    const e = String(r["Work Email"] ?? "").trim().toLowerCase();
    if (e) taken.add(e);
  }

  const { data: pend, error: pendErr } = await sb
    .from("hr_pending_employees")
    .select("work_email, status")
    .in("status", ["pending_work_email", "ready"]);
  if (pendErr) throw new Error(`hr_pending_employees: ${pendErr.message}`);
  for (const r of (pend ?? []) as Array<{ work_email: string | null }>) {
    const e = (r.work_email ?? "").trim().toLowerCase();
    if (e) taken.add(e);
  }

  return taken;
}

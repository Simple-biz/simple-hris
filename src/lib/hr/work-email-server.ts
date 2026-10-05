import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import {
  buildWorkEmailReservations,
  IN_FLIGHT_PENDING_STATUSES,
  mayReclaimWhenWorkspaceMissing,
  type WorkEmailReservations,
} from "./work-email-reservations";
import { verifyWorkspaceAccount } from "./workspace-account";

/**
 * The work addresses that are NOT available to mint (lower-cased full
 * addresses), split into `onRecord` (never reclaimable) and `claimed` (an
 * in-flight hire only) — see `buildWorkEmailReservations` for the rule and why.
 * Six sources, every one read in full and every read THROWS on error (a
 * silently smaller set re-mints someone's address, item 227):
 *
 *   1. global_master_list — EVERY row, active or off-boarded, all three email
 *      columns. Off-boarded rows no longer free their address (Kane, 2026-10-05,
 *      item 344).
 *   2. employee_ids — the bank / wallet identity table, which covers admins and
 *      staff who are not on the payroll roster (e.g. kaner@simple.biz).
 *   3. employee_roles — non-revoked role assignments.
 *   4. offboarded_sheet — the leaver ledger; it keeps addresses whose master row
 *      was deleted (offboarding_delete, Unpromote).
 *   5. employee_hourly_rates_current — one row per work email ever rated, so
 *      the rate and paystub history keyed on the address.
 *   6. hr_pending_employees in `pending_work_email` | `ready` |
 *      `failed_to_promote`, so two in-flight hires can't collide. Before
 *      2026-10-05 `failed_to_promote` was missing, so a hire whose promote
 *      failed did not hold their own address.
 *
 * Shared by /api/hr/work-email/suggest (suggestion + availability check), the
 * onboarding set-work-email route (race-safe re-check before minting) and the
 * Gmail-surname step.
 */
export async function loadWorkEmailReservations(): Promise<WorkEmailReservations> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) throw new Error("Supabase client missing");

  // Paged throughout: PostgREST silently caps even an explicit .range(0, 99999)
  // at 1,000 rows, and every one of these tables except the pending read is
  // past that.
  const { rows: gml, error: gmlErr } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    sb
      .from("global_master_list")
      .select('id, "Work Email", "Alternate Work Email", "Alternate Work Email 2"')
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (gmlErr) throw new Error(`global_master_list: ${gmlErr}`);

  const { rows: ids, error: idsErr } = await selectAllPaged<{ work_email: string | null }>((from, to) =>
    sb
      .from("employee_ids")
      .select("work_email")
      .order("employee_id", { ascending: true })
      .range(from, to),
  );
  if (idsErr) throw new Error(`employee_ids: ${idsErr}`);

  const { rows: roles, error: rolesErr } = await selectAllPaged<{ work_email: string | null }>((from, to) =>
    sb
      .from("employee_roles")
      .select("work_email")
      .is("revoked_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (rolesErr) throw new Error(`employee_roles: ${rolesErr}`);

  const { rows: ledger, error: ledgerErr } = await selectAllPaged<{ work_email: string | null }>((from, to) =>
    sb
      .from("offboarded_sheet")
      .select("work_email")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (ledgerErr) throw new Error(`offboarded_sheet: ${ledgerErr}`);

  const { rows: rates, error: ratesErr } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    sb
      .from("employee_hourly_rates_current")
      .select('id, "Work Email"')
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (ratesErr) throw new Error(`employee_hourly_rates_current: ${ratesErr}`);

  const { data: pend, error: pendErr } = await sb
    .from("hr_pending_employees")
    .select("work_email")
    .in("status", [...IN_FLIGHT_PENDING_STATUSES]);
  if (pendErr) throw new Error(`hr_pending_employees: ${pendErr.message}`);

  return buildWorkEmailReservations({
    masterEmails: gml.flatMap((r) => [r["Work Email"], r["Alternate Work Email"], r["Alternate Work Email 2"]]),
    employeeIdsEmails: ids.map((r) => r.work_email),
    roleEmails: roles.map((r) => r.work_email),
    offboardedLedgerEmails: ledger.map((r) => r.work_email),
    ratesEmails: rates.map((r) => r["Work Email"]),
    inFlightPendingEmails: ((pend ?? []) as Array<{ work_email: string | null }>).map((r) => r.work_email),
  });
}

/** Every address that may not be minted (`onRecord` ∪ `claimed`). */
export async function loadTakenWorkEmails(): Promise<Set<string>> {
  return (await loadWorkEmailReservations()).taken;
}

/**
 * The save-time gate every route that WRITES a hire's work email runs: null
 * when `workEmail` may be issued to this hire, else the HTTP refusal. Keeping
 * the hire's current address is always allowed. An address on anyone's record
 * is refused outright. A pure in-flight claim is refused unless the verify
 * webhook definitively reports its Workspace account missing (a stale claim
 * from a failed create). Before 2026-10-05 `PATCH /api/hr/pending-employees/[id]`
 * ran no check at all.
 */
export async function workEmailIssueDenial(
  workEmail: string,
  currentWorkEmail: string | null,
): Promise<{ status: number; error: string } | null> {
  const email = workEmail.trim().toLowerCase();
  if (email === (currentWorkEmail ?? "").trim().toLowerCase()) return null;
  let reservations: WorkEmailReservations;
  try {
    reservations = await loadWorkEmailReservations();
  } catch (e) {
    return { status: 500, error: e instanceof Error ? e.message : "Failed to read roster" };
  }
  if (!reservations.taken.has(email)) return null;
  if (!mayReclaimWhenWorkspaceMissing(email, reservations)) {
    return {
      status: 409,
      error: `${email} has belonged to someone before and is never re-issued. Pick another address.`,
    };
  }
  const v = await verifyWorkspaceAccount(email);
  if (v.state !== "missing") {
    return { status: 409, error: `${email} is already in use. Pick another address.` };
  }
  return null;
}

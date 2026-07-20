import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import {
  fallbackDialerIdentity,
  isLeadGenDepartment,
  suggestCallToolsUsername,
} from "./calltools-username";

/**
 * The set of CallTools usernames that are NOT available to mint (lower-cased).
 *
 * Source: every `calltools_username` ever stored on an onboarding submission —
 * ALL statuses on purpose. An archived submission whose hire was promoted still
 * holds a live dialer account, and unlike work emails there is no off-boarded
 * flag to recycle against, so we over-reserve: the worst case is a slightly
 * longer surname slice, never a duplicate dialer username.
 *
 * Limitation: usernames created directly in CallTools before this feature
 * existed are invisible here — the system can only guarantee uniqueness among
 * usernames it minted itself.
 *
 * Shared by /api/onboarding/[token]/calltools-username (live suggestion while
 * the hire types) — callers exclude the row's own username for re-submissions.
 */
export async function loadTakenCallToolsUsernames(): Promise<Set<string>> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) throw new Error("Supabase client missing");

  const taken = new Set<string>();
  const { data, error } = await sb
    .from("hr_onboarding_submissions")
    .select("calltools_username")
    .not("calltools_username", "is", null)
    .range(0, 99999);
  if (error) {
    // Pre-migration DB (column not there yet): treat the roster as empty so the
    // live derivation still works — it just can't see collisions until the
    // add_calltools_username_to_onboarding.sql migration runs.
    if (/calltools_username/i.test(error.message)) return taken;
    throw new Error(`hr_onboarding_submissions: ${error.message}`);
  }
  for (const r of (data ?? []) as Array<{ calltools_username: string | null }>) {
    const u = (r.calltools_username ?? "").trim().toLowerCase();
    if (u) taken.add(u);
  }
  return taken;
}

/**
 * Map of employee email → stored CallTools username, for surfacing the dialer
 * username on roster views (Manager → My Team list). Built from every onboarding
 * submission that already has a minted `calltools_username` — Lead Gen is the
 * only department that ever stores one — keyed by ALL of the submission's known
 * emails (the minted @simple.biz work email, the personal email the hire typed,
 * and the invite personal email) so a roster row matches on whichever address it
 * carries.
 *
 * DISPLAY-ONLY: unlike {@link ensureCallToolsFieldsForSubmission} this never
 * mints or persists, so a Lead Gen hire whose paperwork predates the feature is
 * simply absent from the map (the caller shows them as "needs backfill" for HR
 * to fill in). Pre-migration DB (no column) → empty map, never throws for that.
 */
export async function loadCallToolsUsernamesByEmail(): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>();
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) return byEmail;

  const { data, error } = await sb
    .from("hr_onboarding_submissions")
    .select("calltools_username, work_email, email, invite_personal_email")
    .not("calltools_username", "is", null)
    .range(0, 99999);
  if (error) {
    // Pre-migration DB (column not there yet): degrade to an empty map so the
    // roster still renders — every Lead Gen row just reads as "needs backfill"
    // until add_calltools_username_to_onboarding.sql runs.
    if (/calltools_username/i.test(error.message)) return byEmail;
    throw new Error(`hr_onboarding_submissions: ${error.message}`);
  }
  for (const r of (data ?? []) as Array<{
    calltools_username: string | null;
    work_email: string | null;
    email: string | null;
    invite_personal_email: string | null;
  }>) {
    const username = (r.calltools_username ?? "").trim();
    if (!username) continue;
    for (const e of [r.work_email, r.email, r.invite_personal_email]) {
      const key = (e ?? "").trim().toLowerCase();
      // First writer wins per email — a person re-onboarded under the same
      // address carries the same username, so collisions are harmless.
      if (key && !byEmail.has(key)) byEmail.set(key, username);
    }
  }

  // Overlay the per-employee manual store (employee_calltools_usernames): the
  // editable/backfilled record that covers existing staff — including the ~94
  // active Lead Gen employees with no onboarding submission to mint from. A
  // manual entry WINS over the submission-derived value (it is the human's
  // deliberate correction / the real dialer username). Pre-migration (table
  // absent) or any read failure just skips the overlay — the roster still
  // renders from submissions.
  try {
    const { data: manual, error: manualErr } = await sb
      .from("employee_calltools_usernames")
      .select("email, calltools_username")
      .range(0, 99999);
    if (!manualErr) {
      for (const r of (manual ?? []) as Array<{
        email: string | null;
        calltools_username: string | null;
      }>) {
        const key = (r.email ?? "").trim().toLowerCase();
        const u = (r.calltools_username ?? "").trim();
        if (key && u) byEmail.set(key, u);
      }
    }
  } catch {
    /* non-fatal: manual overlay is best-effort */
  }
  return byEmail;
}

/**
 * Stored CallTools usernames for a set of pending hires, keyed by
 * `hr_pending_employees.id` — latest linked submission wins (a re-invited hire,
 * e.g. a no-show who came back, has one submission per pending row, so per-id
 * mapping stays correct). DISPLAY-ONLY: never mints. Used by the Manager ->
 * Newly Hired list so each Lead Gen card can show the dialer username the
 * orientation automation minted. Best-effort: pre-migration DB or a read
 * failure returns an empty map.
 */
export async function loadCallToolsUsernamesByPendingIds(
  pendingIds: number[],
): Promise<Map<number, string>> {
  const byId = new Map<number, string>();
  if (pendingIds.length === 0) return byId;
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) return byId;
  try {
    const { data, error } = await sb
      .from("hr_onboarding_submissions")
      .select("pending_employee_id, submitted_at, calltools_username")
      .in("pending_employee_id", pendingIds)
      .not("calltools_username", "is", null)
      .order("submitted_at", { ascending: true });
    if (error) return byId; // pre-migration column or lookup failure
    for (const r of (data ?? []) as Array<{
      pending_employee_id: number | null;
      calltools_username: string | null;
    }>) {
      const u = (r.calltools_username ?? "").trim();
      // Ascending order + overwrite == latest submission wins.
      if (r.pending_employee_id != null && u) byId.set(r.pending_employee_id, u);
    }
  } catch {
    /* best-effort */
  }
  return byId;
}

export type CallToolsFields = {
  calltools_nickname: string | null;
  calltools_username: string | null;
};

const NO_CALLTOOLS: CallToolsFields = {
  calltools_nickname: null,
  calltools_username: null,
};

/**
 * The CallTools dialer fields for a submission — STORED-OR-MINTED.
 *
 * Returns the values stored on the submission when present. When a Lead Gen
 * submission has none (paperwork submitted before the self-chosen-nickname
 * feature), a username is minted right here — nickname preference: stored
 * `calltools_nickname` → the roster name's quoted go-by name
 * ('Joan "Andy" Raguindin' → Andy) → the first name — checked against every
 * already-minted username, and PERSISTED back onto the submission so it is
 * reserved, stable across calls, and visible to HR in the submission modal.
 *
 * Shared by every webhook that carries the dialer fields (orientation-attended
 * mark + create-workspace-account), so whichever fires first mints, and the
 * other reuses the stored value. Best-effort, never throws: nulls for
 * non-Lead-Gen hires, unknown submissions, or a pre-migration database.
 */
export async function ensureCallToolsFieldsForSubmission(args: {
  submissionId: string;
  /** Roster/legal name to derive the fallback identity from. */
  fallbackName: string | null;
  department: string | null;
}): Promise<CallToolsFields> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) return NO_CALLTOOLS;
  try {
    const { data, error } = await sb
      .from("hr_onboarding_submissions")
      .select("calltools_nickname, calltools_username")
      .eq("id", args.submissionId)
      .maybeSingle();
    if (error) return NO_CALLTOOLS; // pre-migration column or lookup failure
    const stored = (data ?? null) as {
      calltools_nickname?: string | null;
      calltools_username?: string | null;
    } | null;
    if (stored?.calltools_username) {
      return {
        calltools_nickname: stored.calltools_nickname ?? null,
        calltools_username: stored.calltools_username,
      };
    }
    if (!isLeadGenDepartment(args.department)) return NO_CALLTOOLS;

    // Pre-feature Lead Gen paperwork — mint the dialer username now.
    const identity = fallbackDialerIdentity(args.fallbackName);
    const nickname = (stored?.calltools_nickname ?? "").trim() || identity.nickname;
    if (!nickname || !identity.first) return NO_CALLTOOLS;
    const taken = await loadTakenCallToolsUsernames();
    const username = suggestCallToolsUsername(
      nickname,
      identity.first,
      identity.last,
      taken,
    );
    if (!username) return NO_CALLTOOLS;
    // Reserve it: write back onto the submission. The `.is(null)` guard means a
    // concurrent mint can't double-assign; both requests end up reading the
    // same persisted value on their next pass.
    await sb
      .from("hr_onboarding_submissions")
      .update({ calltools_nickname: nickname, calltools_username: username })
      .eq("id", args.submissionId)
      .is("calltools_username", null);
    return { calltools_nickname: nickname, calltools_username: username };
  } catch {
    return NO_CALLTOOLS;
  }
}

/**
 * Same as {@link ensureCallToolsFieldsForSubmission}, resolved via the latest
 * submission linked to a pending hire (hr_onboarding_submissions
 * .pending_employee_id). Nulls when the hire has no linked submission (e.g. a
 * Bypass or Add-Person hire).
 */
export async function ensureCallToolsFieldsForPendingHire(
  pendingId: number,
  hire: { name: string | null; department: string | null },
): Promise<CallToolsFields> {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb) return NO_CALLTOOLS;
  try {
    const { data, error } = await sb
      .from("hr_onboarding_submissions")
      .select("id")
      .eq("pending_employee_id", pendingId)
      .order("submitted_at", { ascending: false })
      .limit(1);
    if (error || !data?.[0]) return NO_CALLTOOLS;
    return ensureCallToolsFieldsForSubmission({
      submissionId: (data[0] as { id: string }).id,
      fallbackName: hire.name,
      department: hire.department,
    });
  } catch {
    return NO_CALLTOOLS;
  }
}

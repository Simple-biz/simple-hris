import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

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

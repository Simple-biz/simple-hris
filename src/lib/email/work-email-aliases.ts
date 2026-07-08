import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

/**
 * Given ANY address a person signs in with (or is looked up by), return the full
 * set of that person's WORK addresses — primary "Work Email" plus "Alternate
 * Work Email" / "Alternate Work Email 2" — lowercased, always including the input.
 *
 * Alternate work emails are a SECOND INBOX for the same human, not a different
 * person (see docs/features/identity-resolution.md). So anything keyed on the
 * primary work email must also apply when they log in via an alternate, and vice
 * versa. RBAC role resolution uses this so a role granted to the primary work
 * email is honored no matter which of the linked addresses they authenticate as.
 *
 * Off-boarded rows are excluded: their addresses get RECYCLED to new hires, so an
 * off-boarded row could otherwise leak a now-different person's aliases.
 *
 * Degrades to just `[email]` on any error / missing client so callers never lose
 * the caller's own address (they just don't get the bridge on that failure).
 */
export async function expandWorkEmailAliases(email: string | null | undefined): Promise<string[]> {
  const norm = (email ?? "").trim().toLowerCase();
  if (!norm) return [];

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [norm];

  const set = new Set<string>([norm]);
  try {
    // Match the login email against each of the three work-email columns. Three
    // sequential single-column `.ilike()` queries (not one combined `.or(...)`)
    // because PostgREST's `.or` filter-string mis-parses quoted, space-containing
    // column names like "Alternate Work Email".
    const cols = ['"Work Email"', '"Alternate Work Email"', '"Alternate Work Email 2"'];
    for (const col of cols) {
      const { data } = await supabase
        .from("global_master_list")
        .select('"Work Email","Alternate Work Email","Alternate Work Email 2"')
        .ilike(col, norm)
        .is("off_boarded_at", null);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        for (const c of ["Work Email", "Alternate Work Email", "Alternate Work Email 2"]) {
          const v = String(r[c] ?? "").trim().toLowerCase();
          if (v) set.add(v);
        }
      }
    }
  } catch {
    return [norm];
  }
  return [...set];
}

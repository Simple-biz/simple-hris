import { normEmail } from '@/lib/email/norm-email';

/**
 * Who may see the employee "My Team → Rankings" tab.
 *
 * Kane, 2026-08-29: *"Employee - AI/API Team - Rankings lets hide this please for
 * everyone else except kaner@simple.biz"* — confirmed same day to mean **every**
 * department, not just `devs`, and **no elevated bypass**.
 *
 * Two consequences, both deliberate and both load-bearing:
 *
 * 1. **Not a department allowlist.** `hasSpRankings()` still decides which teams
 *    *have* rankings from the data alone (`employee-team-directory.md:119-124`), so
 *    a second team adopting the AI Team Bonus shape still lights up with no code
 *    change — it just lights up for this list only. Gating by department instead
 *    would have left that future team's scores visible to its whole roster.
 * 2. **Admins are not an exception.** This gate sits ABOVE the elevated-role bypass
 *    in `/api/team-rankings`, so an admin / payroll / finance / hr / viewer session
 *    reads an empty list like anyone else. That is a deliberate divergence from
 *    `/api/team-roster`, which the two routes' shared doc used to promise they
 *    mirrored exactly.
 *
 * A `Set` rather than a bare constant so adding a second reader is one line and
 * cannot accidentally become an `||` chain that forgets to normalize.
 */
export const TEAM_RANKINGS_VIEWERS: ReadonlySet<string> = new Set(['kaner@simple.biz']);

/**
 * True when `email` may read weekly SP rankings for any department.
 *
 * Fails CLOSED: an absent, blank or unrecognised address is not a viewer. Callers
 * pass the **session** email — never a `?email=` subject — so an elevated viewer
 * impersonating someone cannot borrow the subject's access, and Kane keeps his own
 * while impersonating.
 */
export function canViewTeamRankings(email: string | null | undefined): boolean {
  const norm = normEmail(email);
  return norm != null && TEAM_RANKINGS_VIEWERS.has(norm);
}

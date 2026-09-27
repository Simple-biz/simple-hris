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
 *
 * **2026-09-26 — the Manager → My Team surface gained a second door**, Kane choosing
 * (b) when asked to put the Ranking on My Team → AI/API Team *"instead of the Employee
 * Dashboard having it but do not change it for kaner"*. The allow-list itself is
 * unchanged and still decides the EMPLOYEE surface alone; see
 * `managerMayReadRankings` below for the manager-only path.
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

/**
 * Which surface is asking. The employee team tab sends nothing, so it lands on
 * `'employee'`; only Manager → My Team sends `?view=manager`.
 *
 * Exact match only. Anything else — absent, blank, `Manager`, `manager ` — is the
 * employee surface, so a typo can only ever narrow who reads rankings.
 */
export type RankingsView = 'employee' | 'manager';

export function parseRankingsView(raw: string | null | undefined): RankingsView {
  return raw === 'manager' ? 'manager' : 'employee';
}

/**
 * True when a caller who is NOT on `TEAM_RANKINGS_VIEWERS` may read `requestedDepartment`
 * from the manager surface: they hold a live `department_managers` grant for exactly that
 * department (Kane, 2026-09-26, resolution (b)).
 *
 * Load-bearing, each one:
 *
 * - **Manager surface only.** `view` must be `'manager'`. The employee team tab never
 *   sends it, so a manager who also works in the department still reads nothing THERE —
 *   the ask was the ranking *instead of* the Employee Dashboard.
 * - **A grant, never a role.** No elevated argument exists here on purpose: an admin,
 *   payroll, finance, hr or viewer session with no grant for the department is refused,
 *   exactly as on 2026-08-29.
 * - **The department's own grant, never "any grant".** The label must equal one of the
 *   caller's granted labels (trimmed, case-insensitive) — the same comparison the route's
 *   department scoping has always made. It is not widened to a payroll-key match, so a
 *   grant spelled differently from the roster cell fails CLOSED. Measured 2026-09-26: all
 *   9 live AI/API Team grants read exactly `"AI/API Team"`.
 * - **Data-driven, never a department list.** Which departments HAVE rankings is still
 *   `hasSpRankings`; this only decides who may read one.
 */
export function managerMayReadRankings(
  view: RankingsView,
  requestedDepartment: string | null | undefined,
  managedDepartments: readonly (string | null | undefined)[],
): boolean {
  if (view !== 'manager') return false;
  const req = requestedDepartment?.trim().toLowerCase();
  if (!req) return false;
  return managedDepartments.some((d) => d?.trim().toLowerCase() === req);
}

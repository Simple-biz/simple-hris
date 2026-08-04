import { matchHslSubDeptKey } from './schema';

/** Roster row shape returned by `hsl_team_members` (and by /api/hsl-bonus/team-members). */
export interface HslRosterRow {
  email: string;
  full_name: string | null;
  hsl_name: string | null;
  role_raw: string | null;
  dept_key: string | null;
  sub_team: string | null;
  is_manager: boolean;
}

/** The subset of an active Global-Master-List person this merge needs. */
export interface GmlRosterCandidate {
  name: string;
  department: string | null;
  work_email: string | null;
}

/**
 * Merges the Hogan-sheet-synced `hsl_team_members` roster with people who are
 * active on the Global Master List and tagged into an HSL branch (via
 * `matchHslSubDeptKey`) — so someone onboarded through the HR Pipeline shows
 * up without waiting on a Hogan sheet sync. Merged by lower-cased email;
 * `hslTeamMembers` wins on conflict (it carries `is_manager`/`sub_team`, which
 * GML has no concept of) — EXCEPT `dept_key`: if the sheet row hasn't been
 * classified yet (`dept_key: null`) but GML resolves a specific branch, the
 * GML resolution is kept rather than regressing back to unclassified.
 *
 * `deptFilter` mirrors the API's `?dept=` param: when set, only GML people
 * whose resolved key matches are included (the caller is expected to have
 * already filtered `hslTeamMembers` the same way, e.g. via `.eq('dept_key', ...)`).
 */
export function mergeHslRoster(
  hslTeamMembers: HslRosterRow[],
  gmlPeople: GmlRosterCandidate[],
  deptFilter: string | null,
): HslRosterRow[] {
  const byEmail = new Map<string, HslRosterRow>();

  for (const p of gmlPeople) {
    const key = matchHslSubDeptKey(p.department);
    if (!key) continue;
    if (deptFilter && key !== deptFilter) continue;
    const email = (p.work_email ?? '').trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      email,
      full_name: p.name,
      hsl_name: null,
      role_raw: null,
      dept_key: key,
      sub_team: null,
      is_manager: false,
    });
  }

  for (const r of hslTeamMembers) {
    const email = (r.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const existing = byEmail.get(email);
    byEmail.set(email, {
      ...r,
      email,
      dept_key: r.dept_key ?? existing?.dept_key ?? null,
    });
  }

  return Array.from(byEmail.values()).sort((a, b) =>
    (a.full_name ?? '').localeCompare(b.full_name ?? ''),
  );
}

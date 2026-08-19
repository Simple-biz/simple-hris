import { matchHslSubDeptKey } from './schema';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

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
 * A GML candidate's `matchHslSubDeptKey` resolution is only trusted if the
 * same Department string ALSO buckets to Hogan Smith Law at the payroll
 * level via `normalizeDeptToKey` (see the guard in the GML loop below). In
 * practice that means **only the namespaced `hsl:<key>` form is admitted** —
 * the canonical placement per `docs/features/hsl-subdepartments.md` §1, and
 * what every live HSL person carries. `normalizeDeptToKey` deliberately does
 * NOT recognize a plain sub-team display name (Kane's ruling, 2026-08-19),
 * because it IS the HSL family key: it drives the Mon-Sun week model, the
 * +P15/h weekend premium and dept-scoped bonus matching, so HSL membership is
 * never INFERRED from a bare label. This guard is what carries that ruling
 * into the roster.
 *
 * Two live measurements from 2026-08-19 show why it matters. `Department:
 * "Executive Assistants"` x3 (cjm@, jamec@, ellyt@) are not HSL people at
 * all; they would have been merged onto the `executive_assistants` roster
 * beside the three real ones. And `"Callback Team"` x14 is doubly caught: it
 * is both `HSL_DEPTS.callback_team.name` AND normalize-dept-key.ts's curated
 * `map['callback team'] === 'callback'`, so a real Callback-department
 * employee would have been misfiled onto the HSL `callback_team` roster while
 * still separately scoreable on the real Callback calculator — a
 * double-bonus-scoring risk.
 *
 * Do not "improve" this by trusting `matchHslSubDeptKey` alone, and do not
 * add the plain-name fallback to `normalizeDeptToKey` to make it agree.
 *
 * `deptFilter` mirrors the API's `?dept=` param. It is applied to the FINAL
 * merged result, after both loops (and the dept_key-null-fallback rule above)
 * have run — NOT as a mid-loop skip on the GML candidates, and callers should
 * NOT pre-filter `hslTeamMembers` by dept before calling this function. This
 * ordering matters: an `hsl_team_members` row that is unclassified
 * (`dept_key: null`) but whose email also resolves a branch via GML must
 * still be merged (picking up the GML-resolved `dept_key` via the fallback
 * rule) BEFORE the dept filter is checked — otherwise a per-branch request
 * would incorrectly drop that person, or include them without their sheet
 * metadata (`is_manager`/`sub_team`/`hsl_name`/`role_raw`), even though the
 * dept-less (unfiltered) request correctly shows them with that metadata.
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
    // Only proceed if normalizeDeptToKey independently agrees this person is
    // Hogan Smith Law — which, per the ruling in the doc comment above, admits
    // the canonical `hsl:<key>` form and rejects every plain display name.
    if (normalizeDeptToKey(p.department) !== 'hogan_smith_law') continue;
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

  const merged = Array.from(byEmail.values());
  const result = deptFilter ? merged.filter((row) => row.dept_key === deptFilter) : merged;
  return result.sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
}

import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '../email/norm-email';
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';
import { listManagersByDepartment } from './department-managers';
import { listSkillSetsForEmails } from './employee-skill-sets';

export interface TeamRosterProfile {
  id: string;
  name: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  isManager: boolean;
}

export interface TeamRosterSkillSet {
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  projects: string[];
  current_projects: string[];
}

export interface TeamRosterResult {
  profiles: TeamRosterProfile[];
  skillSets: Record<string, TeamRosterSkillSet>;
  lastSeen: Record<string, string>;
  error: string | null;
}

interface ActiveEmployeeRow {
  id: number | string;
  Name?: string | null;
  'Work Email'?: string | null;
  'Personal Email'?: string | null;
  Department?: string | null;
}

const EMPTY_SET: TeamRosterSkillSet = {
  role_title: '',
  currently_working_on: '',
  skills: '',
  strengths: '',
  member_notes: '',
  projects: [],
  current_projects: [],
};

export async function getTeamRoster(
  department: string | null | undefined,
): Promise<TeamRosterResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return {
      profiles: [],
      skillSets: {},
      lastSeen: {},
      error: 'Supabase service client unavailable',
    };
  }

  const deptNorm = department?.trim().toLowerCase() || null;

  const [empsRes, mgrEmails] = await Promise.all([
    supabase
      .from('active_employees')
      .select('id, "Name", "Work Email", "Personal Email", "Department"')
      .range(0, 9999),
    deptNorm ? listManagersByDepartment(department ?? '') : Promise.resolve([] as string[]),
  ]);

  if (empsRes.error) {
    return { profiles: [], skillSets: {}, lastSeen: {}, error: empsRes.error.message };
  }

  const managerSet = new Set<string>(mgrEmails);
  // Effective departments: the Sales/Sales-Assistant email override applies
  // here too, so a PH assistant lands on the Sales Assistant team roster (and
  // the dept-match filter below compares against the effective label).
  const rows = ((empsRes.data ?? []) as ActiveEmployeeRow[]).map(applyDeptOverrideToRawRow);

  const profiles: TeamRosterProfile[] = [];
  // Managers we've already surfaced from active_employees — used to figure out
  // which assigned managers are missing from the view entirely (see below).
  const includedManagerEmails = new Set<string>();
  for (const r of rows) {
    const name = (r.Name ?? '').toString().trim();
    const workEmail = (r['Work Email'] ?? '').toString().trim() || null;
    const personalEmail = (r['Personal Email'] ?? '').toString().trim() || null;
    if (!workEmail && !personalEmail) continue;

    const rowDept = (r.Department ?? '').toString().trim();
    const rowDeptNorm = rowDept.toLowerCase();
    const w = normEmail(workEmail ?? '') ?? '';
    const p = normEmail(personalEmail ?? '') ?? '';
    const isManager = (!!w && managerSet.has(w)) || (!!p && managerSet.has(p));

    // Include rows whose home department matches the requested team, plus any
    // assigned manager of this team even when their own department differs
    // (e.g. a US Manager Bonus employee assigned to manage Accounting).
    const sameDept = !deptNorm || rowDeptNorm === deptNorm;
    if (!sameDept && !isManager) continue;

    if (isManager) {
      if (w) includedManagerEmails.add(w);
      if (p) includedManagerEmails.add(p);
    }

    profiles.push({
      id: String(r.id),
      name: name || workEmail || personalEmail || '(unknown)',
      workEmail,
      personalEmail,
      department: rowDept || null,
      isManager,
    });
  }

  // Assigned managers who aren't in active_employees at all still need to surface
  // as their team's manager. US-prefixed employees (e.g. US Manager Bonus) are
  // dropped from the view by the master-sheet upload filter on every re-sync, so
  // pull any still-missing assigned managers straight from global_master_list.
  const missingManagers = [...managerSet].filter((e) => !includedManagerEmails.has(e));
  if (missingManagers.length > 0) {
    const quoted = missingManagers.map((e) => `"${e}"`).join(',');
    const { data: mgrRows } = await supabase
      .from('global_master_list')
      .select('id, "Name", "Work Email", "Personal Email", "Department"')
      .or(`"Work Email".in.(${quoted}),"Personal Email".in.(${quoted})`)
      .is('off_boarded_at', null);
    const seenIds = new Set(profiles.map((pr) => pr.id));
    for (const r of ((mgrRows ?? []) as ActiveEmployeeRow[]).map(applyDeptOverrideToRawRow)) {
      const id = String(r.id);
      if (seenIds.has(id)) continue;
      const workEmail = (r['Work Email'] ?? '').toString().trim() || null;
      const personalEmail = (r['Personal Email'] ?? '').toString().trim() || null;
      if (!workEmail && !personalEmail) continue;
      const w = normEmail(workEmail ?? '') ?? '';
      const p = normEmail(personalEmail ?? '') ?? '';
      // Re-confirm membership: the .or() matches either column independently, so
      // guard against pulling in a row that isn't actually an assigned manager.
      if (!((!!w && managerSet.has(w)) || (!!p && managerSet.has(p)))) continue;
      const name = (r.Name ?? '').toString().trim();
      const rowDept = (r.Department ?? '').toString().trim();
      seenIds.add(id);
      profiles.push({
        id,
        name: name || workEmail || personalEmail || '(unknown)',
        workEmail,
        personalEmail,
        department: rowDept || null,
        isManager: true,
      });
    }
  }

  const allWorkEmails = Array.from(
    new Set(
      profiles
        .map((p) => normEmail(p.workEmail ?? ''))
        .filter((e): e is string => !!e),
    ),
  );
  const presenceEmails = Array.from(
    new Set(
      profiles.flatMap((p) => [
        normEmail(p.workEmail ?? '') ?? '',
        normEmail(p.personalEmail ?? '') ?? '',
      ]).filter(Boolean),
    ),
  );

  const [skillRes, presenceRes] = await Promise.all([
    allWorkEmails.length > 0
      ? listSkillSetsForEmails(allWorkEmails)
      : Promise.resolve({ rows: [], error: null }),
    presenceEmails.length > 0
      ? supabase
          .from('user_presence')
          .select('email, last_seen_at')
          .in('email', presenceEmails)
      : Promise.resolve({ data: [] as Array<{ email: string; last_seen_at: string }>, error: null }),
  ]);

  const skillSets: Record<string, TeamRosterSkillSet> = {};
  for (const r of skillRes.rows) {
    const k = normEmail(r.work_email);
    if (!k) continue;
    skillSets[k] = {
      role_title: r.role_title ?? '',
      currently_working_on: r.currently_working_on ?? '',
      skills: r.skills ?? '',
      strengths: r.strengths ?? '',
      member_notes: r.member_notes ?? '',
      projects: r.projects ?? [],
      current_projects: r.current_projects ?? [],
    };
  }
  for (const e of allWorkEmails) {
    if (!skillSets[e]) skillSets[e] = { ...EMPTY_SET };
  }

  const lastSeen: Record<string, string> = {};
  const presenceRows = ('data' in presenceRes ? presenceRes.data : []) as Array<{
    email: string;
    last_seen_at: string;
  }>;
  for (const row of presenceRows ?? []) {
    const k = normEmail(row.email);
    if (k && row.last_seen_at) lastSeen[k] = row.last_seen_at;
  }

  return { profiles, skillSets, lastSeen, error: null };
}

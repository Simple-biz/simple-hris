import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '../email/norm-email';
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
  const rows = (empsRes.data ?? []) as ActiveEmployeeRow[];

  const profiles: TeamRosterProfile[] = [];
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

    const sameDept = !deptNorm || rowDeptNorm === deptNorm;
    if (!sameDept && !isManager) continue;

    profiles.push({
      id: String(r.id),
      name: name || workEmail || personalEmail || '(unknown)',
      workEmail,
      personalEmail,
      department: rowDept || null,
      isManager,
    });
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

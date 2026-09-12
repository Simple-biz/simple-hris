import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '../email/norm-email';
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';
import { listManagersByDepartment } from './department-managers';
import { listSkillSetsForEmails } from './employee-skill-sets';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { teamDisplayNames } from '@/lib/name/team-display-name';

/**
 * What a peer is allowed to know about a teammate.
 *
 * The legal name and the personal email are NOT on this type, and that is the
 * point: Carla's 2026-09-09 safety ruling (meeting doc §2.6) says peers see
 * "only their nickname, the whatever is in quotation marks, and their email",
 * and this is the only route the employee directory reads. Redacting in the
 * component would leave both on the wire, where a direct call to
 * `/api/team-roster` still reaches them — route-access gates PAGES, not APIs.
 *
 * So the surname never leaves the server. Anything the client needs that USED
 * to be derived from the personal address (last-seen, "this card is you") is
 * resolved here instead and shipped as a plain value.
 */
export interface TeamRosterProfile {
  id: string;
  /** The quoted go-by, else the first name — never a surname. Collisions
   *  within this roster are already disambiguated; see teamDisplayNames. */
  displayName: string;
  workEmail: string | null;
  department: string | null;
  isManager: boolean;
  /** Presence, resolved server-side over BOTH addresses so the ~7 people whose
   *  only address is personal are not silently shown as never-seen. */
  lastSeenAt: string | null;
  /** True when this row is the viewer's own. Computed here because the client
   *  no longer holds the personal address it used to match on. */
  isSelf: boolean;
}

/** Server-only: a roster row before redaction. Never returned. */
interface RawProfile {
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
  viewerEmail?: string | null,
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

  // Paged: the roster passed 1,000 people (1,296 as of Jul 2026) and PostgREST
  // silently caps even an explicit .range(0, 9999) at 1,000 — the single-shot
  // read dropped ~300 people from every manager Team page.
  const [empsRes, mgrEmails] = await Promise.all([
    selectAllPaged<Record<string, unknown>>((from, to) =>
      supabase
        .from('active_employees')
        .select('id, "Name", "Work Email", "Personal Email", "Department"')
        .order('Name', { ascending: true })
        .range(from, to),
    ),
    deptNorm ? listManagersByDepartment(department ?? '') : Promise.resolve([] as string[]),
  ]);

  if (empsRes.error) {
    return { profiles: [], skillSets: {}, lastSeen: {}, error: empsRes.error };
  }

  const managerSet = new Set<string>(mgrEmails);
  // Effective departments: the Sales/Sales-Assistant email override applies
  // here too, so a PH assistant lands on the Sales Assistant team roster (and
  // the dept-match filter below compares against the effective label).
  const rows = (empsRes.rows as unknown as ActiveEmployeeRow[]).map(applyDeptOverrideToRawRow);

  const raw: RawProfile[] = [];
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

    raw.push({
      id: String(r.id),
      // The RAW master-list cell — redacted below, never returned as-is.
      name,
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
    const seenIds = new Set(raw.map((pr) => pr.id));
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
      raw.push({
        id,
        name,
        workEmail,
        personalEmail,
        department: rowDept || null,
        isManager: true,
      });
    }
  }

  const allWorkEmails = Array.from(
    new Set(
      raw
        .map((p) => normEmail(p.workEmail ?? ''))
        .filter((e): e is string => !!e),
    ),
  );
  // Server-side only: presence is still looked up on BOTH addresses, so the
  // handful of people whose only address is personal keep a real last-seen.
  // The personal address never leaves this function.
  const presenceEmails = Array.from(
    new Set(
      raw.flatMap((p) => [
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

  const seenByEmail = new Map<string, string>();
  const presenceRows = ('data' in presenceRes ? presenceRes.data : []) as Array<{
    email: string;
    last_seen_at: string;
  }>;
  for (const row of presenceRows ?? []) {
    const k = normEmail(row.email);
    if (k && row.last_seen_at) seenByEmail.set(k, row.last_seen_at);
  }

  // Redaction happens HERE, once, over the whole roster — collisions can only
  // be resolved with every member in hand, and resolving them server-side is
  // what makes a label stable across pagination and search.
  const shortNames = teamDisplayNames(
    raw.map((p) => ({ name: p.name, workEmail: p.workEmail })),
  );
  const viewerNorm = normEmail(viewerEmail ?? '') ?? null;

  const profiles: TeamRosterProfile[] = raw.map((p, i) => {
    const w = normEmail(p.workEmail ?? '') ?? '';
    const e = normEmail(p.personalEmail ?? '') ?? '';
    const seenW = w ? seenByEmail.get(w) : undefined;
    const seenP = e ? seenByEmail.get(e) : undefined;
    return {
      id: p.id,
      displayName: shortNames[i]!,
      workEmail: p.workEmail,
      department: p.department,
      isManager: p.isManager,
      // Newest of the two stamps — a person may have signed in under either.
      lastSeenAt:
        seenW && seenP ? (seenW > seenP ? seenW : seenP) : seenW ?? seenP ?? null,
      isSelf: !!viewerNorm && (w === viewerNorm || e === viewerNorm),
    };
  });

  // The map the client polls to keep "Last seen 1m ago" creeping forward is
  // keyed by WORK email only — its KEYS are addresses, so a personal one here
  // would leak the very field the profile shape drops.
  const lastSeen: Record<string, string> = {};
  for (const e of allWorkEmails) {
    const v = seenByEmail.get(e);
    if (v) lastSeen[e] = v;
  }

  return { profiles, skillSets, lastSeen, error: null };
}

import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/**
 * Curated list of role / title options for the Skill Sets dropdown on the
 * Employee Profile (writes) and the My Team page (reads). Kept here so the
 * dropdown and any future consumers stay in sync. Extend freely; the value
 * is stored verbatim in `employee_skill_sets.role_title`.
 *
 * This is the GENERAL catch-all list, used when an employee's department has no
 * dedicated list in {@link TITLES_BY_DEPT_KEY} (or can't be resolved to a key).
 */
export const SKILL_SET_TITLES = [
  'Full Stack Developer',
  'Front End Developer',
  'Back End Developer',
  'Web Developer',
  'Mobile Developer',
  'Software Engineer',
  'AI Automation Specialist',
  'AI/ML Engineer',
  'AI Solutions Engineer',
  'DevOps Engineer',
  'QA Engineer',
  'Data Engineer',
  'Data Analyst',
  'Workflow Analyst',
  'Project Manager',
  'Product Manager',
  'UX/UI Designer',
  'Graphic Designer',
  'Technical Writer',
  'Systems Developer',
  'Research and Development Engineer',
  'Customer Support',
  'HR Specialist',
  'Accountant',
] as const;

export type SkillSetTitle = (typeof SKILL_SET_TITLES)[number];

/**
 * Department-specific role / title suggestions, keyed by the same payroll
 * department keys produced by {@link normalizeDeptToKey}. When an employee's
 * department resolves to one of these keys, the Role / Title dropdown shows the
 * curated list below instead of the general {@link SKILL_SET_TITLES}. Employees
 * whose role isn't listed can always pick "Custom title…" and type their own —
 * the value is stored verbatim, so these lists are suggestions, not a whitelist.
 *
 * Add/extend lists freely. A department absent from this map falls back to the
 * general list.
 */
export const TITLES_BY_DEPT_KEY: Record<string, readonly string[]> = {
  devs: [
    'Full Stack Developer',
    'Front End Developer',
    'Back End Developer',
    'Web Developer',
    'Mobile Developer',
    'Software Engineer',
    'AI Automation Specialist',
    'AI/ML Engineer',
    'AI Solutions Engineer',
    'DevOps Engineer',
    'QA Engineer',
    'Data Engineer',
    'Systems Developer',
    'Research and Development Engineer',
  ],
  site_building: [
    'Web Developer',
    'Front End Developer',
    'WordPress Developer',
    'Web Designer',
    'Site Builder',
    'Landing Page Specialist',
    'UX/UI Designer',
    'QA Tester',
  ],
  edit: [
    'Video Editor',
    'Senior Video Editor',
    'Motion Graphics Artist',
    'Graphic Designer',
    'Thumbnail Designer',
    'Colorist',
    'Audio Editor',
    'Content Editor',
  ],
  smm: [
    'Social Media Manager',
    'Social Media Specialist',
    'Content Creator',
    'Community Manager',
    'Social Media Strategist',
    'Copywriter',
    'Graphic Designer',
    'Video Editor',
  ],
  lead_gen: [
    'Lead Generation Specialist',
    'Appointment Setter',
    'List Builder',
    'Prospecting Specialist',
    'Outbound Specialist',
    'Cold Caller',
    'Email Outreach Specialist',
  ],
  callback: [
    'Callback Specialist',
    'Sales Representative',
    'Appointment Setter',
    'Inside Sales Representative',
    'Customer Support Representative',
  ],
  sales_assistant: [
    'Sales Assistant',
    'Sales Development Representative',
    'Sales Coordinator',
    'Sales Support Specialist',
    'Account Manager',
  ],
  qc: [
    'Quality Control Specialist',
    'Quality Assurance Analyst',
    'QC Reviewer',
    'Compliance Reviewer',
    'Auditor',
  ],
  discovery: [
    'Discovery Specialist',
    'Research Analyst',
    'Data Researcher',
    'Intake Specialist',
    'Onboarding Specialist',
  ],
  accounting: [
    'Accountant',
    'Bookkeeper',
    'Accounts Receivable Specialist',
    'Accounts Payable Specialist',
    'Collections Specialist',
    'Payroll Specialist',
    'Financial Analyst',
  ],
  hr: [
    'HR Specialist',
    'HR Generalist',
    'Recruiter',
    'Talent Acquisition Specialist',
    'HR Coordinator',
    'People Operations Specialist',
    'Onboarding Specialist',
  ],
  pm_team: [
    'Project Manager',
    'Project Coordinator',
    'Program Manager',
    'Scrum Master',
    'Product Manager',
    'Operations Manager',
  ],
  client_va: [
    'Virtual Assistant',
    'Executive Assistant',
    'Administrative Assistant',
    'Client Success Specialist',
    'Customer Support Representative',
    'Data Entry Specialist',
  ],
  smart_staff: [
    'General Virtual Assistant',
    'Virtual Assistant',
    'Administrative Assistant',
    'Executive Assistant',
    'Data Entry Specialist',
    'Customer Support',
  ],
  hogan_smith_law: [
    'Legal Assistant',
    'Paralegal',
    'Medical Records Specialist',
    'Case Manager',
    'Intake Specialist',
    'Legal Secretary',
    'Records Clerk',
  ],
  us_manager_bonus: [
    'Manager',
    'Team Lead',
    'Supervisor',
    'Operations Manager',
    'Department Head',
    'Director',
  ],
};

/**
 * Role / title suggestions for an employee's department. Resolves the raw
 * master-list department string to a key via {@link normalizeDeptToKey} and
 * returns that department's curated list, falling back to the general
 * {@link SKILL_SET_TITLES} when the department is unknown or unlisted.
 */
export function getTitlesForDepartment(
  rawDepartment: string | null | undefined,
): readonly string[] {
  const key = normalizeDeptToKey(rawDepartment);
  if (key && TITLES_BY_DEPT_KEY[key]?.length) return TITLES_BY_DEPT_KEY[key];
  return SKILL_SET_TITLES;
}

export interface SkillSetCompletionFields {
  role_title?: string | null;
  currently_working_on?: string | null;
  skills?: string | null;
  strengths?: string | null;
  member_notes?: string | null;
  projects?: string[] | null;
  current_projects?: string[] | null;
}

/**
 * Display string for a teammate's current projects. The 1-2 selected projects
 * are joined with " and " (e.g. "Gridline Billing System and Simple HRIS").
 * Falls back to the legacy free-text `currently_working_on` when no projects
 * are picked, then to null.
 */
export function formatCurrentProjects(
  currentProjects: string[] | null | undefined,
  fallback?: string | null,
): string | null {
  const picked = (currentProjects ?? []).map((p) => p.trim()).filter(Boolean);
  if (picked.length > 0) return picked.join(' and ');
  const fb = fallback?.trim();
  return fb || null;
}

/**
 * Whether the employee has filled any of THEIR OWN skill-set fields. Note
 * `member_notes` is deliberately excluded — it is manager-authored, so a
 * manager's note must not silently satisfy the employee's "complete your
 * profile" nudge.
 */
export function hasAnySkillSetContent(fields: SkillSetCompletionFields | null | undefined): boolean {
  if (!fields) return false;
  return Boolean(
    fields.role_title?.trim() ||
      fields.currently_working_on?.trim() ||
      fields.skills?.trim() ||
      fields.strengths?.trim() ||
      (fields.projects ?? []).some((p) => p.trim()) ||
      (fields.current_projects ?? []).some((p) => p.trim()),
  );
}

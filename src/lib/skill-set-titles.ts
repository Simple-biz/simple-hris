/**
 * Curated list of role / title options for the Skill Sets dropdown on the
 * Employee Profile (writes) and the My Team page (reads). Kept here so the
 * dropdown and any future consumers stay in sync. Extend freely; the value
 * is stored verbatim in `employee_skill_sets.role_title`.
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

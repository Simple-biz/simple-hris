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

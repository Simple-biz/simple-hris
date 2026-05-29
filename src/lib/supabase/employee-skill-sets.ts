import { createSupabaseServiceRoleClient } from './server';

export interface EmployeeSkillSetRow {
  work_email: string;
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
  /** Free-typed list of project names the employee has added (no fixed catalog). */
  projects: string[];
  /** The 1-2 projects the employee is currently on; joined with " and " for display. */
  current_projects: string[];
  created_at: string;
  updated_at: string;
}

export interface UpsertSkillSetInput {
  work_email: string;
  role_title?: string;
  currently_working_on?: string;
  skills?: string;
  strengths?: string;
  member_notes?: string;
  projects?: string[];
  current_projects?: string[];
}

const SELECT_COLS =
  'work_email, role_title, currently_working_on, skills, strengths, member_notes, projects, current_projects, created_at, updated_at';

const EMPTY = (workEmail: string): EmployeeSkillSetRow => ({
  work_email: workEmail,
  role_title: '',
  currently_working_on: '',
  skills: '',
  strengths: '',
  member_notes: '',
  projects: [],
  current_projects: [],
  created_at: '',
  updated_at: '',
});

/** Coerce a JSONB column that should be an array of trimmed, non-empty strings. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/** Normalize raw DB rows so JSONB project columns are always string[] (never null). */
function normalizeRow(row: EmployeeSkillSetRow): EmployeeSkillSetRow {
  return {
    ...row,
    projects: toStringArray(row.projects),
    current_projects: toStringArray(row.current_projects),
  };
}

function norm(e: string): string {
  return e.trim().toLowerCase();
}

export async function getSkillSet(
  workEmail: string,
): Promise<{ row: EmployeeSkillSetRow; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  const lower = norm(workEmail);
  if (!supabase) return { row: EMPTY(lower), error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('employee_skill_sets')
    .select(SELECT_COLS)
    .eq('work_email', lower)
    .maybeSingle();
  if (error) return { row: EMPTY(lower), error: error.message };
  const row = data as EmployeeSkillSetRow | null;
  return { row: row ? normalizeRow(row) : EMPTY(lower), error: null };
}

export async function listSkillSetsForEmails(
  emails: string[],
): Promise<{ rows: EmployeeSkillSetRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase client unavailable' };
  const lower = Array.from(new Set(emails.map(norm).filter(Boolean)));
  if (lower.length === 0) return { rows: [], error: null };

  const { data, error } = await supabase
    .from('employee_skill_sets')
    .select(SELECT_COLS)
    .in('work_email', lower);
  if (error) return { rows: [], error: error.message };
  return { rows: ((data ?? []) as EmployeeSkillSetRow[]).map(normalizeRow), error: null };
}

export async function upsertSkillSet(
  input: UpsertSkillSetInput,
): Promise<{ row: EmployeeSkillSetRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  if (!input.work_email?.trim()) {
    return { row: null, error: 'work_email is required' };
  }

  const row: Record<string, unknown> = { work_email: norm(input.work_email) };
  if (input.role_title !== undefined) row.role_title = String(input.role_title);
  if (input.currently_working_on !== undefined) {
    row.currently_working_on = String(input.currently_working_on);
  }
  if (input.skills !== undefined) row.skills = String(input.skills);
  if (input.strengths !== undefined) row.strengths = String(input.strengths);
  if (input.member_notes !== undefined) row.member_notes = String(input.member_notes);
  if (input.projects !== undefined) row.projects = toStringArray(input.projects);
  if (input.current_projects !== undefined) {
    row.current_projects = toStringArray(input.current_projects);
  }

  const { data, error } = await supabase
    .from('employee_skill_sets')
    .upsert(row, { onConflict: 'work_email' })
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: normalizeRow(data as EmployeeSkillSetRow), error: null };
}

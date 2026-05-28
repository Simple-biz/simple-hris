import { createSupabaseServiceRoleClient } from './server';

export interface EmployeeSkillSetRow {
  work_email: string;
  role_title: string;
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
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
}

const SELECT_COLS =
  'work_email, role_title, currently_working_on, skills, strengths, member_notes, created_at, updated_at';

const EMPTY = (workEmail: string): EmployeeSkillSetRow => ({
  work_email: workEmail,
  role_title: '',
  currently_working_on: '',
  skills: '',
  strengths: '',
  member_notes: '',
  created_at: '',
  updated_at: '',
});

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
  return { row: (data as EmployeeSkillSetRow | null) ?? EMPTY(lower), error: null };
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
  return { rows: (data ?? []) as EmployeeSkillSetRow[], error: null };
}

export async function upsertSkillSet(
  input: UpsertSkillSetInput,
): Promise<{ row: EmployeeSkillSetRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  if (!input.work_email?.trim()) {
    return { row: null, error: 'work_email is required' };
  }

  const row: Record<string, string> = { work_email: norm(input.work_email) };
  if (input.role_title !== undefined) row.role_title = String(input.role_title);
  if (input.currently_working_on !== undefined) {
    row.currently_working_on = String(input.currently_working_on);
  }
  if (input.skills !== undefined) row.skills = String(input.skills);
  if (input.strengths !== undefined) row.strengths = String(input.strengths);
  if (input.member_notes !== undefined) row.member_notes = String(input.member_notes);

  const { data, error } = await supabase
    .from('employee_skill_sets')
    .upsert(row, { onConflict: 'work_email' })
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as EmployeeSkillSetRow, error: null };
}

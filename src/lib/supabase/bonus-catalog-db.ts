import { createSupabaseServiceRoleClient } from './server';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';

// Persistence for the Bonus Catalog (see references/create_bonus_catalog.sql).
// One row per bonus / assignment, each carrying a creator + timestamps, so the
// UI can show who added what and update live across users.

const BONUSES = 'bonus_catalog_bonuses';
const ASSIGNMENTS = 'bonus_catalog_assignments';

type BonusRow = {
  id: string;
  name: string;
  description: string | null;
  kind: 'flat' | 'formula';
  amount: number | string | null;
  formula: string | null;
  currency: 'PHP' | 'USD' | null;
  cadence: 'weekly' | 'monthly' | null;
  starred: boolean | null;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

type AssignmentRow = {
  id: string;
  bonus_id: string;
  scope: 'department' | 'employee';
  department_key: string;
  employee_email: string | null;
  employee_name: string | null;
  excluded_emails: string[] | null;
  shared_team: boolean | null;
  created_by: string | null;
  created_at: string | null;
};

function mapBonus(r: BonusRow): BonusDef {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    kind: r.kind,
    amount: r.amount == null ? undefined : Number(r.amount),
    formula: r.formula ?? undefined,
    // Legacy rows (pre-currency) are PHP.
    currency: r.currency === 'USD' ? 'USD' : 'PHP',
    // Legacy rows (pre-cadence) pay weekly.
    cadence: r.cadence === 'monthly' ? 'monthly' : 'weekly',
    starred: r.starred ?? false,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

function mapAssignment(r: AssignmentRow): BonusAssignment {
  return {
    id: r.id,
    bonusId: r.bonus_id,
    scope: r.scope,
    departmentKey: r.department_key,
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    excludedEmails: r.excluded_emails ?? [],
    sharedTeam: r.shared_team ?? false,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function listBonusCatalog(): Promise<{
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { bonuses: [], assignments: [] };
  const [bRes, aRes] = await Promise.all([
    supabase.from(BONUSES).select('*').order('created_at', { ascending: true }),
    supabase.from(ASSIGNMENTS).select('*').order('created_at', { ascending: true }),
  ]);
  return {
    bonuses: (bRes.data ?? []).map((r) => mapBonus(r as BonusRow)),
    assignments: (aRes.data ?? []).map((r) => mapAssignment(r as AssignmentRow)),
  };
}

export async function upsertBonus(
  bonus: BonusDef,
  actor: string,
): Promise<{ row: BonusDef | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  // created_by/created_at are preserved on UPDATE by the touch trigger, so it's
  // safe to send `actor` as both creator and updater here.
  const payload = {
    id: bonus.id,
    name: bonus.name,
    description: bonus.description ?? null,
    kind: bonus.kind,
    amount: bonus.kind === 'flat' ? (Number.isFinite(bonus.amount) ? bonus.amount : 0) : null,
    formula: bonus.kind === 'formula' ? (bonus.formula ?? '') : null,
    currency: bonus.currency === 'USD' ? 'USD' : 'PHP',
    cadence: bonus.cadence === 'monthly' ? 'monthly' : 'weekly',
    starred: !!bonus.starred,
    created_by: actor,
    updated_by: actor,
  };
  const { data, error } = await supabase
    .from(BONUSES)
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ? mapBonus(data as BonusRow) : null, error: null };
}

export async function deleteBonus(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  // Assignments cascade-delete via the FK.
  const { error } = await supabase.from(BONUSES).delete().eq('id', id);
  return { error: error ? error.message : null };
}

export async function addAssignment(
  assignment: BonusAssignment,
  actor: string,
): Promise<{ row: BonusAssignment | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  // Upsert (not insert): editing a common bonus's exclusion list reuses the same
  // assignment id, so it must update the existing row. The touch trigger keeps
  // created_by/created_at immutable across those edits.
  const payload = {
    id: assignment.id,
    bonus_id: assignment.bonusId,
    scope: assignment.scope,
    department_key: assignment.departmentKey,
    employee_email: assignment.employeeEmail ?? null,
    employee_name: assignment.employeeName ?? null,
    excluded_emails:
      assignment.scope === 'department'
        ? (assignment.excludedEmails ?? []).map((e) => e.toLowerCase())
        : [],
    shared_team: assignment.scope === 'department' ? !!assignment.sharedTeam : false,
    created_by: actor,
  };
  const { data, error } = await supabase
    .from(ASSIGNMENTS)
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ? mapAssignment(data as AssignmentRow) : null, error: null };
}

export async function removeAssignment(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase.from(ASSIGNMENTS).delete().eq('id', id);
  return { error: error ? error.message : null };
}

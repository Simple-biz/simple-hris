import { createSupabaseServiceRoleClient } from './server';
import type { PayStructure, PayCurrency } from '@/lib/payment-catalog/pay-structure';

// Persistence for Payment Catalog pay structures
// (see references/create_payment_catalog_pay_structures.sql). One row per
// department- or employee-scoped structure, each carrying a creator +
// timestamps so the UI can show who set what and update live across users.

const TABLE = 'payment_catalog_pay_structures';

type PayRow = {
  id: string;
  scope: 'department' | 'employee';
  department_key: string;
  employee_email: string | null;
  employee_name: string | null;
  regular_rate: number | string;
  ot_rate: number | string | null;
  currency: string;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

function mapRow(r: PayRow): PayStructure {
  return {
    id: r.id,
    scope: r.scope,
    departmentKey: r.department_key,
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    regularRate: Number(r.regular_rate),
    otRate: r.ot_rate == null ? undefined : Number(r.ot_rate),
    currency: (r.currency === 'USD' ? 'USD' : 'PHP') as PayCurrency,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function listPayStructures(): Promise<{ structures: PayStructure[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { structures: [], error: null };
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: true });
  if (error) return { structures: [], error: error.message };
  return { structures: (data ?? []).map((r) => mapRow(r as PayRow)), error: null };
}

export async function upsertPayStructure(
  s: PayStructure,
  actor: string,
): Promise<{ row: PayStructure | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  // created_by/created_at are preserved on UPDATE by the touch trigger, so it's
  // safe to send `actor` as both creator and updater here.
  const payload = {
    id: s.id,
    scope: s.scope,
    department_key: s.departmentKey,
    employee_email: s.scope === 'employee' ? (s.employeeEmail ?? null) : null,
    employee_name: s.scope === 'employee' ? (s.employeeName ?? null) : null,
    regular_rate: Number.isFinite(s.regularRate) ? s.regularRate : 0,
    ot_rate: s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : null,
    currency: s.currency === 'USD' ? 'USD' : 'PHP',
    created_by: actor,
    updated_by: actor,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ? mapRow(data as PayRow) : null, error: null };
}

export async function deletePayStructure(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return { error: error ? error.message : null };
}

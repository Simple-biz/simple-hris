import { createSupabaseServiceRoleClient } from './server';
import type { SystemBonus, SystemBonusCode } from '@/lib/payment-catalog/system-bonus';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';

// Persistence for Payment Catalog System Bonuses (PAB + Technology Bonus).
// See references/create_payment_catalog_system_bonuses.sql. A small fixed set
// of rows keyed by a stable `code`, each carrying the editable amount + a
// department allowlist, plus creator/timestamps for live-updating UI.

const TABLE = 'payment_catalog_system_bonuses';

type SystemBonusRow = {
  code: string;
  label: string;
  amount: number | string;
  currency: string;
  enabled: boolean;
  department_keys: string[] | null;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

function mapRow(r: SystemBonusRow): SystemBonus {
  return {
    code: (r.code === 'tech' ? 'tech' : 'pab') as SystemBonusCode,
    label: r.label,
    // numeric(14,2) comes back from supabase-js as a string -- coerce.
    amount: Number(r.amount),
    currency: (r.currency === 'USD' ? 'USD' : 'PHP') as PayCurrency,
    enabled: r.enabled !== false,
    departmentKeys: Array.isArray(r.department_keys) ? r.department_keys : [],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function listSystemBonuses(): Promise<{ bonuses: SystemBonus[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { bonuses: [], error: null };
  const { data, error } = await supabase.from(TABLE).select('*').order('code', { ascending: true });
  if (error) return { bonuses: [], error: error.message };
  return { bonuses: (data ?? []).map((r) => mapRow(r as SystemBonusRow)), error: null };
}

export async function upsertSystemBonus(
  s: SystemBonus,
  actor: string,
): Promise<{ row: SystemBonus | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };
  // created_by/created_at are preserved on UPDATE by the touch trigger, so it's
  // safe to send `actor` as both creator and updater here.
  const payload = {
    code: s.code,
    label: s.label,
    amount: Number.isFinite(s.amount) ? s.amount : 0,
    currency: s.currency === 'USD' ? 'USD' : 'PHP',
    enabled: s.enabled !== false,
    department_keys: Array.isArray(s.departmentKeys) ? s.departmentKeys : [],
    created_by: actor,
    updated_by: actor,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'code' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ? mapRow(data as SystemBonusRow) : null, error: null };
}

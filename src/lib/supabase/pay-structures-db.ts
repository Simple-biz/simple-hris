import { createSupabaseServiceRoleClient } from './server';
import { PAY_CURRENCIES, type PayStructure, type PayCurrency } from '@/lib/payment-catalog/pay-structure';

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
    // Read every supported currency, not just USD/PHP: COP structures exist
    // (add_cop_currency.sql) and hardcoding the pair silently re-denominated a
    // Colombian rate as pesos — which a Certificate of Engagement would then
    // print as ₱18,500/hr instead of COP 18,500.
    currency: ((PAY_CURRENCIES as readonly string[]).includes(r.currency)
      ? r.currency
      : 'PHP') as PayCurrency,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function listPayStructures(): Promise<{ structures: PayStructure[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  // A missing client must be an ERROR, not an empty catalog: every consumer
  // treats "no structures" as "nobody has a catalog rate" and silently falls
  // back to sheet rates — the exact drift the catalog exists to prevent.
  if (!supabase) return { structures: [], error: 'Supabase service-role client unavailable' };
  // Page through everything: a single select is capped by PostgREST max-rows
  // (commonly 1000), and with ascending order the NEWEST structures — the most
  // recently set rates — would be the ones silently dropped at the cap.
  const rows: PayRow[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) return { structures: [], error: error.message };
    rows.push(...((data ?? []) as PayRow[]));
    if (!data || data.length < SIZE) break;
  }
  return { structures: rows.map(mapRow), error: null };
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

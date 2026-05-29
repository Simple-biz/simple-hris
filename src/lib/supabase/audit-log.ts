import { createSupabaseServiceRoleClient } from './server';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'settings.rule.toggle'
  | 'settings.ot.global'
  | 'settings.ot.department'
  // Payroll Wizard lifecycle + edits
  | 'wizard.opened'
  | 'wizard.cycle_selected'
  | 'wizard.edited'
  | 'wizard.bonus_edited'
  | 'wizard.addition_edited'
  | 'wizard.fx_rate_changed'
  // Contractor decisions
  | 'contractor.decided'
  // Orphanage / tenure / gift decisions
  | 'orphanage.budget_decided'
  | 'orphanage.dispatched'
  | 'tenure.gift_decided'
  | 'gift.payment_edited'
  // Dispatch lifecycle
  | 'dispatch.lock_acquired'
  | 'dispatch.lock_released'
  | 'payment.dispatched'
  | 'paystubs.dispatched';

/**
 * Cycle context attached to every payroll-wizard audit event so the Reports
 * tab can scope events to a cycle. Stored under `details.cycle` so consumers
 * can filter via `details->'cycle'->>'source_file'`.
 */
export type AuditCycleContext = {
  source_file?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  cycle_id?: string | null;
  fx_rate?: number | null;
};

export type AuditLogEntry = {
  id: string;
  user_name: string;
  user_role: string;
  action: AuditAction | string;
  resource: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

export type NewAuditLog = {
  user_name: string;
  user_role: string;
  action: AuditAction | string;
  resource: string;
  resource_id?: string | null;
  details?: Record<string, unknown> | null;
  ip_address?: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function insertAuditLog(entry: NewAuditLog): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase.from('audit_log').insert({
    user_name:   entry.user_name,
    user_role:   entry.user_role,
    action:      entry.action,
    resource:    entry.resource,
    resource_id: entry.resource_id ?? null,
    details:     entry.details ?? null,
    ip_address:  entry.ip_address ?? null,
  });

  return { error: error?.message ?? null };
}

export async function clearAuditLog(): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase.from('audit_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  return { error: error?.message ?? null };
}

export async function fetchAuditLog(limit = 100): Promise<{ rows: AuditLogEntry[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('audit_log')
    .select('id, user_name, user_role, action, resource, resource_id, details, ip_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  return { rows: (data ?? []) as AuditLogEntry[], error: error?.message ?? null };
}

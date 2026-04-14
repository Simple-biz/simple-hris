import { createSupabaseServiceRoleClient } from './server';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'settings.rule.toggle'
  | 'settings.ot.global'
  | 'settings.ot.department';

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

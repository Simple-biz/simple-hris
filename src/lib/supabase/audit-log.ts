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
  | 'paystubs.dispatched'
  // External bank-info self-update (public /update-bank-info link)
  | 'bank_update.otp_requested'
  | 'bank_update.otp_verified'
  | 'bank_update.otp_verify_failed'
  | 'bank_update.saved';

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

// ─── Recent bank changes (People-tab feed) ──────────────────────────────────────

/** Audit actions that represent an actual bank/payout CHANGE (not just an OTP step). */
export const BANK_CHANGE_ACTIONS = ['bank_update.saved'] as const;

/** One self-service bank/payout change, shaped for the People-tab live feed. Carries
 *  WHO + WHEN + WHICH FIELD NAMES + processor — never the account values themselves. */
export type BankChangeEntry = {
  id: string;
  /** Employee display name (falls back to their work email). */
  name: string;
  /** Work email the change was keyed to (audit `resource_id`). */
  email: string | null;
  /** Snake_case payout field names that were written this save. */
  fields: string[];
  /** Preferred processor at save time, if set (e.g. "wires", "wise"). */
  processor: string | null;
  /** True when this save created the employee's first payout record. */
  createdNew: boolean;
  /** Channel the change came through (e.g. "external_link"). */
  via: string | null;
  ip_address: string | null;
  created_at: string;
};

/**
 * Most recent self-service bank/payout changes, newest first. Sourced from the
 * append-only `audit_log` (the `bank_update.saved` events written by the external
 * /update-bank-info save route), so the feed needs no extra table. Field VALUES
 * are never logged — only the field names — so this is safe to surface in People.
 */
export async function fetchRecentBankChanges(
  limit = 50,
): Promise<{ rows: BankChangeEntry[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('audit_log')
    .select('id, user_name, action, resource_id, details, ip_address, created_at')
    .in('action', BANK_CHANGE_ACTIONS as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };

  const rows: BankChangeEntry[] = (data ?? []).map((r: Record<string, unknown>) => {
    const details = (r.details ?? {}) as Record<string, unknown>;
    const rawFields = details.fields;
    const fields = Array.isArray(rawFields) ? rawFields.map((f) => String(f)) : [];
    return {
      id: String(r.id),
      name: ((r.user_name as string | null) ?? '').trim() || ((r.resource_id as string | null) ?? '—'),
      email: (r.resource_id as string | null) ?? null,
      fields,
      processor: details.processor != null ? String(details.processor) : null,
      createdNew: details.created === true,
      via: details.via != null ? String(details.via) : null,
      ip_address: (r.ip_address as string | null) ?? null,
      created_at: String(r.created_at),
    };
  });

  return { rows, error: null };
}

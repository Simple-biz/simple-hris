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
  | 'contractor.retracted'
  // Orphanage / tenure / gift decisions
  | 'orphanage.budget_decided'
  | 'orphanage.dispatched'
  // Orphanage 3rd-party vendors + SIMPLE-branded invoices (self-contained;
  // NOT part of Payment Dispatch)
  | 'orphanage.vendor.saved'
  | 'orphanage.vendor.deleted'
  | 'orphanage.vendor_invoice.created'
  | 'orphanage.vendor_invoice.updated'
  | 'orphanage.vendor_invoice.paid'
  | 'orphanage.vendor_invoice.deleted'
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
  | 'bank_update.saved'
  // HR Dashboard — pending hires / onboarding pipeline
  | 'hr.pending.created'
  | 'hr.pending.bulk_promoted'
  | 'hr.pending.bulk_unpromoted'
  | 'hr.pending.promoted'
  | 'hr.pending.unpromoted'
  | 'hr.pending.updated'
  | 'hr.hire.deleted'
  | 'hr.onboarding.submitted'
  | 'hr.orientation.marked'
  | 'hr.orientation.cleared'
  | 'hr.onboarding.link_created'
  | 'hr.onboarding.archived'
  | 'hr.onboarding.deleted'
  | 'hr.pay_plan.uploaded'
  | 'hr.pay_plan.deleted'
  // HR Dashboard — New Hire Checklist
  | 'hr.new_hire_checklist.saved'
  | 'hr.new_hire_checklist.locked'
  | 'hr.new_hire_checklist.reopened'
  // HR Dashboard — Gift Tracker
  | 'gift.tracker_note_saved'
  | 'gift.catalog_saved'
  // HR Dashboard — Announcements
  | 'announcement.posted'
  | 'announcement.pin_toggled'
  | 'announcement.deleted'
  // HRIS Updates — Kanban ticket board (/tickets)
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.moved'
  | 'ticket.deleted'
  | 'ticket.commented';

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

/**
 * Last successful Google-Sheet sync per source, read straight from the audit
 * trail each sync already writes (`csv.master.sync` / `csv.rates.sync` /
 * `csv.hsl.sync`). No separate persistence needed, and cron-triggered syncs are
 * captured the same as manual ones since both go through the same routes.
 * Powers the "Last synced" line on the Payroll Wizard's Initialize step.
 */
export async function fetchLastSyncTimestamps(): Promise<{
  master: string | null;
  rates: string | null;
  hsl: string | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { master: null, rates: null, hsl: null, error: 'Supabase not configured' };

  const latest = async (action: string): Promise<string | null> => {
    const { data, error } = await supabase
      .from('audit_log')
      .select('created_at')
      .eq('action', action)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.created_at as string | undefined) ?? null;
  };

  try {
    const [master, rates, hsl] = await Promise.all([
      latest('csv.master.sync'),
      latest('csv.rates.sync'),
      latest('csv.hsl.sync'),
    ]);
    return { master, rates, hsl, error: null };
  } catch (e) {
    return {
      master: null,
      rates: null,
      hsl: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Bank changes ────────────────────────────────────────────────────────────
// The People-tab bank-change feed/history now reads from the dedicated
// `bank_update_history` table (src/lib/supabase/bank-update-history.ts) instead
// of audit_log — see that file's header comment for why. `bank_update.saved`
// audit_log rows are still written for the general Audit Log admin view.

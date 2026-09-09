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
  // Payroll readiness fixers (Set rate / KPI Mark-Ready) — carry a `source` in
  // details so a wizard-driven fix is distinguishable from the normal surface.
  | 'payroll.rate.set'
  | 'payroll.kpi.marked_ready'
  | 'payroll.kpi.locked'
  | 'payroll.kpi.reopened'
  // Bank Info "Temporary Exemption" — a per-week acknowledgement that moves
  // someone off the missing-bank list (and out of the score) onto Exceptions.
  | 'payroll.bank.exempted'
  | 'payroll.bank.exemption_undone'
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
  // Undo / "Clear problem" — the dispatch row is DELETED, so the audit event
  // carries the full snapshot of the payment (who, value, cycle, original payer).
  | 'payment.undone'
  | 'paystubs.dispatched'
  // External bank-info self-update (public /update-bank-info link)
  | 'bank_update.otp_requested'
  | 'bank_update.otp_verified'
  | 'bank_update.otp_verify_failed'
  | 'bank_update.saved'
  | 'bank_override.saved'
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
  // Manager -> My Team list "Suspend" / "Reactivation": Workspace account
  // disabled / re-enabled via the n8n temp-pause webhooks. Suspend-only —
  // nothing is deleted, no offboard stamps.
  | 'manager.suspended'
  | 'manager.reactivated'
  // HRIS Updates — Kanban ticket board (/tickets)
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.moved'
  | 'ticket.deleted'
  | 'ticket.commented'
  // Penny AI. One event per tool-using turn, naming which tools ran — never the
  // figures they returned. `ceo_assistant.query` / `admin_assistant.query`
  // predate this union and are still emitted as free-form strings by their
  // routes; only the employee assistant is declared here so far.
  | 'employee_assistant.query';

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

/**
 * A failed audit write used to be invisible: 182 of the 228 call sites are
 * `void insertAuditLog(...)`, and the `{ error }` this returns went unread. A
 * lost event is indistinguishable from an action that never happened, so the
 * failure is at least shouted into the server log where it can be found.
 *
 * Callers on a destructive path must go further and READ the returned error —
 * see `purgeAuditLogBefore` and the orphanage/HSL delete routes, which write
 * the event first and abort the delete if it fails.
 */
function reportAuditWriteFailure(
  entries: NewAuditLog[],
  error: string,
): void {
  console.error('[audit] write FAILED — event lost', {
    error,
    count: entries.length,
    actions: [...new Set(entries.map((e) => e.action))],
    resources: [...new Set(entries.map((e) => e.resource))],
  });
}

export async function insertAuditLog(entry: NewAuditLog): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    reportAuditWriteFailure([entry], 'Supabase not configured');
    return { error: 'Supabase not configured' };
  }

  const { error } = await supabase.from('audit_log').insert({
    user_name:   entry.user_name,
    user_role:   entry.user_role,
    action:      entry.action,
    resource:    entry.resource,
    resource_id: entry.resource_id ?? null,
    details:     entry.details ?? null,
    ip_address:  entry.ip_address ?? null,
  });

  if (error) reportAuditWriteFailure([entry], error.message);
  return { error: error?.message ?? null };
}

/**
 * Bulk variant of {@link insertAuditLog} — one insert request for N events.
 * Used by batch operations (e.g. a multi-select Undo in Payment Dispatch)
 * where per-row events are wanted without N round-trips.
 */
export async function insertAuditLogs(entries: NewAuditLog[]): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    reportAuditWriteFailure(entries, 'Supabase not configured');
    return { error: 'Supabase not configured' };
  }
  if (entries.length === 0) return { error: null };

  const { error } = await supabase.from('audit_log').insert(
    entries.map((entry) => ({
      user_name:   entry.user_name,
      user_role:   entry.user_role,
      action:      entry.action,
      resource:    entry.resource,
      resource_id: entry.resource_id ?? null,
      details:     entry.details ?? null,
      ip_address:  entry.ip_address ?? null,
    })),
  );

  if (error) reportAuditWriteFailure(entries, error.message);
  return { error: error?.message ?? null };
}

const AUDIT_SELECT =
  'id, user_name, user_role, action, resource, resource_id, details, ip_address, created_at';

/** Oldest cutoff a retention purge may be given: nothing inside 90 days goes. */
export const AUDIT_PURGE_MIN_AGE_DAYS = 90;

/**
 * Delete audit events strictly older than `beforeIso`, returning how many went.
 *
 * This replaced `clearAuditLog()`, which truncated the ENTIRE table behind the
 * panel's "Clear" button. That was the most destructive action in the app and
 * the one action that could not, by construction, leave a trace of itself —
 * against `docs/features/delete-authorization.md`'s rule that audit logging is
 * "proportional to the destructiveness".
 *
 * The caller (`DELETE /api/audit-log`) writes the `audit.purged` event FIRST and
 * abandons the purge if that write fails, so an emptied window always has a row
 * above it naming who emptied it. The `AUDIT_PURGE_MIN_AGE_DAYS` floor is
 * enforced in the route, where the actor and the request are available.
 */
export async function purgeAuditLogBefore(
  beforeIso: string,
): Promise<{ deleted: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: 0, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('audit_log')
    .delete()
    .lt('created_at', beforeIso)
    .select('id');

  return { deleted: data?.length ?? 0, error: error?.message ?? null };
}

/** How many events are older than `beforeIso` — the purge preview. */
export async function countAuditLogBefore(
  beforeIso: string,
): Promise<{ count: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { count: 0, error: 'Supabase not configured' };

  const { count, error } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .lt('created_at', beforeIso);

  // A `head: true` count cannot distinguish "no rows" from "no table" on its
  // own — check the error before believing a zero.
  if (error) return { count: 0, error: error.message };
  return { count: count ?? 0, error: null };
}

export type AuditLogQuery = {
  /** One or more comma-separated action prefixes, e.g. `'orphanage_,pab_dispute.'`. */
  actionPrefix?: string | null;
  /** Only events by this actor: exact for an email, contains otherwise. */
  actor?: string | null;
  /** Inclusive lower bound, `YYYY-MM-DD` (Asia/Manila) or a full ISO stamp. */
  since?: string | null;
  /** Inclusive upper bound, `YYYY-MM-DD` (Asia/Manila) or a full ISO stamp. */
  until?: string | null;
  /** Keyset cursor: only events strictly older than this `created_at`. */
  before?: string | null;
  limit?: number;
};

export type AuditLogPage = {
  rows: AuditLogEntry[];
  /** `created_at` to pass back as `before` for the next page; null at the end. */
  nextCursor: string | null;
  hasMore: boolean;
  error: string | null;
};

const MANILA_OFFSET = '+08:00';
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Day bounds are Manila days — the same convention Penny's tools use. */
function lowerBound(value: string): string {
  return DAY_ONLY.test(value) ? `${value}T00:00:00${MANILA_OFFSET}` : value;
}

function upperBound(value: string): string {
  if (!DAY_ONLY.test(value)) return value;
  // Exclusive next midnight, so the last second of `until` is included.
  const next = new Date(`${value}T00:00:00${MANILA_OFFSET}`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Strip anything that could morph a PostgREST filter out of a prefix. */
function safePrefix(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/**
 * One page of the audit log, filtered SERVER-side.
 *
 * The old signature was `fetchAuditLog(limit = 100)` and the Admin panel called
 * it with 500, then filtered and searched that slice in the browser. With 17k+
 * rows and 151 distinct actions, any question about an event older than the
 * newest 500 answered "no results" — the same "a window presented as history"
 * failure that memory/penny-audit-log-visibility.md fixed for Penny's tools and
 * left standing on the human-facing panel. Filters now go to Postgres, and
 * paging is keyset (`before`) rather than `.range()`, which the PostgREST
 * 1000-row cap silently truncates.
 */
export async function fetchAuditLog(query: AuditLogQuery = {}): Promise<AuditLogPage> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], nextCursor: null, hasMore: false, error: 'Supabase not configured' };

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);

  let q = supabase
    .from('audit_log')
    .select(AUDIT_SELECT)
    .order('created_at', { ascending: false })
    // One extra row is the "is there another page" probe; it is never returned.
    .limit(limit + 1);

  const prefixes = (query.actionPrefix ?? '')
    .split(',')
    .map(safePrefix)
    .filter(Boolean);
  if (prefixes.length > 0) {
    q = q.or(prefixes.map((p) => `action.ilike.${p}%`).join(','));
  }

  const actor = (query.actor ?? '').trim().toLowerCase();
  if (actor) {
    // Some writers stamp `user_name` with a display name rather than an email,
    // so an email matches exactly and anything else matches as a fragment.
    q = actor.includes('@')
      ? q.ilike('user_name', actor.replace(/[%,()]/g, ''))
      : q.ilike('user_name', `%${actor.replace(/[%,()]/g, '')}%`);
  }

  if (query.since) q = q.gte('created_at', lowerBound(query.since));
  if (query.until) q = q.lt('created_at', upperBound(query.until));
  if (query.before) q = q.lt('created_at', query.before);

  const { data, error } = await q;
  if (error) return { rows: [], nextCursor: null, hasMore: false, error: error.message };

  const all = (data ?? []) as AuditLogEntry[];
  const hasMore = all.length > limit;
  const rows = hasMore ? all.slice(0, limit) : all;

  return {
    rows,
    hasMore,
    nextCursor: hasMore ? (rows[rows.length - 1]?.created_at ?? null) : null,
    error: null,
  };
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

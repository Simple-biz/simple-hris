/**
 * [WIZARD-TUTORIAL] Week-scoped audit fetch for the Processing Narrative.
 *
 * Unlike `cycle-audit.ts` (keyed by source_file), this reads a CALENDAR
 * window — the Sun–Sat payroll week — because the narrative's job is to show
 * every Start/Stop Processing toggle and everything recorded around them,
 * regardless of which cycle was active and whether processing was on.
 *
 * The client computes the window in ITS timezone and sends explicit instants;
 * the server never guesses week boundaries.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { CYCLE_AUDIT_ACTIONS } from '@/lib/audit/cycle-audit';
import type { AuditLogEntry } from '@/lib/supabase/audit-log';

/**
 * Everything the narrative reports on: the cycle-audit whitelist plus the
 * payroll-readiness fixers and decision retractions/undos that the per-cycle
 * time-window deliberately leaves out (they carry cycle context there; here
 * the week window itself is the scope, so they belong).
 */
export const WEEK_AUDIT_ACTIONS: string[] = [
  ...CYCLE_AUDIT_ACTIONS,
  'payment.undone',
  'contractor.retracted',
  'payroll.rate.set',
  'payroll.kpi.marked_ready',
  'payroll.kpi.locked',
  'payroll.kpi.reopened',
  'payroll.bank.exempted',
  'payroll.bank.exemption_undone',
];

/** Narrative rows skip `ip_address` — the story never needs it. */
export type WeekAuditEvent = Omit<AuditLogEntry, 'ip_address'>;

const EVENT_SELECT =
  'id, user_name, user_role, action, resource, resource_id, details, created_at';

const MAX_WINDOW_MS = 8 * 24 * 3600 * 1000; // one week + slack; never a bulk export

export type WeekAuditResult = {
  events: WeekAuditEvent[] | null;
  error: string | null;
};

export async function getWeekAuditEvents(
  windowStartIso: string,
  windowEndIso: string,
): Promise<WeekAuditResult> {
  const start = Date.parse(windowStartIso);
  const end = Date.parse(windowEndIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { events: null, error: 'window_start and window_end must be ISO instants' };
  }
  if (end <= start) {
    return { events: null, error: 'window_end must be after window_start' };
  }
  if (end - start > MAX_WINDOW_MS) {
    return { events: null, error: 'Window may not exceed one week' };
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return { events: null, error: 'Supabase not configured' };
  }

  // Paged — audit_log rows for a busy processing week can pass the PostgREST
  // 1000-row cap (db.max-rows truncates silently, even with .range()).
  const { rows, error } = await selectAllPaged<WeekAuditEvent>((from, to) =>
    supabase
      .from('audit_log')
      .select(EVENT_SELECT)
      .in('action', WEEK_AUDIT_ACTIONS)
      .gte('created_at', new Date(start).toISOString())
      .lt('created_at', new Date(end).toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) return { events: null, error };
  return { events: rows, error: null };
}

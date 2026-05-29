/**
 * Cycle-scoped audit query.
 *
 * Combines two strategies to surface every event relevant to a payroll cycle:
 *
 * 1. **Explicit cycle context** — events whose `details.cycle.source_file`
 *    matches the cycle. Written by the Payroll Wizard (`wizard.opened`,
 *    `wizard.edited`, `payment.dispatched`, etc.).
 *
 * 2. **Time-window fallback** — events without cycle context whose timestamp
 *    falls inside the cycle period AND whose `action` is in a whitelist
 *    of payroll-relevant actions. Catches things decided outside the wizard
 *    (orphanage budget approvals, contractor decisions, settings tweaks)
 *    that still affected this cycle's payout.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getDisbursementReportDetail } from '@/lib/payroll/disbursement-reports';
import type { AuditLogEntry } from '@/lib/supabase/audit-log';

/** Actions surfaced in the cycle audit trail. Keep in sync with AuditAction. */
export const CYCLE_AUDIT_ACTIONS = [
  // Wizard lifecycle
  'wizard.opened',
  'wizard.cycle_selected',
  'wizard.edited',
  'wizard.bonus_edited',
  'wizard.addition_edited',
  'wizard.fx_rate_changed',
  // Decisions
  'contractor.decided',
  'orphanage.budget_decided',
  'orphanage.dispatched',
  'orphanage_budget.approved',
  'orphanage_budget.rejected',
  'tenure.gift_decided',
  'gift.payment_edited',
  // Dispatch
  'dispatch.lock_acquired',
  'dispatch.lock_released',
  'payment.dispatched',
  'paystubs.dispatched',
];

export type CycleAuditEvent = AuditLogEntry & {
  /** True when the event was tagged with explicit cycle context (vs caught by time-window fallback). */
  matched_via: 'cycle_context' | 'time_window';
};

export type CycleAuditBundle = {
  cycleId: string | null;
  sourceFile: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reportName: string;
  events: CycleAuditEvent[];
};

const EVENT_SELECT =
  'id, user_name, user_role, action, resource, resource_id, details, ip_address, created_at';

type ResolvedCycle = {
  cycleId: string | null;
  sourceFile: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reportName: string;
};

/**
 * Core fetcher — given a resolved cycle (any combination of source_file +
 * period bounds), pull every audit event tied to it. Used by both the
 * cycleId-keyed reports endpoint and the wizard-keyed source_file endpoint.
 */
async function fetchEventsForResolvedCycle(
  resolved: ResolvedCycle,
): Promise<{ bundle: CycleAuditBundle | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return {
      bundle: { ...resolved, events: [] },
      error: 'Supabase not configured',
    };
  }

  // 1) Explicit cycle-context events — keyed by source_file in details JSONB.
  let explicitRows: AuditLogEntry[] = [];
  if (resolved.sourceFile) {
    const { data, error } = await supabase
      .from('audit_log')
      .select(EVENT_SELECT)
      .eq('details->cycle->>source_file', resolved.sourceFile)
      .order('created_at', { ascending: true });
    if (error) return { bundle: null, error: error.message };
    explicitRows = (data ?? []) as AuditLogEntry[];
  }

  // 2) Time-window fallback — whitelisted actions inside the cycle period
  //    that don't carry explicit cycle context (e.g. orphanage budget
  //    approvals decided from the Accounting orphanage dashboard).
  let fallbackRows: AuditLogEntry[] = [];
  if (resolved.periodStart && resolved.periodEnd) {
    const lo = `${resolved.periodStart}T00:00:00Z`;
    const endPlusOne = new Date(`${resolved.periodEnd}T00:00:00Z`);
    endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
    const hi = endPlusOne.toISOString();

    const { data, error } = await supabase
      .from('audit_log')
      .select(EVENT_SELECT)
      .in('action', CYCLE_AUDIT_ACTIONS)
      .gte('created_at', lo)
      .lte('created_at', hi)
      .order('created_at', { ascending: true });
    if (error) return { bundle: null, error: error.message };
    fallbackRows = (data ?? []) as AuditLogEntry[];
  }

  const explicitIds = new Set(explicitRows.map((r) => r.id));
  const merged: CycleAuditEvent[] = [
    ...explicitRows.map((r) => ({ ...r, matched_via: 'cycle_context' as const })),
    ...fallbackRows
      .filter((r) => !explicitIds.has(r.id))
      .map((r) => ({ ...r, matched_via: 'time_window' as const })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    bundle: { ...resolved, events: merged },
    error: null,
  };
}

/**
 * Resolve the cycle by `cycleId` (via the disbursement report listing) and
 * fetch every audit event tied to it. Used by the standalone Reports tab.
 */
export async function getCycleAuditTrail(
  cycleId: string,
): Promise<{ bundle: CycleAuditBundle | null; error: string | null }> {
  const { report, error: reportErr } = await getDisbursementReportDetail(cycleId);
  if (reportErr || !report) {
    return { bundle: null, error: reportErr ?? 'Cycle not found' };
  }
  return fetchEventsForResolvedCycle({
    cycleId,
    sourceFile: report.sourceFile,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    reportName: report.reportName,
  });
}

/**
 * Fetch the audit trail by Hubstaff source file directly — used by the
 * Payroll Wizard, which knows the active filename but may not yet have a
 * cycleId (no disbursement records persisted until dispatch).
 *
 * `periodStart` / `periodEnd` are optional — the wizard derives them by
 * parsing the filename, but the helper still works without them (events
 * tagged with explicit cycle context will be returned).
 */
export async function getCycleAuditTrailBySourceFile(opts: {
  sourceFile: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  reportName?: string | null;
}): Promise<{ bundle: CycleAuditBundle | null; error: string | null }> {
  if (!opts.sourceFile || !opts.sourceFile.trim()) {
    return { bundle: null, error: 'sourceFile is required' };
  }
  return fetchEventsForResolvedCycle({
    cycleId: null,
    sourceFile: opts.sourceFile,
    periodStart: opts.periodStart ?? null,
    periodEnd: opts.periodEnd ?? null,
    reportName: opts.reportName?.trim() || opts.sourceFile,
  });
}

// ─── CSV serialization ───────────────────────────────────────────────────────

const CSV_COLUMNS: { key: string; header: string }[] = [
  { key: 'timestamp',    header: 'Timestamp' },
  { key: 'user_name',    header: 'User' },
  { key: 'user_role',    header: 'Role' },
  { key: 'action',       header: 'Action' },
  { key: 'resource',     header: 'Resource' },
  { key: 'resource_id',  header: 'Resource ID' },
  { key: 'employee',     header: 'Employee' },
  { key: 'field',        header: 'Field' },
  { key: 'old_value',    header: 'Old value' },
  { key: 'new_value',    header: 'New value' },
  { key: 'amount_usd',   header: 'Amount (USD)' },
  { key: 'amount_php',   header: 'Amount (PHP)' },
  { key: 'fx_rate',      header: 'FX rate (PHP per USD)' },
  { key: 'cycle_file',   header: 'Cycle file' },
  { key: 'matched_via',  header: 'Matched via' },
  { key: 'ip_address',   header: 'IP' },
  { key: 'details_raw',  header: 'Full details (JSON)' },
];

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function pick(details: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!details) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(details, k) && details[k] != null) {
      return details[k];
    }
  }
  return null;
}

function pickCycle(
  details: Record<string, unknown> | null | undefined,
  key: 'source_file' | 'fx_rate',
): unknown {
  if (!details) return null;
  const cycle = details.cycle as Record<string, unknown> | undefined;
  if (cycle && cycle[key] != null) return cycle[key];
  return null;
}

/** Flatten an audit event into a CSV-friendly row. */
export function cycleAuditEventToCsvRow(ev: CycleAuditEvent): Record<string, string> {
  const d = ev.details ?? {};
  return {
    timestamp:    ev.created_at,
    user_name:    ev.user_name,
    user_role:    ev.user_role,
    action:       ev.action,
    resource:     ev.resource,
    resource_id:  ev.resource_id ?? '',
    employee:     asString(
      pick(d, 'employee_email', 'recipient_email', 'submitter_email', 'contractor_email'),
    ),
    field:        asString(pick(d, 'field', 'field_edited')),
    old_value:    asString(pick(d, 'old_value', 'previous_status', 'previous_value')),
    new_value:    asString(pick(d, 'new_value', 'new_status', 'status')),
    amount_usd:   asString(pick(d, 'amount_usd', 'total_usd')),
    amount_php:   asString(pick(d, 'amount_php', 'final_amount')),
    fx_rate:      asString(pickCycle(d, 'fx_rate') ?? pick(d, 'fx_rate', 'usd_to_php_rate')),
    cycle_file:   asString(pickCycle(d, 'source_file')),
    matched_via:  ev.matched_via,
    ip_address:   ev.ip_address ?? '',
    details_raw:  asString(d),
  };
}

export function cycleAuditCsv(events: CycleAuditEvent[]): string {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const body = events.map((ev) => {
    const row = cycleAuditEventToCsvRow(ev);
    return CSV_COLUMNS.map((c) => csvEscape(row[c.key])).join(',');
  });
  // UTF-8 BOM so Excel auto-detects encoding.
  return '﻿' + [header, ...body].join('\r\n');
}

export function cycleAuditFilename(
  cycleId: string,
  periodStart: string | null,
  periodEnd: string | null,
): string {
  if (periodStart && periodEnd) {
    return `audit-trail-${periodStart}_${periodEnd}.csv`;
  }
  const safe = cycleId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `audit-trail-${safe}.csv`;
}

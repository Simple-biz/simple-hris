/**
 * Client-side formatters for audit events — used by the Payroll Wizard's
 * XLSX export to embed an "Audit Log" sheet alongside Salaries / Budget /
 * Gifts. Mirrors the columns of the server-side CSV export so both formats
 * read identically.
 */

export type ClientAuditEvent = {
  id: string;
  created_at: string;
  user_name: string;
  user_role: string;
  action: string;
  resource: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  matched_via: 'cycle_context' | 'time_window';
};

function pick(
  details: Record<string, unknown> | null | undefined,
  ...keys: string[]
): unknown {
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

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Column shape for the "Audit Log" XLSX sheet. Matches the server CSV export.
 */
export const AUDIT_AOA_HEADER: string[] = [
  'Timestamp',
  'User',
  'Role',
  'Action',
  'Resource',
  'Resource ID',
  'Employee',
  'Field',
  'Old value',
  'New value',
  'Amount (USD)',
  'Amount (PHP)',
  'FX rate (PHP per USD)',
  'Cycle file',
  'Matched via',
  'IP',
  'Full details (JSON)',
];

/** Flatten one audit event into the AoA row matching AUDIT_AOA_HEADER. */
export function auditEventToAoaRow(ev: ClientAuditEvent): (string | number | null)[] {
  const d = ev.details ?? {};
  return [
    ev.created_at,
    ev.user_name,
    ev.user_role,
    ev.action,
    ev.resource,
    ev.resource_id ?? '',
    asString(pick(d, 'employee_email', 'recipient_email', 'submitter_email', 'contractor_email')),
    asString(pick(d, 'field', 'field_edited')),
    asString(pick(d, 'old_value', 'previous_status', 'previous_value')),
    asString(pick(d, 'new_value', 'new_status', 'status')),
    asString(pick(d, 'amount_usd', 'total_usd')),
    asString(pick(d, 'amount_php', 'final_amount')),
    asString(pickCycle(d, 'fx_rate') ?? pick(d, 'fx_rate', 'usd_to_php_rate')),
    asString(pickCycle(d, 'source_file')),
    ev.matched_via,
    ev.ip_address ?? '',
    asString(d),
  ];
}

/**
 * Build the full AoA (header + body) for the "Audit Log" sheet. When `events`
 * is empty the sheet still gets the header row so reviewers don't see a
 * confusing blank tab.
 */
export function auditEventsToAoa(events: ClientAuditEvent[]): (string | number | null)[][] {
  return [AUDIT_AOA_HEADER, ...events.map(auditEventToAoaRow)];
}

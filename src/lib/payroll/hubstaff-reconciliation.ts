/**
 * Shared model for the "Hubstaff ↔ Master matches" reconciliation — the drill-down
 * behind that System Overview tile on both the Accounting and CEO dashboards.
 *
 * One row per person, tagged with a Status so the three groups the tile counts
 * are all covered:
 *   - "On Master & worked"         → directory employee who logged hours
 *   - "On Master, no hours"        → directory employee with NO Hubstaff hours
 *   - "In Hubstaff, not on Master" → logged hours but missing from the directory
 *
 * The Accounting Overview builds these rows client-side (with rich no-hours
 * reasons) and BOTH renders them in the modal AND publishes them into its hero
 * snapshot so the CEO board shows a byte-identical drill-down. Keep this the
 * single source of truth for the row shape + CSV serialization.
 */

export type HubstaffReconStatus =
  | 'On Master & worked'
  | 'On Master, no hours'
  | 'Exempt — no Hubstaff'
  | 'In Hubstaff, not on Master';

/** Status literal for a directory employee whose department has no Hubstaff by
 *  nature — exported so callers tag rows without repeating the magic string. */
export const HUBSTAFF_EXEMPT_STATUS = 'Exempt — no Hubstaff';

/**
 * Departments that legitimately have NO Hubstaff time tracking — freelance /
 * project-based teams billed by deliverable, not by tracked hours. A person in
 * one of these depts with no Hubstaff hours is NOT a reconciliation gap; it's
 * expected. The "Reconcile gaps" count and the "On Master, no hours" bucket
 * exclude them, and the drill-down surfaces them under their own "Exempt"
 * status instead. Matched case-insensitively against the raw Department label.
 */
const HUBSTAFF_EXEMPT_DEPTS = new Set(['smm freelancer', 'site building']);

export function isHubstaffExemptDept(department: string | null | undefined): boolean {
  if (!department) return false;
  return HUBSTAFF_EXEMPT_DEPTS.has(department.trim().toLowerCase());
}

export interface HubstaffMasterRow {
  /** One of the three HubstaffReconStatus values (typed loosely for JSON round-trips). */
  status: string;
  /** Best-guess explanation for a no-hours / off-directory row (may be empty). */
  reason: string;
  name: string;
  workEmail: string;
  personalEmail: string;
  department: string;
  /** Hours logged this scope, formatted to 2 decimals, or '' when none. */
  hours: string;
}

/** Group order so the actionable rows cluster (worked → no hours → off-directory). */
export const HUBSTAFF_RECON_ORDER: Record<string, number> = {
  'On Master & worked': 0,
  'On Master, no hours': 1,
  'Exempt — no Hubstaff': 2,
  'In Hubstaff, not on Master': 3,
};

/** Visual tone for each status badge, shared by the modal chips + row badges. */
export const HUBSTAFF_RECON_TONE: Record<string, 'ok' | 'neutral' | 'warn'> = {
  'On Master & worked': 'ok',
  'On Master, no hours': 'neutral',
  'Exempt — no Hubstaff': 'neutral',
  'In Hubstaff, not on Master': 'warn',
};

/** Group first (worked → no hours → off-directory), then alphabetically by name. */
export function sortHubstaffReconRows(rows: HubstaffMasterRow[]): HubstaffMasterRow[] {
  return [...rows].sort((a, b) => {
    const so = (HUBSTAFF_RECON_ORDER[a.status] ?? 9) - (HUBSTAFF_RECON_ORDER[b.status] ?? 9);
    if (so !== 0) return so;
    return (a.name || a.workEmail).localeCompare(b.name || b.workEmail, undefined, {
      sensitivity: 'base',
    });
  });
}

/** Free-text filter across every column (name / emails / department / status / reason). */
export function filterHubstaffReconRows(
  rows: HubstaffMasterRow[],
  query: string,
): HubstaffMasterRow[] {
  const term = query.trim().toLowerCase();
  if (!term) return rows;
  return rows.filter((r) =>
    [r.name, r.workEmail, r.personalEmail, r.department, r.status, r.reason].some((v) =>
      (v ?? '').toLowerCase().includes(term),
    ),
  );
}

/** Serialize the reconciliation rows to CSV text (Excel-safe quoting). */
export function hubstaffReconToCsv(rows: HubstaffMasterRow[]): string {
  const headers = ['Status', 'Reason', 'Name', 'Work Email', 'Personal Email', 'Department', 'Hours'];
  const body = rows.map((r) =>
    [r.status, r.reason, r.name, r.workEmail, r.personalEmail, r.department, r.hours]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
      .join(','),
  );
  return [headers.map((h) => `"${h}"`).join(','), ...body].join('\n');
}

/** Trigger a browser download of the reconciliation CSV. No-ops server-side. */
export function downloadHubstaffReconCsv(rows: HubstaffMasterRow[], filename: string): void {
  if (typeof document === 'undefined') return;
  const csv = hubstaffReconToCsv(rows);
  // Prepend a UTF-8 BOM so Excel reads the ↔ / accented names correctly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

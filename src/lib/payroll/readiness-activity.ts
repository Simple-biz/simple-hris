/**
 * Readiness "recent changes" feed + KPI submission attribution — the pure
 * mapping layer, split out of `payroll-readiness.ts` so it unit-tests without
 * I/O (same reasoning as `readiness-score.ts`) and stays importable from the
 * client (types only) — no `server-only`, no Supabase.
 *
 * Render-only over `audit_log` rows the write paths ALREADY produce: no new
 * tables, no new audit actions (the Processing Narrative's invariant). The
 * mapping emits fixed templates and never prints `details` verbatim — rate
 * amounts and bank fields must never reach the feed. KPI score-saves are
 * deliberately not audited (volume), so a manager mid-scoring surfaces here
 * only when they Mark Ready / Lock — Kane picked exactly this (2026-08-18,
 * blueprint Q1 = audited saves only, no presence).
 */

/** One line of the Readiness pane's bottom feed, fully composed server-side —
 *  the client renders it verbatim. */
export interface ReadinessActivityLine {
  /** ISO timestamp of the audit row. */
  at: string;
  /** Actor as the audit trail recorded them (verified session name/email). */
  actor: string | null;
  /** Human line, e.g. "set a pay rate (Payment Catalog)". Template-composed —
   *  never raw `details`. */
  label: string;
  /** Which surface the change came from — drives the line's dot tone. */
  surface: 'kpi' | 'rates' | 'bank' | 'people';
}

/** The slice of an `audit_log` row this module reads. Structural on purpose —
 *  the server passes its own fetched rows without an import cycle. */
export interface ActivityAuditRow {
  action: string;
  user_name: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
}

/** Feed window: a line older than this is no longer "someone is fixing data
 *  right now" (Kane approved 15 minutes, blueprint Q2). */
export const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

/** Newest-first cap on the feed (blueprint Q2). */
export const ACTIVITY_MAX_LINES = 8;

/** The KPI submission-transition actions (period-status route). Exported for
 *  the server's week-scoped attribution query. */
export const KPI_SUBMISSION_ACTIONS = [
  'payroll.kpi.marked_ready',
  'payroll.kpi.locked',
  'payroll.kpi.reopened',
] as const;

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const v = details?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Best-effort dept display: the audit rows carry the dept KEY the calculator
 *  posted; the composer passes key→display-name from the KPI rows it already
 *  built, and an unknown key falls back to the key itself (readable enough). */
function deptLabel(details: Record<string, unknown> | null, deptNames?: Map<string, string>): string | null {
  const key = detailString(details, 'department');
  if (!key) return null;
  return deptNames?.get(key) ?? key;
}

/** Allowlist: audited action → surface + line template. Anything not listed is
 *  dropped — the feed names payroll-relevant traffic only (rates / bank / KPI /
 *  People tab, blueprint Q3). */
const ACTIVITY_TEMPLATES: Record<
  string,
  { surface: ReadinessActivityLine['surface']; label: (details: Record<string, unknown> | null, deptNames?: Map<string, string>) => string }
> = {
  'payroll.rate.set': {
    surface: 'rates',
    label: () => 'set a pay rate (Payment Catalog)',
  },
  'employee.rates.revoke': {
    surface: 'rates',
    label: () => 'revoked a rate history row (Payment Catalog)',
  },
  'bank_update.saved': {
    surface: 'bank',
    label: () => 'updated payout details',
  },
  'people.banking.updated': {
    surface: 'bank',
    label: () => 'updated banking details (People tab)',
  },
  'people.bank_info.requested': {
    surface: 'people',
    label: () => 'requested bank info (People tab)',
  },
  'people.profile.updated': {
    surface: 'people',
    label: () => 'edited a profile (People tab)',
  },
  'department_transfer.requested': {
    surface: 'people',
    label: () => 'requested a department transfer',
  },
  'payroll.kpi.marked_ready': {
    surface: 'kpi',
    label: (d, n) => `marked ${deptLabel(d, n) ?? 'a department'}'s KPI scores ready`,
  },
  'payroll.kpi.locked': {
    surface: 'kpi',
    label: (d, n) => `locked ${deptLabel(d, n) ?? 'a department'}'s KPI scores`,
  },
  'payroll.kpi.reopened': {
    surface: 'kpi',
    label: (d, n) => `reopened ${deptLabel(d, n) ?? 'a department'}'s KPI scores`,
  },
};

/** Every action the feed query should fetch. */
export const ACTIVITY_ACTIONS = Object.keys(ACTIVITY_TEMPLATES);

/**
 * Map raw audit rows to feed lines: allowlisted actions only, inside the
 * 15-minute window ending at `nowMs`, newest first, capped. Rows with an
 * unparseable timestamp are dropped (a line that can't say WHEN is noise).
 */
export function buildActivityLines(
  rows: ActivityAuditRow[],
  nowMs: number,
  deptNames?: Map<string, string>,
): ReadinessActivityLine[] {
  const cutoff = nowMs - ACTIVITY_WINDOW_MS;
  const lines: ReadinessActivityLine[] = [];
  for (const row of rows) {
    const template = ACTIVITY_TEMPLATES[row.action];
    if (!template) continue;
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t) || t < cutoff || t > nowMs + 60_000) continue;
    lines.push({
      at: row.created_at,
      actor: row.user_name?.trim() || null,
      label: template.label(row.details, deptNames),
      surface: template.surface,
    });
  }
  lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return lines.slice(0, ACTIVITY_MAX_LINES);
}

/** Who last submitted a dept-week to Accounting, from the audit trail. */
export interface KpiSubmissionAttribution {
  by: string | null;
  at: string;
  /** The write's source_label ("Manager KPI tab" / "Payroll Wizard (Readiness)"),
   *  when the row recorded one. */
  via: string | null;
}

/**
 * Latest `payroll.kpi.*` event per department for one period. The rows come
 * from a `created_at >= periodStart` query; the period match itself happens
 * HERE against `details.period_start` (jsonb — filtering it server-side would
 * abandon the `created_at` index). A reopen counts too: the row then honestly
 * says who last touched the submission state, and the status pill beside it
 * still says whether the week is currently Ready.
 */
export function latestKpiSubmissionByDept(
  rows: ActivityAuditRow[],
  periodStart: string,
): Map<string, KpiSubmissionAttribution> {
  const out = new Map<string, KpiSubmissionAttribution>();
  for (const row of rows) {
    if (!(KPI_SUBMISSION_ACTIONS as readonly string[]).includes(row.action)) continue;
    if (detailString(row.details, 'period_start') !== periodStart) continue;
    const dept = detailString(row.details, 'department');
    if (!dept) continue;
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t)) continue;
    const prev = out.get(dept);
    if (prev && Date.parse(prev.at) >= t) continue;
    out.set(dept, {
      by: row.user_name?.trim() || null,
      at: row.created_at,
      via: detailString(row.details, 'source_label'),
    });
  }
  return out;
}

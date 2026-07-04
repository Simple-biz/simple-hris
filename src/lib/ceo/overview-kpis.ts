import 'server-only';

import { buildPeopleRoster, type PeopleRosterRow } from '@/lib/people/people-roster';
import { computeCurrentPay, type CurrentPayResult } from '@/lib/payroll/current-pay';
import { normEmail } from '@/lib/email/norm-email';
import {
  type HubstaffMasterRow,
  sortHubstaffReconRows,
} from '@/lib/payroll/hubstaff-reconciliation';
import {
  getAppSetting,
  accountingOverviewSnapshotKey,
  type AccountingOverviewSnapshot,
} from '@/lib/supabase/app-settings';
import {
  listDisbursementReports,
  loadDisbursementRecordsForCycle,
  formatDisbursementReportName,
  type DisbursementReportSummary,
} from '@/lib/payroll/disbursement-reports';

/** One bar in the "headcount by department" graph. */
export interface CeoDeptCount {
  department: string;
  count: number;
}

/** A worker in the last cycle who has not been marked paid. */
export interface CeoUnpaidWorker {
  email: string;
  name: string | null;
  /** USD owed for the cycle (snapshot from disbursement_records). */
  amountUsd: number | null;
  /** Raw disbursement status: pending | not_paid | threshold | problem. */
  status: string;
}

/**
 * System-level snapshot of the live pay run — mirrors the Accounting "System
 * Overview" hero (total payout, master-list vs payroll headcount, reconcile
 * gaps), surfaced on the CEO overview so the executive sees the same top-line
 * numbers accounting works from. Null when the current cycle can't be computed.
 */
export interface CeoSystemOverview {
  /** Total payout for the current cycle, PHP — Accounting's published figure
   *  (Σ initial pay + PAB) when available, else base Σ initial pay. */
  totalPayoutPhp: number | null;
  /** ≈ USD equivalent of the total payout. */
  totalPayoutUsd: number | null;
  /** People on the Global Master List (active employees). */
  masterList: number;
  /** Distinct people with Hubstaff hours in the current payroll cycle. */
  inThisPayroll: number;
  /** Bonuses keyed in for the cycle (Payment Catalog + HSL). Null if unknown. */
  bonusesKeyedIn: number | null;
  /** Hubstaff ↔ Master matches (on master AND worked this cycle). */
  emailsMatched: number | null;
  /** On master, no hours this cycle. */
  masterOnlyCount: number | null;
  /** Worked this cycle but not on the master list. */
  hubstaffOnlyCount: number | null;
  /** Master↔payroll email mismatches (kept for back-compat). */
  reconcileGaps: number;
  /** True once today is past the period end → subtitle reads "Initial pay + PAB". */
  pabFinalized: boolean;
  /** Pay-period label, e.g. "Jun 14 – 21, 2026". */
  periodLabel: string;
  /** ISO-week number of the period start (matches the Accounting period pill). */
  periodWeek: number | null;
  /** Full Hubstaff ↔ Master reconciliation breakdown powering the drill-down
   *  modal. Prefers Accounting's published rows (exact mirror); falls back to a
   *  roster+payroll build when no snapshot has been published this cycle. */
  reconRows: HubstaffMasterRow[];
}

export interface CeoOverviewKpis {
  /** Headcount per department, largest first. Powers the bar graph (card 1). */
  departments: CeoDeptCount[];
  totalHeadcount: number;
  /** Top-line system metrics for the current pay run (mirrors Accounting). */
  systemOverview: CeoSystemOverview | null;
  /** Current pay week + how many people get a payout this week (card 2). */
  payWeek: {
    label: string;
    sourceFile: string | null;
    /** People with Hubstaff hours this week (the population actually paid). */
    paymentsToSend: number;
    totalRoster: number;
  };
  /** Unpaid workers from the most recent regular (non-Urgent) cycle whose period
   *  starts strictly before the current `is_current` pay week (card 3). */
  lastCycle: {
    reportName: string;
    periodStart: string | null;
    periodEnd: string | null;
    sourceFile: string | null;
    unpaidCount: number;
    paidCount: number;
    totalRecipients: number;
    workers: CeoUnpaidWorker[];
  } | null;
  error: string | null;
}

/** Two ISO dates inside a Hubstaff filename → "April 12-18, 2026". */
function labelFromSourceFile(file: string | null): string {
  if (!file) return 'Current week';
  const m = file.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return formatDisbursementReportName(m[1]!, m[2]!, file.replace(/\.csv$/i, ''));
  return file.replace(/\.csv$/i, '');
}

/** The period START baked into a Hubstaff filename, e.g.
 *  `…_2026-06-14_to_2026-06-21.csv` → `2026-06-14`. Anchored on the `_to_` range
 *  (the SAME extraction `parseDateRangeFromFilename` and the disbursement seed
 *  use), so it stays apples-to-apples with `reports[].periodStart` even when a
 *  filename carries an earlier ISO-looking prefix (export date, "copy", …). Used
 *  to anchor the current pay week so "last cycle" can be the week strictly before it. */
function startIsoFromSourceFile(file: string | null): string | null {
  if (!file) return null;
  const m = file.match(/(\d{4}-\d{2}-\d{2})_to_\d{4}-\d{2}-\d{2}/);
  return m ? m[1]! : null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Two ISO dates → "Jun 14 – 21, 2026" + the ISO-week number of the start.
 *  Mirrors the Accounting period pill (`parsePeriodFromFilename`) so the CEO
 *  System Overview shows the same "· wk N" label. */
function periodLabelAndWeek(
  startIso: string | null,
  endIso: string | null,
): { label: string; week: number | null } {
  const parse = (iso: string | null): Date | null => {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
    return isNaN(d.getTime()) ? null : d;
  };
  const start = parse(startIso);
  const end = parse(endIso);
  if (!start) return { label: 'Current week', week: null };
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let label: string;
  if (end) {
    const sameMonth =
      start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
    label = sameMonth
      ? `${mo[start.getUTCMonth()]} ${start.getUTCDate()} – ${end.getUTCDate()}, ${end.getUTCFullYear()}`
      : `${mo[start.getUTCMonth()]} ${start.getUTCDate()} – ${mo[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  } else {
    label = `${mo[start.getUTCMonth()]} ${start.getUTCDate()}, ${start.getUTCFullYear()}`;
  }
  const firstOfYear = Date.UTC(start.getUTCFullYear(), 0, 1);
  const week = Math.floor((start.getTime() - firstOfYear) / (7 * 24 * 3600 * 1000)) + 1;
  return { label, week };
}

/** Reconstruct the Hubstaff ↔ Master reconciliation rows from the roster +
 *  live pay engine — the CEO fallback for when Accounting hasn't published its
 *  richer breakdown this cycle. Same three status buckets as Accounting; no-hours
 *  reasons are limited to onboarding timing (leave data isn't loaded here), so
 *  the published snapshot rows are preferred whenever available. */
function buildFallbackReconRows(pay: CurrentPayResult, roster: PeopleRosterRow[]): HubstaffMasterRow[] {
  // pay.byEmail is keyed by normalized work email; those are the people who
  // logged hours this cycle. masterEmails covers work + personal + alternates.
  const worked = new Set(Object.keys(pay.byEmail));
  const hoursByEmail = new Map<string, number>();
  for (const [em, e] of Object.entries(pay.byEmail)) hoursByEmail.set(em, e.totalHours);

  const out: HubstaffMasterRow[] = [];
  const masterKeys = new Set<string>();

  for (const r of roster) {
    const w = normEmail(r.work_email) ?? '';
    const p = normEmail(r.personal_email) ?? '';
    const alts = r.alternate_work_emails.map((a) => normEmail(a) ?? '').filter(Boolean);
    for (const k of [w, p, ...alts]) if (k) masterKeys.add(k);
    const didWork = [w, p, ...alts].some((k) => k !== '' && worked.has(k));
    const hrs = [w, p, ...alts].map((k) => (k ? hoursByEmail.get(k) : undefined)).find((h) => h != null);
    out.push({
      status: didWork ? 'On Master & worked' : 'On Master, no hours',
      reason: didWork ? '' : reasonForNoHoursCeo(r, pay.period.start, pay.period.end),
      name: r.name ?? '',
      workEmail: r.work_email ?? '',
      personalEmail: r.personal_email ?? '',
      department: r.department ?? '',
      hours: hrs != null ? hrs.toFixed(2) : '',
    });
  }

  for (const em of worked) {
    if (masterKeys.has(em)) continue;
    out.push({
      status: 'In Hubstaff, not on Master',
      reason: 'Worked but missing from the Master List — add to the directory',
      name: '',
      workEmail: em,
      personalEmail: '',
      department: '',
      hours: (hoursByEmail.get(em) ?? 0).toFixed(2),
    });
  }

  return sortHubstaffReconRows(out);
}

/** Onboarding-timing explanation for a roster employee who logged no hours. A
 *  lighter version of the Accounting reason (no leave-overlap check here). */
function reasonForNoHoursCeo(
  r: PeopleRosterRow,
  periodStartIso: string | null,
  periodEndIso: string | null,
): string {
  const startMs = r.start_date ? new Date(r.start_date.trim()).getTime() : NaN;
  if (Number.isFinite(startMs)) {
    const startShown = new Date(startMs).toISOString().slice(0, 10);
    const pStart = periodStartIso ? new Date(periodStartIso).getTime() : NaN;
    const pEnd = periodEndIso ? new Date(periodEndIso).getTime() : NaN;
    if (Number.isFinite(pEnd) && startMs > pEnd) return `Not started yet — hired ${startShown}, after this period`;
    if (Number.isFinite(pStart) && startMs >= pStart) return `Newly onboarded — started ${startShown}, mid-period`;
  }
  return 'No hours logged — reason unknown (check Hubstaff upload / time off)';
}

/** Derive the CEO System Overview block from a computed pay cycle. Email-based
 *  reconcile gaps mirror the Accounting hero: payroll emails ∉ master + master
 *  emails ∉ payroll. `masterListCount` is the deduped roster headcount (the same
 *  number the CEO "Headcount by department" graph sums to). */
function buildSystemOverview(
  pay: CurrentPayResult,
  masterListCount: number,
  /** Reconciliation rows for the drill-down modal (snapshot rows or fallback). */
  reconRows: HubstaffMasterRow[],
  /** Accounting's published hero snapshot. When present its fields are
   *  authoritative so this board mirrors the Accounting Overview EXACTLY; absent
   *  fields fall back to the values computed here. */
  snapshot?: AccountingOverviewSnapshot | null,
): CeoSystemOverview {
  const payrollEmails = new Set(Object.keys(pay.byEmail));

  let baseTotalPayoutPhp: number | null = null;
  for (const e of Object.values(pay.byEmail)) {
    if (e.initialPayPHP != null) baseTotalPayoutPhp = (baseTotalPayoutPhp ?? 0) + e.initialPayPHP;
  }
  // Prefer Accounting's published figure (it includes PAB once the period ends,
  // which the base sum above deliberately omits — that was the 10M vs 8M gap).
  const totalPayoutPhp =
    typeof snapshot?.totalPayoutPhp === 'number' ? snapshot.totalPayoutPhp : baseTotalPayoutPhp;

  // Reconciliation (Hubstaff ↔ Master), computed as a fallback for when the
  // snapshot is absent; the snapshot's own counts win when present. Derived from
  // the per-PERSON reconRows (not the email set) so "no hours" isn't doubled —
  // each master person owns a work AND a personal email, and counting the email
  // set would tally both, inflating the figure toward ~2× the real headcount.
  let matched = 0;
  let masterOnly = 0;
  let hubstaffOnly = 0;
  for (const r of reconRows) {
    if (r.status === 'On Master & worked') matched++;
    else if (r.status === 'On Master, no hours') masterOnly++;
    else if (r.status === 'In Hubstaff, not on Master') hubstaffOnly++;
  }

  // PAB is finalized once today is strictly past the period end (same rule as
  // the Accounting hero). Snapshot wins if it carried the flag.
  const pabFinalized =
    typeof snapshot?.pabFinalized === 'boolean'
      ? snapshot.pabFinalized
      : isPastDateIso(pay.period.end);

  const pick = (snap: number | null | undefined, fallback: number | null): number | null =>
    typeof snap === 'number' ? snap : fallback;

  const period = periodLabelAndWeek(pay.period.start, pay.period.end);
  const totalPayoutUsd =
    typeof snapshot?.totalPayoutUsd === 'number'
      ? snapshot.totalPayoutUsd
      : totalPayoutPhp != null && pay.fxRate > 0
        ? totalPayoutPhp / pay.fxRate
        : null;

  return {
    totalPayoutPhp: totalPayoutPhp != null ? Math.round(totalPayoutPhp * 100) / 100 : null,
    totalPayoutUsd,
    masterList: pick(snapshot?.masterTotal, masterListCount) ?? masterListCount,
    inThisPayroll: pick(snapshot?.activeWorkers, payrollEmails.size) ?? payrollEmails.size,
    bonusesKeyedIn: pick(snapshot?.bonusesKeyedIn, null),
    emailsMatched: pick(snapshot?.emailsMatched, matched),
    masterOnlyCount: pick(snapshot?.masterOnlyCount, masterOnly),
    hubstaffOnlyCount: pick(snapshot?.hubstaffOnlyCount, hubstaffOnly),
    reconcileGaps: hubstaffOnly + masterOnly,
    pabFinalized,
    periodLabel: snapshot?.periodLabel ?? period.label,
    periodWeek: pick(snapshot?.periodWeek, period.week),
    reconRows,
  };
}

/** True when `iso` (a YYYY-MM-DD... date) is strictly before today (UTC-safe). */
function isPastDateIso(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return today > end;
}

/**
 * The three executive metrics Karen asked for on the CEO overview:
 *   1. headcount per department
 *   2. current pay week + number of payments to send
 *   3. unpaid workers from the last pay cycle
 *
 * Roster + department + this-week hours come from the People roster builder
 * (the same source the People tab uses). The last-cycle unpaid list comes from
 * `disbursement_records` via the existing reports pipeline.
 */
export async function buildCeoOverviewKpis(): Promise<CeoOverviewKpis> {
  const [roster, reportsRes, payResult] = await Promise.all([
    buildPeopleRoster(),
    listDisbursementReports().catch((e) => ({
      reports: [] as DisbursementReportSummary[],
      error: e instanceof Error ? e.message : String(e),
      unseededCount: 0,
    })),
    // Authoritative live-cycle pay engine — the same source Accounting's "System
    // Overview" numbers derive from. Degrades to null (block hidden) on failure
    // so a payroll-compute hiccup never breaks the other executive metrics.
    computeCurrentPay().catch((e) => {
      console.warn('[ceo-overview] computeCurrentPay failed:', e instanceof Error ? e.message : e);
      return null;
    }),
  ]);

  const { rows, sourceFile, error: rosterError } = roster;

  // 1) Headcount per department (blanks bucketed as "Unassigned").
  const deptMap = new Map<string, number>();
  for (const r of rows) {
    const dept = (r.department ?? '').trim() || 'Unassigned';
    deptMap.set(dept, (deptMap.get(dept) ?? 0) + 1);
  }
  const departments = Array.from(deptMap.entries())
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department));

  // 2) Current pay week + payments to send = people with Hubstaff hours this
  //    week (mirrors the People tab "Payouts to send" card).
  const payWeek = {
    label: labelFromSourceFile(sourceFile),
    sourceFile,
    paymentsToSend: rows.filter((r) => r.hours.thisWeek > 0).length,
    totalRoster: rows.length,
  };

  // 3) Unpaid workers from the cycle BEFORE the current pay week. The current
  //    week is whichever Hubstaff upload is `is_current` — the same week card 2
  //    ("Payments to send") counts — so "last cycle" is the most recent regular
  //    (non-Urgent) cycle whose period starts strictly before it. Example: when
  //    the current week is Jun 14-21, the last cycle is Jun 7-14. Reports are
  //    sorted newest-period-first, so the first match below is that prior week.
  //    Date-driven on purpose: this stays correct whether or not the current
  //    week has been seeded into `disbursement_records` or has already started
  //    being dispatched (the old "most recent dispatched cycle" rule wrongly
  //    surfaced the current week the moment its first payment went out).
  let lastCycle: CeoOverviewKpis['lastCycle'] = null;
  const cycles = (reportsRes.reports ?? []).filter(
    (rep) => rep.sourceFile && !/^Urgent/i.test(rep.reportName),
  );
  // Anchor the current pay week off the roster's source file; if that can't be
  // parsed, fall back to whichever cycle carries the `is_current` flag (same
  // signal the roster itself uses) so we still skip the in-flight week.
  const currentStartIso =
    startIsoFromSourceFile(sourceFile) ??
    cycles.find((rep) => rep.isCurrent)?.periodStart ??
    null;
  const target = currentStartIso
    ? // Most recent regular cycle that ended before this week began.
      cycles.find((rep) => (rep.periodStart ?? '') < currentStartIso) ?? null
    : // No current-week signal at all — fall back to the most recent dispatched
      // cycle, else the newest cycle on file.
      cycles.find((rep) => rep.totals.paidCount > 0 || rep.totals.sentCount > 0) ??
      cycles[0] ??
      null;

  if (target?.sourceFile) {
    let workers: CeoUnpaidWorker[] = [];
    let loaded = false;
    try {
      const records = await loadDisbursementRecordsForCycle(target.sourceFile);
      loaded = true;
      // One row per recipient; unpaid = any status other than 'paid'.
      const byEmail = new Map<string, CeoUnpaidWorker>();
      for (const rec of records) {
        if (rec.status === 'paid') continue;
        const key = rec.recipient_email.trim().toLowerCase();
        if (byEmail.has(key)) continue;
        byEmail.set(key, {
          email: rec.recipient_email,
          name: rec.recipient_name,
          amountUsd: toNum(rec.amount_usd),
          status: rec.status ?? 'pending',
        });
      }
      workers = Array.from(byEmail.values()).sort((a, b) =>
        (a.name ?? a.email).localeCompare(b.name ?? b.email, undefined, { sensitivity: 'base' }),
      );
    } catch {
      /* per-recipient list unavailable — fall back to the count from totals */
    }
    const t = target.totals;
    const unpaidFromTotals = Math.max(0, t.totalRecipients - t.paidCount);
    lastCycle = {
      reportName: target.reportName,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      sourceFile: target.sourceFile,
      unpaidCount: loaded ? workers.length : unpaidFromTotals,
      paidCount: t.paidCount,
      totalRecipients: t.totalRecipients,
      workers,
    };
  }

  // Mirror the Accounting Overview hero EXACTLY: read the full snapshot Accounting
  // published for this cycle and prefer its numbers/tiles over our own recompute.
  // Best-effort — an absent/unreadable snapshot → base compute.
  let heroSnapshot: AccountingOverviewSnapshot | null = null;
  if (payResult?.period.sourceFile) {
    try {
      const raw = await getAppSetting(accountingOverviewSnapshotKey(payResult.period.sourceFile));
      if (raw) heroSnapshot = JSON.parse(raw) as AccountingOverviewSnapshot;
    } catch {
      /* fall back to the base computation */
    }
  }

  // Reconciliation rows for the drill-down modal: prefer Accounting's published
  // breakdown (exact mirror, includes leave reasons); otherwise reconstruct from
  // the roster + live pay engine so the CEO modal is populated even before any
  // accounting user has visited their overview this cycle.
  const reconRows: HubstaffMasterRow[] =
    heroSnapshot?.reconRows && heroSnapshot.reconRows.length > 0
      ? heroSnapshot.reconRows
      : payResult
        ? buildFallbackReconRows(payResult, rows)
        : [];

  return {
    departments,
    totalHeadcount: rows.length,
    systemOverview: payResult
      ? buildSystemOverview(payResult, rows.length, reconRows, heroSnapshot)
      : null,
    payWeek,
    lastCycle,
    error: rosterError ?? reportsRes.error ?? null,
  };
}

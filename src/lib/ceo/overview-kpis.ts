import 'server-only';

import { buildPeopleRoster } from '@/lib/people/people-roster';
import { computeCurrentPay, type CurrentPayResult } from '@/lib/payroll/current-pay';
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
  /** Total INITIAL pay (regular + OT, no bonuses) for the current cycle, PHP. */
  totalPayoutPhp: number | null;
  /** ≈ USD equivalent of the total payout at the cycle's FX rate. */
  totalPayoutUsd: number | null;
  /** People on the Global Master List (active employees). */
  masterList: number;
  /** Distinct people with Hubstaff hours in the current payroll cycle. */
  inThisPayroll: number;
  /** Master↔payroll email mismatches (in-payroll-not-master + in-master-not-payroll). */
  reconcileGaps: number;
  /** Pay-period label, e.g. "Jun 14 – 21, 2026". */
  periodLabel: string;
  /** ISO-week number of the period start (matches the Accounting period pill). */
  periodWeek: number | null;
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

/** Derive the CEO System Overview block from a computed pay cycle. Email-based
 *  reconcile gaps mirror the Accounting hero: payroll emails ∉ master + master
 *  emails ∉ payroll. `masterListCount` is the deduped roster headcount (the same
 *  number the CEO "Headcount by department" graph sums to). */
function buildSystemOverview(
  pay: CurrentPayResult,
  masterListCount: number,
): CeoSystemOverview {
  const payrollEmails = new Set(Object.keys(pay.byEmail));
  const masterEmailSet = new Set(pay.masterEmails);

  let totalPayoutPhp: number | null = null;
  for (const e of Object.values(pay.byEmail)) {
    if (e.initialPayPHP != null) totalPayoutPhp = (totalPayoutPhp ?? 0) + e.initialPayPHP;
  }

  let inPayrollNotMaster = 0;
  for (const em of payrollEmails) if (!masterEmailSet.has(em)) inPayrollNotMaster++;
  let inMasterNotPayroll = 0;
  for (const em of masterEmailSet) if (!payrollEmails.has(em)) inMasterNotPayroll++;

  const period = periodLabelAndWeek(pay.period.start, pay.period.end);
  return {
    totalPayoutPhp: totalPayoutPhp != null ? Math.round(totalPayoutPhp * 100) / 100 : null,
    totalPayoutUsd:
      totalPayoutPhp != null && pay.fxRate > 0 ? totalPayoutPhp / pay.fxRate : null,
    masterList: masterListCount,
    inThisPayroll: payrollEmails.size,
    reconcileGaps: inPayrollNotMaster + inMasterNotPayroll,
    periodLabel: period.label,
    periodWeek: period.week,
  };
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

  return {
    departments,
    totalHeadcount: rows.length,
    systemOverview: payResult ? buildSystemOverview(payResult, rows.length) : null,
    payWeek,
    lastCycle,
    error: rosterError ?? reportsRes.error ?? null,
  };
}

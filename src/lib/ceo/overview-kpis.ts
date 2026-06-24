import 'server-only';

import { buildPeopleRoster } from '@/lib/people/people-roster';
import {
  listDisbursementReports,
  loadDisbursementRecordsForCycle,
  formatDisbursementReportName,
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

export interface CeoOverviewKpis {
  /** Headcount per department, largest first. Powers the bar graph (card 1). */
  departments: CeoDeptCount[];
  totalHeadcount: number;
  /** Current pay week + how many people get a payout this week (card 2). */
  payWeek: {
    label: string;
    sourceFile: string | null;
    /** People with Hubstaff hours this week (the population actually paid). */
    paymentsToSend: number;
    totalRoster: number;
  };
  /** Unpaid workers from the most recent dispatched pay cycle (card 3). */
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

function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
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
  const [roster, reportsRes] = await Promise.all([
    buildPeopleRoster(),
    listDisbursementReports().catch((e) => ({
      reports: [],
      error: e instanceof Error ? e.message : String(e),
      unseededCount: 0,
    })),
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

  // 3) Unpaid workers from the last regular pay cycle. Reports are newest-first;
  //    pick the most recent non-MESA cycle that's actually been dispatched, so
  //    we surface a real completed cycle rather than an untouched current week.
  let lastCycle: CeoOverviewKpis['lastCycle'] = null;
  const cycles = (reportsRes.reports ?? []).filter(
    (rep) => rep.sourceFile && !/^Urgent/i.test(rep.reportName),
  );
  const target =
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
    payWeek,
    lastCycle,
    error: rosterError ?? reportsRes.error ?? null,
  };
}

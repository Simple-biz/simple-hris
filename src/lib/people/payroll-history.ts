/**
 * People → Payroll: one person's pay, week by week, WITH the bonuses.
 *
 * Kane, 2026-09-28: *"I did also notice that the Payroll tab did not include the
 * bonuses."* It did not. The tab headlined `disbursement_records.amount_php`,
 * which is regular + OT pay and nothing else (`ceo-assistant.md` § get_employee_pay,
 * `pay-reconciliation.ts`). A ₱5,000 Attendance Incentive week and a ₱25,000 KPI
 * week both read as their hourly pay. This is the same salary-only figure
 * presented as a total that the Overview hero and Penny's payroll report
 * each had to be fixed for.
 *
 * This module does no pay arithmetic. It QUOTES, in order of authority:
 *
 *  1. **The week's statement** (`paystub_dispatch_queue` payload through
 *     `mapPayloadToPayStub`, staged-as-is when paid and snapshot-merged when
 *     unpaid, the rule every statement viewer follows, paystub-dispatch.md
 *     § Paystub freshness). This is what the worker was emailed and can download.
 *     Every line is itemised, and its Net pay is the headline.
 *  2. **The paid dispatch rows** for the week, where no statement exists. They
 *     hold what actually left and a bonus TOTAL, but no itemisation. Their
 *     `system_bonus_label` names only the PAB/Tech part (measured: ₱157,805
 *     labelled "PAB ₱5,000"), so it is never printed as the bonus.
 *  3. **The weekly record alone.** That is hourly pay, and it is labelled as
 *     hourly pay. The bonus is *not on record*, never ₱0.
 *
 * Weeks are joined by their START DATE, never by filename: one week arrives
 * under several source files (api_sync vs daily_report, " 4.csv" re-uploads),
 * and a filename join is how a week goes missing.
 */

import type { PayStubView } from '@/lib/payroll/paystub-view';
import { mergeDispatchesByWeek, round2, type DispatchInput } from '@/lib/penny/pay-reconciliation';

/** One `disbursement_records` row, as the People read selects it. */
export interface PayrollRecordInput {
  source_file: string | null;
  kind: 'cycle' | 'special';
  note: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: number | null;
  /** `amount_php`: regular + OT pay ONLY. Never a total. */
  amount_php: number | null;
  status: string | null;
  paid_at: string | null;
}

/** One week's statement, already chosen (paid → as-paid, unpaid → merged). */
export interface PayrollStatementInput {
  sourceFile: string;
  /** Sent date of the paid dispatch for this statement's file, else null. */
  paidAt: string | null;
  view: PayStubView;
}

export type PayrollBonusKey = 'attendance' | 'tech' | 'performance' | 'adjustment';

/** A statement line that is a bonus (or Accounting's signed adjustment). */
export interface PayrollBonusLine {
  key: PayrollBonusKey;
  /** The statement's own label, verbatim (CurrentPaycycle / PayStubStatement). */
  label: string;
  /** SIGNED. A negative Adjustment is money withheld and is always shown. */
  amountPhp: number;
}

export type PayrollWeekSource = 'statement' | 'dispatch' | 'hourly_only' | 'special';

export interface PayrollHistoryWeek {
  /** Stable React key: the week start, or the record's own identity for a special row. */
  key: string;
  periodStart: string | null;
  periodEnd: string | null;
  totalHours: number | null;
  /** `paid` once a paid dispatch or the record says so, else the record's status. */
  status: string | null;
  paidAt: string | null;
  /** Regular + OT pay from the weekly record. NEVER the week's pay on its own. */
  hourlyPayPhp: number | null;
  source: PayrollWeekSource;
  /**
   * The headline figure: the statement's Net pay, or what the paid dispatch rows
   * sent, or null when only hourly pay is on record (the row then prints the
   * hourly figure under that name).
   */
  totalPhp: number | null;
  /** Non-zero statement bonus lines, in statement order. Empty when un-itemised. */
  bonusLines: PayrollBonusLine[];
  /**
   * Attendance + Tech + KPI/Performance + Adjustment (payment-dispatch.md §4.2.3's
   * Bonus Total), or the dispatch's frozen bonus total. **null = not on record**,
   * which is a different fact from ₱0 and renders differently.
   */
  bonusTotalPhp: number | null;
  /** True only when the bonus came from a statement, line by line. */
  bonusItemised: boolean;
  /** The statement's source file (opens the statement), else the record's. */
  sourceFile: string | null;
  /** The full statement, for the Statement view. Only on `statement` weeks. */
  statement: PayStubView | null;
  /** Special-transfer note (the legacy `kind: 'special'` rows). */
  note: string | null;
  /**
   * Two records of the same payment that disagree: the statement's Net pay and
   * the paid dispatch total. Both are named. Silently preferring one would
   * publish a figure nobody can trace.
   */
  disagreement: string | null;
}

/** Cent-level tolerance, the same as the Penny reconciler's. */
const EPSILON = 0.011;

/** "YYYY-MM-DD" prefix of a date-ish string, or null. */
function day(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((iso ?? '').trim());
  return m ? m[1] : null;
}

function php(n: number): string {
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The statement's bonus lines, in its own order and with its own words. Zero
 * lines are dropped from the chips (the full statement still prints them), but
 * nothing is gated on `> 0`: a negative Adjustment is a line.
 */
export function statementBonusLines(view: PayStubView): PayrollBonusLine[] {
  const lines: PayrollBonusLine[] = [
    { key: 'tech', label: 'Tech Allowance', amountPhp: round2(view.techBonus) },
    { key: 'attendance', label: 'Attendance Incentive', amountPhp: round2(view.attendanceBonus) },
    { key: 'performance', label: 'KPI / Performance Bonus', amountPhp: round2(view.performanceBonus) },
    { key: 'adjustment', label: 'Adjustment', amountPhp: round2(view.adjustment) },
  ];
  return lines.filter((l) => l.amountPhp !== 0);
}

/**
 * Assemble the Payroll tab's weeks, newest first.
 *
 * `records` bound the window (the newest N the People read selects). A
 * statement or paid dispatch for a week that has no record inside that window
 * is added too, but only when it is newer than the oldest record shown, so the
 * list never grows a tail of weeks the records deliberately cut.
 */
export function buildPayrollHistory(args: {
  records: PayrollRecordInput[];
  statements: PayrollStatementInput[];
  dispatches: DispatchInput[];
}): PayrollHistoryWeek[] {
  const { records, statements, dispatches } = args;

  const statementByWeek = new Map<string, PayrollStatementInput>();
  for (const s of statements) {
    const start = day(s.view.weekStart);
    // A statement that cannot be dated cannot be joined to a week. The caller
    // already collapsed duplicates (one statement per week), so first wins.
    if (!start || statementByWeek.has(start)) continue;
    statementByWeek.set(start, s);
  }
  const dispatchByWeek = mergeDispatchesByWeek(dispatches);

  const weeks: PayrollHistoryWeek[] = [];
  const seenWeek = new Set<string>();

  for (const r of records) {
    const start = day(r.period_start);
    if (r.kind === 'special' || !start) {
      // Not a pay week. Kept as its own row rather than dropped or merged into
      // a week it only shares a date with.
      weeks.push({
        key: `special|${r.source_file ?? ''}|${r.period_start ?? ''}|${r.paid_at ?? ''}|${weeks.length}`,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        totalHours: r.total_hours,
        status: r.status,
        paidAt: r.paid_at,
        hourlyPayPhp: null,
        source: 'special',
        totalPhp: r.amount_php,
        bonusLines: [],
        bonusTotalPhp: null,
        bonusItemised: false,
        sourceFile: r.source_file,
        statement: null,
        note: r.note,
        disagreement: null,
      });
      continue;
    }
    if (seenWeek.has(start)) {
      // A second record for the same week (e.g. two department rows). Its hours
      // and hourly pay are added to the week so neither row is lost.
      const w = weeks.find((x) => x.key === start);
      if (w) {
        w.totalHours = sumKnown(w.totalHours, r.total_hours);
        w.hourlyPayPhp = sumKnown(w.hourlyPayPhp, r.amount_php);
      }
      continue;
    }
    seenWeek.add(start);
    weeks.push(weekFor(start, r, statementByWeek.get(start) ?? null, dispatchByWeek.get(start) ?? null));
  }

  // Weeks the statements or the dispatch log know about but the records do not
  // (the newest cycle is dispatched before its record is seeded). Bounded by
  // the oldest record shown.
  const oldestRecord = weeks.reduce<string | null>((acc, w) => {
    const s = w.source === 'special' ? null : day(w.periodStart);
    return s && (!acc || s < acc) ? s : acc;
  }, null);
  const extra = new Set<string>([...statementByWeek.keys(), ...dispatchByWeek.keys()]);
  for (const start of extra) {
    if (seenWeek.has(start)) continue;
    if (oldestRecord && start < oldestRecord) continue;
    seenWeek.add(start);
    weeks.push(weekFor(start, null, statementByWeek.get(start) ?? null, dispatchByWeek.get(start) ?? null));
  }

  return weeks.sort((a, b) => {
    const sa = day(a.periodStart) ?? '';
    const sb = day(b.periodStart) ?? '';
    return sa === sb ? 0 : sa < sb ? 1 : -1;
  });
}

function sumKnown(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return round2((a ?? 0) + (b ?? 0));
}

/** One pay week's paid dispatch rows, merged (`mergeDispatchesByWeek`). */
type MergedDispatch = NonNullable<ReturnType<ReturnType<typeof mergeDispatchesByWeek>['get']>>;

function weekFor(
  start: string,
  record: PayrollRecordInput | null,
  statement: PayrollStatementInput | null,
  dispatch: MergedDispatch | null,
): PayrollHistoryWeek {
  const paid = dispatch != null || statement?.paidAt != null || record?.status === 'paid';
  const base = {
    key: start,
    periodStart: start,
    periodEnd: record?.period_end ?? statement?.view.weekEnd ?? dispatch?.period_end ?? null,
    totalHours: record?.total_hours ?? (statement ? round2(statement.view.mfHours + statement.view.mfOtHours) : null),
    status: paid ? 'paid' : (record?.status ?? 'pending'),
    paidAt: record?.paid_at ?? statement?.paidAt ?? (dispatch ? day(dispatch.at) : null),
    hourlyPayPhp: record?.amount_php ?? null,
    note: null,
  };

  if (statement) {
    const lines = statementBonusLines(statement.view);
    const v = statement.view;
    const bonusTotal = round2(v.attendanceBonus + v.techBonus + v.performanceBonus + v.adjustment);
    const net = round2(v.totalPayPhp);
    const sent = dispatch?.paid_php ?? null;
    return {
      ...base,
      source: 'statement',
      totalPhp: net,
      bonusLines: lines,
      bonusTotalPhp: bonusTotal,
      bonusItemised: true,
      sourceFile: statement.sourceFile,
      statement: v,
      disagreement:
        sent != null && Math.abs(sent - net) > EPSILON
          ? `The statement's Net pay is ${php(net)} but ${php(sent)} was dispatched for this week.`
          : null,
    };
  }

  if (dispatch) {
    return {
      ...base,
      source: 'dispatch',
      totalPhp: dispatch.paid_php,
      bonusLines: [],
      // The frozen TOTAL. Its label is deliberately not carried: it names only
      // the PAB/Tech part and has understated the bonus by two orders of magnitude.
      bonusTotalPhp: dispatch.bonus_php,
      bonusItemised: false,
      sourceFile: record?.source_file ?? null,
      statement: null,
      disagreement: null,
    };
  }

  return {
    ...base,
    source: 'hourly_only',
    totalPhp: null,
    bonusLines: [],
    bonusTotalPhp: null,
    bonusItemised: false,
    sourceFile: record?.source_file ?? null,
    statement: null,
    disagreement: null,
  };
}

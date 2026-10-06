/**
 * The Refresh button on an opened paystub in the Payroll Wizard's Dispatch step
 * (Preview Emails → Paystubs → a person). Pure parts only; the wiring lives in
 * `PayrollWizard.tsx` (`refreshPaystubSources`). Doc: `paystub-dispatch.md`
 * § *Refresh on an opened paystub*.
 *
 * Three rules, each a function below:
 *
 * 1. **When it may run** is the KPI live refresh's own gate
 *    (`wizardKpiLiveAllowed`): never in a replayed week, never while Start
 *    Processing holds the payroll, never while the values lock is unknown or ON.
 *    The final-pay publisher does not read the lock (Open items 277), so a
 *    re-read that moved a figure on a locked cycle would re-price Payment
 *    Dispatch. Unlock → change → lock again stays the only way to change a sent
 *    cycle. The blocked button says why instead of doing nothing.
 * 2. **What it re-reads** is a fixed list of sources that change outside this
 *    tab. Hours, the all-uploads PAB merge, the FX pair and the additions blob
 *    are deliberately NOT on it — see `PAYSTUB_REFRESH_NOT_REREAD`.
 * 3. **What it reports** is what the statement itself now says differently,
 *    line by line, with the statement's own labels — never "updated" over a
 *    read that failed.
 */
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { formatPhp, salaryLineLabel, type PayStubView } from '@/lib/payroll/paystub-view';

// ── 1. The gate ─────────────────────────────────────────────────────────────

export interface PaystubRefreshGateInput {
  isReplay: boolean;
  processingLocked: boolean;
  valuesLockLoading: boolean;
  valuesLocked: boolean;
}

/**
 * Why the Refresh is off, or `null` when it may run. `null` exactly when
 * `wizardKpiLiveAllowed` is true — pinned by a test over every combination, so
 * the two gates cannot drift apart.
 */
export function paystubRefreshBlockedReason(s: PaystubRefreshGateInput): string | null {
  if (s.isReplay) return 'A past week is view-only, so there is nothing to re-read.';
  if (s.valuesLockLoading) return 'Checking whether this cycle is locked…';
  if (s.valuesLocked) {
    return 'This cycle is locked in and sent to Payment Dispatch. Unlock Payment Dispatch to pull in changes.';
  }
  if (s.processingLocked) {
    return 'Start Processing holds the payroll, so changes are not pulled in mid-payout.';
  }
  return null;
}

// ── 2. The reads ────────────────────────────────────────────────────────────

/** One entry per read the Refresh sends, in the order the strip names them. */
export const PAYSTUB_REFRESH_READS = [
  { id: 'payStructures', label: 'Payment Catalog rates' },
  { id: 'hourlyRates', label: 'hourly rates' },
  { id: 'rateHistory', label: 'rate history' },
  { id: 'salaryHistory', label: 'salary history' },
  { id: 'offboardedRoster', label: 'the leavers list' },
  { id: 'masterRoster', label: 'the master roster' },
  { id: 'managerKpi', label: 'KPI bonuses' },
  { id: 'hslKpi', label: 'HSL KPI bonuses' },
  { id: 'timeAdjustments', label: 'approved time adjustments' },
  { id: 'notesAdjustments', label: 'Payroll Notes adjustments' },
  { id: 'pabSettings', label: 'PAB settings' },
  { id: 'mesaDisbursements', label: 'MESA disbursements' },
  { id: 'mesaOptOut', label: 'MESA opt-outs and suspensions' },
] as const;

export type PaystubRefreshReadId = (typeof PAYSTUB_REFRESH_READS)[number]['id'];

/**
 * What the Refresh leaves alone, and why. Shown on the button's tooltip so
 * "Refresh" never implies a read it did not send.
 */
export const PAYSTUB_REFRESH_NOT_REREAD =
  'Hours come from the Hubstaff upload (Step 1). Bonus ticks and typed amounts are this tab’s own edits, so they are kept as they are.';

/**
 * One read's result. `skipped` is a read that was never sent (its source had
 * nothing loaded to refresh, or the cycle stopped being editable mid-run); it is
 * never reported as read.
 */
export type PaystubReadOutcome =
  | { status: 'read' }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; reason: string };

export const READ: PaystubReadOutcome = { status: 'read' };

export function failedRead(error: unknown, fallback = 'The read failed'): PaystubReadOutcome {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : fallback;
  return { status: 'failed', message: message || fallback };
}

export function skippedRead(reason: string): PaystubReadOutcome {
  return { status: 'skipped', reason };
}

export type PaystubRefreshOutcomes = Record<PaystubRefreshReadId, PaystubReadOutcome>;

export interface PaystubRefreshFailure {
  id: PaystubRefreshReadId;
  label: string;
  message: string;
}

export interface PaystubRefreshSummary {
  /** Reads that answered. */
  readCount: number;
  /** Reads that failed, in `PAYSTUB_REFRESH_READS` order. */
  failures: PaystubRefreshFailure[];
  /** Reads never sent, with why — said, never counted as read. */
  skipped: Array<{ id: PaystubRefreshReadId; label: string; reason: string }>;
  /** True when not a single read answered — nothing on screen is newer. */
  nothingRead: boolean;
}

export function summarizePaystubRefresh(outcomes: PaystubRefreshOutcomes): PaystubRefreshSummary {
  let readCount = 0;
  const failures: PaystubRefreshFailure[] = [];
  const skipped: PaystubRefreshSummary['skipped'] = [];
  for (const { id, label } of PAYSTUB_REFRESH_READS) {
    const o = outcomes[id];
    if (o.status === 'read') readCount += 1;
    else if (o.status === 'failed') failures.push({ id, label, message: o.message });
    else skipped.push({ id, label, reason: o.reason });
  }
  return { readCount, failures, skipped, nothingRead: readCount === 0 };
}

/** "KPI bonuses and MESA disbursements" / "A, B and C". */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ── 3. What changed on the statement ────────────────────────────────────────

export interface StatementLineChange {
  key: string;
  /** The statement's own label for the line. */
  label: string;
  before: string;
  after: string;
}

interface StatementLine {
  key: string;
  label: string;
  /** Money in pesos (compared to the cent), or a plain string. */
  value: number | string;
  /** How the statement prints it. */
  print: (v: number) => string;
}

const plain = (v: number) => formatPhp(v);
const plus = (v: number) => `+${formatPhp(v)}`;
const minus = (v: number) => `-${formatPhp(v)}`;

/**
 * The lines a reader would compare, keyed so a salaried ↔ hourly switch still
 * lines up, labelled and printed exactly as `PayStubStatement` prints them.
 */
function statementLines(v: PayStubView): StatementLine[] {
  const lines: StatementLine[] = [
    { key: 'department', label: 'Department', value: formatDeptLabel(v.department) || '—', print: plain },
  ];
  if (v.salary) {
    lines.push({ key: 'salary', label: salaryLineLabel(v.salary), value: v.mfPay, print: plain });
  } else {
    lines.push(
      { key: 'rate', label: 'Hourly rate', value: v.mfRate, print: plain },
      {
        key: 'regular',
        label: v.otIsDifferential ? 'M-F Hours' : 'Regular Hours',
        value: v.weekdayPay ?? v.mfPay,
        print: plain,
      },
      {
        key: 'overtime',
        label: v.otIsDifferential ? 'OT Differential' : 'Overtime',
        value: v.weekdayOtPay ?? v.otPay,
        print: plain,
      },
    );
    if (v.hasWeekend) lines.push({ key: 'weekend', label: 'Weekend Hours', value: v.weekendPay, print: plain });
  }
  lines.push(
    { key: 'timeAdjustment', label: 'Time Adjustment', value: v.timeAdjustment?.payPhp ?? 0, print: plain },
    { key: 'tech', label: 'Tech Allowance', value: v.techBonus, print: plain },
    { key: 'attendance', label: 'Attendance Incentive', value: v.attendanceBonus, print: plain },
    { key: 'performance', label: 'Performance Bonus', value: v.performanceBonus, print: plain },
    { key: 'adjustment', label: 'Adjustment', value: v.adjustment, print: plain },
    { key: 'orphanage', label: 'Orphanage', value: v.orphanagePay, print: plus },
    { key: 'mesaDisbursement', label: 'MESA Reimbursement', value: v.mesaDisbursement, print: plus },
    { key: 'mesaDeduction', label: 'MESA Deduction', value: v.mesaDeduction, print: minus },
    { key: 'net', label: 'Total Net Pay', value: v.totalPayPhp, print: plain },
  );
  return lines;
}

const cents = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100);

function show(line: StatementLine | undefined, fallbackPrint: (v: number) => string): string {
  if (!line) return fallbackPrint(0);
  return typeof line.value === 'number' ? line.print(line.value) : line.value;
}

/**
 * Every line whose printed figure moved between two renders of the same
 * person's statement, in statement order. A money line missing on one side (a
 * salaried ↔ hourly switch) compares against ₱0.00. Equal to the cent ⇒ no
 * entry, so float noise can never report a change nobody could see.
 */
export function diffPayStubViews(before: PayStubView, after: PayStubView): StatementLineChange[] {
  const prev = new Map(statementLines(before).map((l) => [l.key, l]));
  const next = statementLines(after);
  const nextKeys = new Set(next.map((l) => l.key));
  const ordered: StatementLine[] = [...next];
  // A line only the OLD statement printed (it went away) still has to be said.
  for (const l of prev.values()) if (!nextKeys.has(l.key)) ordered.push(l);

  const changes: StatementLineChange[] = [];
  for (const line of ordered) {
    const a = prev.get(line.key);
    const b = nextKeys.has(line.key) ? line : undefined;
    const print = (a ?? b ?? line).print;
    if (typeof line.value === 'string') {
      const av = a ? String(a.value) : '';
      const bv = b ? String(b.value) : '';
      if (av !== bv) changes.push({ key: line.key, label: line.label, before: av || '—', after: bv || '—' });
      continue;
    }
    const av = a && typeof a.value === 'number' ? a.value : 0;
    const bv = b && typeof b.value === 'number' ? b.value : 0;
    if (cents(av) === cents(bv)) continue;
    changes.push({ key: line.key, label: line.label, before: show(a, print), after: show(b, print) });
  }
  // Net always closes the list, the way it closes the statement.
  const netAt = changes.findIndex((c) => c.key === 'net');
  if (netAt >= 0 && netAt !== changes.length - 1) changes.push(changes.splice(netAt, 1)[0]!);
  return changes;
}

/**
 * Anything else on the statement moved (hours, a note, a rate basis) while no
 * compared figure did. Lets the strip avoid saying "nothing changed" over a
 * statement that visibly reads differently.
 */
export function payStubDetailsChanged(before: PayStubView, after: PayStubView): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

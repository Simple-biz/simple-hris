/**
 * Making a pay week ADD UP for whoever is reading it.
 *
 * ── The bug this exists to fix ───────────────────────────────────────────────
 * Carla, 2026-09-17, pulling four cycles for Amelou Arbol so Bob could be
 * answered: *"Why is the paid USD different from the computed USD? Wouldn't
 * they be the same, if not WHY?"* — and then, after Penny's answer:
 *
 *   *"This is wrong, it should give me EVERYTHING, it shouldn't take bonuses
 *    out, if it wants to give a number like that it should be called Hourly
 *    Pay, not computed, computed sounds like we total everything up, but
 *    that's not true, we are excluding adjustments and bonuses."*
 *
 * She was right, and the tool had failed her three separate ways:
 *
 *  1. **A null that meant "branch never ran".** `getEmployeePay` fetched the
 *     paid dispatch row but copied its PHP amount only inside
 *     `if (existing.status !== 'paid')`. Every historical week IS paid, so the
 *     branch never ran and the result carried a literal `paid_amount_php:
 *     null` — which the model read as *"the system does not store the
 *     actually-disbursed amount in PHP"* and told the CEO exactly that. It
 *     does: `payment_dispatches.amount_php`, populated on all four weeks.
 *  2. **A guess on a money question.** The $79.88 gap was reported as
 *     *"almost certainly a bonus"*. The row already in hand carried
 *     `system_bonus_php: 5000` / `system_bonus_label: "PAB ₱5,000"`; the
 *     select simply never asked for those two columns.
 *  3. **A whole missing term.** The remainder was MESA — ₱100 a week off
 *     every single week — and no Penny doc mentioned deductions at all, so
 *     Penny said "a deduction was applied" with nothing able to name one.
 *
 * ── Why the naming matters as much as the arithmetic ─────────────────────────
 * `disbursement_records.amount_php` is regular + OT pay and nothing else. The
 * fix is NOT to widen what that column means — it is to stop calling it
 * "computed", which sounds like a total, and to publish the other terms beside
 * it so the subtraction is visible:
 *
 *     hourly_pay + bonus − deduction = paid
 *
 * Measured against production for `amiea@simple.biz`, all four of Carla's
 * weeks close to the peso:
 *
 *     ₱62,396.59 + ₱6,850 − ₱400 = ₱68,846.59   ($1,102.77)
 *
 * ── Two rules that look like details and are not ─────────────────────────────
 * • **`simple_match_php` is Simple's money, not the employee's.** The MESA
 *   ledger carries a ₱100 worker contribution beside a ₱300 company match
 *   (₱400 deposited). Only the worker contribution is a deduction from pay.
 *   Netting the match would understate take-home by ₱300 a week.
 * • **An unknown money figure is omitted, never emitted as `null`.** That is
 *   defect 1 above, generalised: a `null` on a money field reads as "we do not
 *   hold this", and the reader cannot tell it apart from a genuine zero or a
 *   code path that did not run. Unknown fields are left off and a `_note`
 *   says why.
 */

/** One week as `disbursement_records` has it: hours and regular + OT pay. */
export type PayRecordInput = {
  period_start: string;
  period_end: string | null;
  recipient_name?: string | null;
  total_hours: number;
  regular_hours: number;
  ot_hours: number;
  /** `amount_php` — regular + OT pay ONLY. Never a total. */
  hourly_pay_php: number | null;
  /** `amount_usd` — regular + OT pay ONLY. Never a total. */
  hourly_pay_usd: number | null;
  status: string | null;
  /** `paid_amount_usd` — set only once the week is marked paid. */
  paid_usd: number | null;
  paid_at: string | null;
};

/** One paid row from `payment_dispatches` — the clerk's ground truth. */
export type DispatchInput = {
  period_start: string | null;
  period_end: string | null;
  recipient_name?: string | null;
  /** `amount_usd` — what actually left, bonuses and deductions already in it. */
  paid_usd: number | null;
  /** `amount_php` — the same figure in pesos. This is what "is null" was hiding. */
  paid_php: number | null;
  /** `system_bonus_php` — the bonus folded into the paid amount. */
  bonus_php: number | null;
  /** `system_bonus_label` — e.g. "PAB ₱5,000", "Tech ₱1,850". */
  bonus_label: string | null;
  /** `created_at` or `sent_date`. */
  at: string;
  payee_type: string | null;
};

/** One MESA ledger row. The match is the company's money — see the header. */
export type MesaDepositInput = {
  deposit_date: string | null;
  worker_contribution_php: number | null;
};

export type PayWeekOutput = {
  period_start: string;
  period_end: string | null;
  total_hours: number;
  regular_hours: number;
  ot_hours: number;
  hourly_pay_php?: number;
  hourly_pay_usd?: number;
  bonus_php?: number;
  bonus_label?: string;
  deduction_php?: number;
  deduction_label?: string;
  paid_php?: number;
  paid_usd?: number;
  paid_php_note?: string;
  status: string | null;
  paid_at: string | null;
  source: string;
  reconciles?: boolean;
  unexplained_php?: number;
  reconciliation_note?: string;
  paid_usd_disagreement?: string;
};

/** Cent-level tolerance. Money is stored to 2dp; anything larger is real. */
const EPSILON = 0.011;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ISO `YYYY-MM-DD` compare works lexicographically; no Date, no timezone. */
function withinWeek(day: string, start: string, end: string | null): boolean {
  if (!day || !start) return false;
  if (day < start) return false;
  if (end) return day <= end;
  // No end stamped — a pay week is Sunday–Saturday, so start + 6 days.
  return day <= addDaysIso(start, 6);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The worker's own MESA contribution for one pay week.
 *
 * Returns `null` — not 0 — when the person has no ledger row touching the
 * week, because "not a member" and "contributed nothing" are different facts
 * and only one of them belongs on a payslip.
 */
export function mesaDeductionForWeek(
  deposits: MesaDepositInput[],
  start: string,
  end: string | null,
): number | null {
  let total: number | null = null;
  for (const d of deposits) {
    const day = (d.deposit_date ?? '').slice(0, 10);
    if (!day) continue; // roster/header rows carry no deposit date
    if (!withinWeek(day, start, end)) continue;
    const php = d.worker_contribution_php;
    if (php == null || !Number.isFinite(php)) continue;
    total = (total ?? 0) + php;
  }
  return total == null ? null : round2(total);
}

/**
 * Collapse paid dispatch rows to one per pay week.
 *
 * Contractor settlements and urgent one-offs (no period) are dropped — they
 * are not a payroll week and would corrupt the reconciliation.
 */
export function mergeDispatchesByWeek(
  dispatches: DispatchInput[],
): Map<string, Required<Pick<DispatchInput, 'period_start'>> & Omit<DispatchInput, 'period_start'>> {
  const out = new Map<string, DispatchInput & { period_start: string }>();
  for (const d of dispatches) {
    if (d.payee_type === 'contractor') continue;
    const start = (d.period_start ?? '').slice(0, 10);
    if (!start) continue;
    const prev = out.get(start);
    if (!prev) {
      out.set(start, { ...d, period_start: start });
      continue;
    }
    // Several sends against one week — add the money, keep the latest stamp.
    prev.paid_usd = sumKeepingUnknown(prev.paid_usd, d.paid_usd);
    prev.paid_php = sumKeepingUnknown(prev.paid_php, d.paid_php);
    prev.bonus_php = sumKeepingUnknown(prev.bonus_php, d.bonus_php);
    prev.bonus_label = joinLabels(prev.bonus_label, d.bonus_label);
    if (d.at > prev.at) prev.at = d.at;
    prev.period_end = prev.period_end ?? d.period_end;
  }
  return out;
}

/** null + null stays null (unknown); null + n becomes n. Never invents a zero. */
function sumKeepingUnknown(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return round2((a ?? 0) + (b ?? 0));
}

function joinLabels(a: string | null, b: string | null): string | null {
  const parts = [a, b].map((s) => (s ?? '').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return [...new Set(parts)].join(' + ');
}

/**
 * Build the weeks a pay question is answered from, each one reconciled.
 *
 * `records` are the weekly rows; `dispatches` the live paid log (which leads
 * them — memory/admin-penny-ai, the 2026-07-29 freshness fix); `mesaDeposits`
 * the worker's MESA ledger.
 */
export function buildReconciledPayWeeks(args: {
  records: PayRecordInput[];
  dispatches: DispatchInput[];
  mesaDeposits: MesaDepositInput[];
  weeks: number;
}): { entries: PayWeekOutput[]; recipient_name: string | null } {
  const { records, dispatches, mesaDeposits, weeks } = args;
  const dispatched = mergeDispatchesByWeek(dispatches);

  const byStart = new Map<string, PayWeekOutput>();
  const order: string[] = [];
  let recipientName: string | null = records[0]?.recipient_name ?? null;

  for (const r of records) {
    const start = (r.period_start ?? '').slice(0, 10);
    if (!start) continue;
    const entry: PayWeekOutput = {
      period_start: start,
      period_end: r.period_end,
      total_hours: r.total_hours,
      regular_hours: r.regular_hours,
      ot_hours: r.ot_hours,
      status: r.status,
      paid_at: r.paid_at,
      source: 'weekly_records',
    };
    if (r.hourly_pay_php != null) entry.hourly_pay_php = round2(r.hourly_pay_php);
    if (r.hourly_pay_usd != null) entry.hourly_pay_usd = round2(r.hourly_pay_usd);
    if (r.paid_usd != null) entry.paid_usd = round2(r.paid_usd);
    byStart.set(start, entry);
    order.push(start);
  }

  for (const [start, d] of dispatched) {
    recipientName = recipientName ?? d.recipient_name ?? null;
    const existing = byStart.get(start);
    if (!existing) {
      // The weekly record is not seeded yet — the dispatch IS the week.
      const entry: PayWeekOutput = {
        period_start: start,
        period_end: d.period_end,
        total_hours: 0,
        regular_hours: 0,
        ot_hours: 0,
        status: 'paid',
        paid_at: d.at,
        source: 'live_dispatch_log',
      };
      if (d.paid_usd != null) entry.paid_usd = round2(d.paid_usd);
      if (d.paid_php != null) entry.paid_php = round2(d.paid_php);
      if (d.bonus_php != null) entry.bonus_php = round2(d.bonus_php);
      if (d.bonus_label) entry.bonus_label = d.bonus_label;
      byStart.set(start, entry);
      order.push(start);
      continue;
    }

    // THE FIX. The paid PHP figure and the bonus are attached on EVERY paid
    // week, not only where the weekly record had not caught up. Guarding this
    // on `status !== 'paid'` is what made the tool report `paid_amount_php:
    // null` for every historical week and tell the CEO it was not stored.
    if (d.paid_php != null) existing.paid_php = round2(d.paid_php);
    if (d.bonus_php != null) existing.bonus_php = round2(d.bonus_php);
    if (d.bonus_label) existing.bonus_label = d.bonus_label;

    if (existing.status !== 'paid') {
      existing.status = 'paid';
      existing.paid_at = existing.paid_at ?? d.at;
      existing.source = 'weekly_records + live_dispatch_log';
      if (existing.paid_usd == null && d.paid_usd != null) existing.paid_usd = round2(d.paid_usd);
    } else if (existing.paid_usd == null && d.paid_usd != null) {
      existing.paid_usd = round2(d.paid_usd);
      existing.source = 'weekly_records + live_dispatch_log';
    } else if (
      existing.paid_usd != null &&
      d.paid_usd != null &&
      Math.abs(existing.paid_usd - d.paid_usd) > EPSILON
    ) {
      // Two records of the same payment disagree. Say so rather than pick one:
      // silently preferring either would publish a figure nobody can trace.
      existing.paid_usd_disagreement =
        `The weekly record says $${existing.paid_usd.toFixed(2)} was paid and the live dispatch log says ` +
        `$${d.paid_usd.toFixed(2)}. These should match. Report BOTH and flag the discrepancy — do not pick one.`;
    }
  }

  const entries = [...new Set(order)]
    .map((s) => byStart.get(s)!)
    .filter(Boolean)
    .sort((a, b) => (a.period_start < b.period_start ? 1 : -1))
    .slice(0, weeks);

  for (const e of entries) {
    const mesa = mesaDeductionForWeek(mesaDeposits, e.period_start, e.period_end);
    if (mesa != null && mesa !== 0) {
      e.deduction_php = mesa;
      e.deduction_label = 'MESA contribution (the employee\'s own savings contribution)';
    }
    applyReconciliation(e);
  }

  return { entries, recipient_name: recipientName };
}

/**
 * Does `hourly + bonus − deduction` equal what was paid?
 *
 * Only asserted when both ends are known. A missing figure yields a note
 * saying which one is missing — never a silent `reconciles: false`, which
 * would read as "the payroll is wrong" when the truth is "we did not look".
 */
export function applyReconciliation(e: PayWeekOutput): void {
  if (e.paid_php == null) {
    e.paid_php_note =
      e.status === 'paid'
        ? 'No paid dispatch row carries a PHP amount for this week, so the peso figure actually sent is not on record. The USD figure is.'
        : 'Not paid yet, so there is no disbursed amount — only the hourly pay worked out for the week.';
    return;
  }
  if (e.hourly_pay_php == null) {
    e.reconciliation_note =
      'The weekly hours record for this week is not seeded, so there is no hourly-pay figure to reconcile the paid amount against.';
    return;
  }
  const expected = round2(e.hourly_pay_php + (e.bonus_php ?? 0) - (e.deduction_php ?? 0));
  const unexplained = round2(e.paid_php - expected);
  e.reconciles = Math.abs(unexplained) <= EPSILON;
  if (!e.reconciles) {
    e.unexplained_php = unexplained;
    e.reconciliation_note =
      `hourly_pay + bonus − deduction = ₱${expected.toFixed(2)}, but ₱${e.paid_php.toFixed(2)} was paid — ` +
      `₱${unexplained.toFixed(2)} is unaccounted for. Say so plainly and do NOT guess what it was; ` +
      'an accounting adjustment or a Payroll Notes entry is the usual cause and neither is readable here.';
  }
}

/**
 * Totals across the weeks shown. Unknown terms stay unknown — never zeroed.
 *
 * **The totals are only a closed sum when every week could be checked.** A week
 * that was paid before its hours record was seeded contributes to `sum_paid_php`
 * but has no `hourly_pay_php` to contribute, so `sum_hourly + sum_bonus −
 * sum_deduction` legitimately falls short of `sum_paid_php`. Publishing a bare
 * "all weeks reconcile" beside totals that visibly do not add up is the same
 * class of mistake this module exists to fix, so `weeks_unchecked` and
 * `totals_note` say it outright.
 */
export function totalsFor(entries: PayWeekOutput[]): Record<string, number | boolean | string> {
  const sum = (pick: (e: PayWeekOutput) => number | undefined) => {
    let acc: number | null = null;
    for (const e of entries) {
      const v = pick(e);
      if (v == null) continue;
      acc = (acc ?? 0) + v;
    }
    return acc;
  };
  const out: Record<string, number | boolean | string> = { weeks_returned: entries.length };
  const put = (k: string, v: number | null) => {
    if (v != null) out[k] = round2(v);
  };
  put('sum_hourly_pay_php', sum((e) => e.hourly_pay_php));
  put('sum_hourly_pay_usd', sum((e) => e.hourly_pay_usd));
  put('sum_bonus_php', sum((e) => e.bonus_php));
  put('sum_deduction_php', sum((e) => e.deduction_php));
  put('sum_paid_php', sum((e) => e.paid_php));
  put('sum_paid_usd', sum((e) => e.paid_usd));

  const checked = entries.filter((e) => e.reconciles != null);
  const unchecked = entries.length - checked.length;
  if (checked.length > 0) {
    out.weeks_reconciled = checked.filter((e) => e.reconciles === true).length;
    out.all_checked_weeks_reconcile = checked.every((e) => e.reconciles === true);
  }
  if (unchecked > 0) {
    out.weeks_unchecked = unchecked;
    out.totals_note =
      `${unchecked} of these ${entries.length} weeks could not be reconciled (no paid amount yet, or the hours record ` +
      'is not seeded), so these totals are NOT a closed sum: sum_hourly_pay_php + sum_bonus_php − sum_deduction_php ' +
      'will not equal sum_paid_php. Say which weeks are incomplete rather than presenting the difference as a discrepancy.';
  }
  return out;
}

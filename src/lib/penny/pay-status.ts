/**
 * Turning Accounting's payment status into something true to tell an EMPLOYEE.
 *
 * ── The bug this exists to fix ───────────────────────────────────────────────
 * Kane, 2026-08-19: *"All weeks should not be pending already."* Penny was
 * passing `disbursement_records.status` straight through, whose vocabulary is
 * defined for Accounting as *"pending = owed but not yet sent"* (`ceo-tools.ts`).
 * For his own account that produced "pending" against 2026-06-21, 06-28 and
 * 07-05 — weeks seven to nine weeks in the past.
 *
 * Measured the same day, read-only and paged: ~2,900 records across those three
 * cycles carry **no paid dispatch at all**, and `2026-07-12` shows 732 pending
 * against 330 paid dispatches. That is the already-known gap in
 * `memory/never-paid-and-misdelivered-paystubs` item 3 — *"were those weeks paid
 * outside HRIS, or were the records never written?"* — **unanswered since
 * 2026-08-07**.
 *
 * ── Why both obvious fixes are wrong ─────────────────────────────────────────
 * Mapping pending → paid invents a payment the system cannot evidence. Leaving
 * it as "owed but not yet sent" asserts a non-payment the system cannot evidence
 * either — and tells a thousand people they are owed money they were very likely
 * already paid. **Both directions are lies about the same missing flag.**
 *
 * So this module has a third state. An unmarked past week is reported as *no
 * confirmed payment record*, which is exactly what is true, and it routes the
 * employee to Accounting instead of to a conclusion. That also keeps faith with
 * the surface next door: `app/api/employee/paystub/route.ts` deliberately does
 * NOT gate stubs on a paid dispatch, because "gating pay stubs on a PAID dispatch
 * would hide most (or all) of an employee's weeks".
 *
 * Note what is NOT done here: `disbursement_records` is not touched, and the CEO
 * and Admin assistants keep the raw status. Accounting needs the ground truth,
 * including its holes; only the employee-facing wording changes.
 */

/** What an employee can truthfully be told about one pay week. */
export type EmployeePaymentStatus =
  /** A payment is recorded — confirmed by a paid dispatch or a paid record. */
  | 'paid'
  /** The pay date has not arrived yet. Nothing is late. */
  | 'scheduled'
  /** The pay date has just passed; a run may still be in flight. */
  | 'processing'
  /** No payment is recorded, and the flag is not reliable enough to conclude. */
  | 'not_recorded'
  /** Accounting flagged the row (below threshold, or a problem). */
  | 'on_hold';

/**
 * How long after the scheduled pay date a missing mark still reads as "in
 * progress" rather than "no record". A payroll run plus bank settlement takes a
 * couple of days, and calling Tuesday's pay "unrecorded" on Wednesday would
 * generate exactly the panic this whole module is avoiding.
 */
export const PROCESSING_GRACE_DAYS = 4;

export interface PayStatusInput {
  /** `disbursement_records.status`, possibly already overlaid to 'paid'. */
  rawStatus: string | null | undefined;
  /** A real disbursement timestamp, if any. */
  paidAt: string | null | undefined;
  /** Scheduled pay date for this week (ISO date), or null if it can't be derived. */
  scheduledPayDate: string | null | undefined;
  /** Today, as an ISO date in the company timezone. */
  todayIso: string;
}

export interface PayStatusResult {
  status: EmployeePaymentStatus;
  /** One sentence Penny can say as-is. Never asserts payment OR non-payment. */
  note: string;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function employeePaymentStatus(input: PayStatusInput): PayStatusResult {
  const raw = (input.rawStatus ?? '').trim().toLowerCase();

  // A disbursement timestamp is evidence on its own — trust it even if the
  // status column disagrees, since the column is the unreliable half.
  if (raw === 'paid' || (input.paidAt ?? '').trim()) {
    return { status: 'paid', note: 'Paid.' };
  }

  if (raw === 'threshold' || raw === 'problem') {
    return {
      status: 'on_hold',
      note: 'Accounting has this week flagged rather than sent — ask them where it stands.',
    };
  }

  const payDate = (input.scheduledPayDate ?? '').trim();
  if (!payDate) {
    // No derivable schedule (unparseable week end) — we cannot claim it is
    // upcoming, so fall to the honest "no record" reading.
    return {
      status: 'not_recorded',
      note: NO_RECORD_NOTE,
      };
  }

  const daysSincePayDate = daysBetween(payDate, input.todayIso);
  if (daysSincePayDate == null) {
    return { status: 'not_recorded', note: NO_RECORD_NOTE };
  }

  if (daysSincePayDate < 0) {
    return {
      status: 'scheduled',
      note: `Not due yet — this week is scheduled to be paid on ${payDate}.`,
    };
  }

  if (daysSincePayDate <= PROCESSING_GRACE_DAYS) {
    return {
      status: 'processing',
      note: `Due ${payDate}. It is not confirmed in the system yet — payment runs can take a day or two to be recorded.`,
    };
  }

  return { status: 'not_recorded', note: NO_RECORD_NOTE };
}

/**
 * The sentence that carries the whole point. It states the absence of a record,
 * explicitly refuses to read that as non-payment, and hands the employee a next
 * step. Exported so the tool's field_notes and the tests reference one string.
 */
export const NO_RECORD_NOTE =
  'There is no confirmed payment record for this week in the HRIS. That does NOT mean you were not paid — the paid mark was not reliably recorded for some earlier weeks. Check your Pay Stubs tab, and raise it with Accounting if you believe a week is genuinely unpaid.';

/** True when a status must never be summarised as "you have not been paid". */
export function isUnconfirmedNotUnpaid(status: EmployeePaymentStatus): boolean {
  return status === 'not_recorded' || status === 'processing';
}

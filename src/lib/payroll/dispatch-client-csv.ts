/**
 * Client-side CSV builders for the Payment Dispatch screens.
 *
 * Two contexts, two column shapes:
 *
 * 1. **Pending queue** (`ProcessorQueue`) — produces a worksheet Lenny can
 *    paste into a processor: name, email, processor, amounts, banking
 *    fields. No bank-used / status (those don't exist until a payment is
 *    logged).
 *
 * 2. **Sent payments** (`SentPaymentsHistory`, and every log view via
 *    `PaidRecordsPanel`) — produces the dialog-shaped audit trail: every column
 *    the Mark-paid dialog captured plus row metadata.
 *
 * TWO PROPERTIES BOTH SHAPES MUST KEEP, pinned by `dispatch-client-csv.test.ts`:
 *
 *   a. **Every row reconciles from its own columns.** These files are the
 *      HRIS-vs-Google-Sheet validation artifact, so a row that cannot be added
 *      up is a trust problem, not cosmetics (memory: payroll-exports-itemized).
 *      No signed component may hide inside an aggregate: Adjustment is itemized
 *      apart from earned bonuses, exactly as the wizard's own Reports export
 *      does it.
 *   b. **Nothing on the screen vanishes from that screen's export.** A column
 *      the clerk can read on the worksheet or the log view and cannot find in
 *      the file reads as "we didn't pay that", which is how the COP figure and
 *      the frozen System Bonus (₱5.5M across 1,606 records) went missing until
 *      2026-08-25.
 */

import type { QueueRow } from '@/components/payroll-clerk/mock-queue';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

type CsvRow = Record<string, string>;

const PENDING_COLUMNS: { key: string; header: string }[] = [
  { key: 'name',            header: 'Name' },
  { key: 'email',           header: 'Email' },
  { key: 'payee_type',      header: 'Payee Type' },
  { key: 'invoice_number',  header: 'Invoice #' },
  { key: 'department',      header: 'Department' },
  { key: 'processor',       header: 'Processor' },
  { key: 'amount_usd',      header: 'Amount (USD)' },
  { key: 'amount_php',      header: 'Amount (PHP)' },
  // Mirrors the worksheet's third currency column. Whole-peso, and for a PH payee
  // it is the USD-anchored REFERENCE the screen shows, not a COP payout — which
  // is why it keeps the screen's wording ("COP Value") rather than "Amount (COP)"
  // (docs/features/payment-dispatch.md §12.8).
  { key: 'amount_cop',      header: 'COP Value' },
  // The breakdown columns reconcile to Amount (PHP):
  //   Regular + OT  +  Bonus Total  +  Orphanage  −  MESA Deduction  +  MESA Disbursement
  // and the bonus split reconciles to Bonus Total:
  //   PAB  +  Tech  +  Other Bonuses  +  Adjustment
  // Adjustment is Accounting's SIGNED delta and is itemized apart from earned
  // bonuses — folding it into an aggregate presents money being WITHHELD as a
  // bonus (memory: payroll-exports-itemized). Same split, same order, as the
  // wizard's own Reports export (src/lib/payroll-wizard/report-rows.ts).
  // Every column is the Payroll Wizard's own figure; blank means the wizard
  // published no itemization for that row, or a genuine zero line — never a
  // figure that was dropped.
  { key: 'initial_pay_php',  header: 'Regular + OT (PHP)' },
  { key: 'pab_bonus_php',    header: 'PAB Bonus (PHP)' },
  { key: 'tech_bonus_php',   header: 'Tech Bonus (PHP)' },
  { key: 'other_bonuses_php', header: 'Other Bonuses (PHP)' },
  { key: 'adjustment_php',   header: 'Adjustment (PHP)' },
  { key: 'bonus_total_php',  header: 'Bonus Total (PHP)' },
  { key: 'orphanage_php',    header: 'Orphanage (PHP)' },
  { key: 'mesa_deduction_php', header: 'MESA Deduction (PHP)' },
  { key: 'mesa_disbursement_php', header: 'MESA Disbursement (PHP)' },
  { key: 'values_source',    header: 'Amount Source' },
  { key: 'total_hours',      header: 'Total Hours' },
  { key: 'ot_hours',         header: 'OT Hours' },
  // Normally empty in a pending queue — the reference is keyed in at Mark Paid —
  // but a `not_paid` / `threshold` attempt leaves the person payable and that
  // attempt's reference travels with them, exactly as the worksheet shows it.
  { key: 'transaction_id',  header: 'TXN ID' },
  { key: 'bank_preferred',  header: 'Bank Preferred (raw)' },
  { key: 'account_holder',  header: 'Account Holder' },
  { key: 'account_number',  header: 'Account Number / Wallet' },
  { key: 'swift_code',      header: 'SWIFT Code' },
  { key: 'phone_number',    header: 'Phone Number' },
  { key: 'full_address',    header: 'Full Address' },
];

const SENT_COLUMNS: { key: string; header: string }[] = [
  { key: 'sent_date',                 header: 'Date Sent' },
  { key: 'arrival_date',              header: 'Arrival Date' },
  { key: 'status',                    header: 'Status' },
  { key: 'processor',                 header: 'Processor' },
  { key: 'recipient_name',            header: 'Name' },
  { key: 'recipient_email',           header: 'Email' },
  { key: 'payee_type',                header: 'Payee Type' },
  // Resolved for the cycle from the dispatch screen's dept map — `payment_dispatches`
  // stores no department. Blank means no source could place that payee, never that
  // they have no department.
  { key: 'department',                header: 'Department' },
  // One column per currency, matching the log views' three (§3.4.2). Read
  // straight off the record — these are what the dispatch was logged for, never
  // re-derived from today's FX.
  { key: 'amount_usd',                header: 'Amount (USD)' },
  { key: 'amount_php',                header: 'Amount (PHP)' },
  { key: 'amount_cop',                header: 'COP Value' },
  // The System Bonus the mark-paid path FROZE onto the row — already inside
  // Amount (PHP), never additive. Rows written before
  // `add_system_bonus_to_payment_dispatches.sql` carry neither field and print
  // blank, exactly as the screen shows a dash for them.
  { key: 'system_bonus_php',          header: 'System Bonus (PHP)' },
  { key: 'system_bonus_label',        header: 'System Bonus Detail' },
  { key: 'bank_used',                 header: 'Bank Used' },
  { key: 'transaction_id',            header: 'Transaction ID' },
  { key: 'recipient_preferred_bank',  header: 'Preferred Bank' },
  { key: 'recipient_account_holder',  header: 'Account Holder' },
  { key: 'recipient_account_number',  header: 'Account Number / Wallet' },
  { key: 'recipient_swift_code',      header: 'SWIFT Code' },
  { key: 'note',                      header: 'Note' },
  { key: 'created_by',                header: 'Logged By' },
  { key: 'created_at',                header: 'Logged At' },
];

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

/** COP is whole-peso everywhere it is shown or copied (§3.9, §12.8), so the
 *  export carries the same integer a clerk would paste into a bank field. */
function fmtCop(n: number | null | undefined): string {
  if (n == null) return '';
  return String(Math.round(Number(n)));
}

function fmtHours(n: number | null | undefined): string {
  if (n == null) return '';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function statusLabel(status: string): string {
  switch (status) {
    case 'paid':       return 'Paid';
    case 'not_paid':   return 'Not Paid';
    case 'threshold':  return 'Threshold';
    case 'problem':    return 'Problem';
    default:           return status;
  }
}

/** Which carrier priced the row, in words — so a worksheet reader can see when a
 *  figure did NOT come from payroll's locked values. */
const VALUES_SOURCE_LABEL: Record<NonNullable<QueueRow['valuesSource']>, string> = {
  snapshot: 'Payroll Wizard (published)',
  lock: 'Payroll Wizard (locked)',
  recomputed: 'RECOMPUTED — not the wizard',
};

/**
 * @param txnByEmail  Lowercased email → the reference logged against that payee
 *   this cycle (`buildTxnIndex` in `ProcessorQueue`). Required, not optional, for
 *   the same reason `buildSentRows` requires its dept map: the column is on every
 *   pending export, and a caller that forgot to thread it would ship a silently
 *   blank one. Pass `{}` where the screen genuinely has no log to read.
 */
export function buildPendingRows(
  rows: QueueRow[],
  txnByEmail: Record<string, string>,
): CsvRow[] {
  return rows.map((r) => ({
    name: r.name,
    email: r.email,
    // Settlement kind for the export; the badge also shows for role-holders.
    payee_type: r.payeeKind === 'contractor' ? 'Contractor' : r.contractorRole ? 'Employee (contractor role)' : 'Employee',
    invoice_number: r.invoiceNumber ?? '',
    department: r.departmentName ?? '',
    processor: r.processor,
    amount_usd: fmtMoney(r.amountUSD),
    amount_php: fmtMoney(r.amountPHP),
    amount_cop: fmtCop(r.amountCOP),
    initial_pay_php: r.breakdownUnavailable ? '' : fmtMoney(r.initialPayPHP),
    // Blank only where there is nothing to state (no itemization, or a genuine
    // zero line). A non-zero figure always prints, including a negative Bonus
    // Total or a negative Adjustment — otherwise Amount (PHP) stops reconciling
    // with its own columns and a withholding reads as a bonus.
    pab_bonus_php: r.breakdownUnavailable || r.pabBonusPHP === 0 ? '' : fmtMoney(r.pabBonusPHP),
    tech_bonus_php: r.breakdownUnavailable || r.techBonusPHP === 0 ? '' : fmtMoney(r.techBonusPHP),
    other_bonuses_php:
      r.breakdownUnavailable || r.otherBonusesPHP === 0 ? '' : fmtMoney(r.otherBonusesPHP),
    adjustment_php:
      r.breakdownUnavailable || r.adjustmentPHP === 0 ? '' : fmtMoney(r.adjustmentPHP),
    bonus_total_php: r.breakdownUnavailable || r.bonusTotalPHP === 0 ? '' : fmtMoney(r.bonusTotalPHP),
    orphanage_php: r.breakdownUnavailable || r.orphanagePayPHP === 0 ? '' : fmtMoney(r.orphanagePayPHP),
    mesa_deduction_php:
      r.breakdownUnavailable || r.mesaDeductionPHP === 0 ? '' : fmtMoney(r.mesaDeductionPHP),
    mesa_disbursement_php:
      r.breakdownUnavailable || r.mesaDisbursementPHP === 0 ? '' : fmtMoney(r.mesaDisbursementPHP),
    values_source: r.valuesSource ? VALUES_SOURCE_LABEL[r.valuesSource] : '',
    total_hours: fmtHours(r.totalHours),
    ot_hours: fmtHours(r.otHours),
    transaction_id: txnByEmail[r.email.trim().toLowerCase()] ?? txnByEmail[r.id.trim().toLowerCase()] ?? '',
    bank_preferred: r.bankPreferredRaw ?? '',
    account_holder: r.details.account_holder_name ?? '',
    account_number: r.details.account_number ?? '',
    swift_code: r.details.swift_code ?? '',
    phone_number: r.details.phone_number ?? '',
    full_address: r.details.full_address ?? '',
  }));
}

/**
 * @param deptByEmail  Lowercased email → department name for the cycle these
 *   records belong to (`useDispatchQueue().deptByEmail`). Required, not optional:
 *   the column exists on every sent export, and a caller that forgot to thread the
 *   map would silently ship a blank Department column for a whole cycle.
 */
export function buildSentRows(
  records: PaymentDispatchRow[],
  deptByEmail: Record<string, string>,
): CsvRow[] {
  return records.map((r) => ({
    sent_date: r.sent_date,
    arrival_date: r.arrival_date ?? '',
    status: statusLabel(r.status),
    processor: r.processor,
    recipient_name: r.recipient_name ?? '',
    recipient_email: r.recipient_email,
    payee_type: r.payee_type === 'contractor' ? 'Contractor' : 'Employee',
    department: deptByEmail[r.recipient_email.trim().toLowerCase()] ?? '',
    amount_usd: fmtMoney(r.amount_usd),
    amount_php: fmtMoney(r.amount_php),
    amount_cop: fmtCop(r.amount_cop),
    // Blank ONLY when the row carries no snapshot at all (pre-migration rows).
    // A recorded ₱0 is a real claim and prints as one.
    system_bonus_php: fmtMoney(r.system_bonus_php),
    system_bonus_label: r.system_bonus_label ?? '',
    bank_used: r.bank_used,
    transaction_id: r.transaction_id,
    recipient_preferred_bank: r.recipient_preferred_bank ?? '',
    recipient_account_holder: r.recipient_account_holder ?? '',
    recipient_account_number: r.recipient_account_number ?? '',
    recipient_swift_code: r.recipient_swift_code ?? '',
    note: r.note ?? '',
    created_by: r.created_by ?? '',
    created_at: r.created_at,
  }));
}

/** RFC 4180 quoting. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(
  rows: CsvRow[],
  columns: { key: string; header: string }[],
): string {
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(','));
  // UTF-8 BOM so Excel auto-detects encoding for accented characters / em-dashes.
  return '﻿' + [header, ...body].join('\r\n');
}

export function pendingRowsToCsv(rows: CsvRow[]): string {
  return rowsToCsv(rows, PENDING_COLUMNS);
}

export function sentRowsToCsv(rows: CsvRow[]): string {
  return rowsToCsv(rows, SENT_COLUMNS);
}

/** Trigger a browser download of a CSV string with the given filename. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/**
 * Filename generator. Pattern:
 *   {prefix}-{processor?}-{YYYY-MM-DD_to_YYYY-MM-DD?}.csv
 * with safe slug substitution so the user always gets a deterministic name.
 */
export function dispatchClientFilename(opts: {
  prefix: 'pending' | 'sent' | 'done' | 'paid';
  processor?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}): string {
  const parts: string[] = [opts.prefix];
  if (opts.processor) parts.push(opts.processor);
  if (opts.periodStart && opts.periodEnd) {
    parts.push(`${opts.periodStart}_to_${opts.periodEnd}`);
  } else {
    parts.push(new Date().toISOString().slice(0, 10));
  }
  return parts.join('-').replace(/[^a-zA-Z0-9_.-]+/g, '-') + '.csv';
}

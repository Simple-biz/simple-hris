/**
 * Client-side CSV builders for the Payment Dispatch screens.
 *
 * Two contexts, two column shapes:
 *
 * 1. **Pending queue** (`ProcessorQueue`) — produces a worksheet Lenny can
 *    paste into a processor: name, email, processor, amounts, banking
 *    fields. No transaction-id / bank-used / status (those don't exist
 *    until a payment is logged).
 *
 * 2. **Sent payments** (`SentPaymentsHistory`) — produces the dialog-shaped
 *    audit trail: every column the Mark-paid dialog captured plus row
 *    metadata. Mirrors the per-cycle Reports export but works against
 *    whatever rows are currently loaded client-side.
 */

import type { QueueRow } from '@/components/payroll-clerk/mock-queue';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

type CsvRow = Record<string, string>;

const PENDING_COLUMNS: { key: string; header: string }[] = [
  { key: 'name',            header: 'Name' },
  { key: 'email',           header: 'Email' },
  { key: 'processor',       header: 'Processor' },
  { key: 'amount_usd',      header: 'Amount (USD)' },
  { key: 'amount_php',      header: 'Amount (PHP)' },
  { key: 'initial_pay_php', header: 'Regular + OT (PHP)' },
  { key: 'pab_bonus_php',   header: 'PAB Bonus (PHP)' },
  { key: 'tech_bonus_php',  header: 'Tech Bonus (PHP)' },
  { key: 'bonus_total_php', header: 'Bonus Total (PHP)' },
  { key: 'total_hours',     header: 'Total Hours' },
  { key: 'ot_hours',        header: 'OT Hours' },
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
  { key: 'amount_usd',                header: 'Amount (USD)' },
  { key: 'amount_php',                header: 'Amount (PHP)' },
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

export function buildPendingRows(rows: QueueRow[]): CsvRow[] {
  return rows.map((r) => ({
    name: r.name,
    email: r.email,
    processor: r.processor,
    amount_usd: fmtMoney(r.amountUSD),
    amount_php: fmtMoney(r.amountPHP),
    initial_pay_php: fmtMoney(r.initialPayPHP),
    pab_bonus_php: r.pabBonusPHP > 0 ? fmtMoney(r.pabBonusPHP) : '',
    tech_bonus_php: r.techBonusPHP > 0 ? fmtMoney(r.techBonusPHP) : '',
    bonus_total_php: r.bonusTotalPHP > 0 ? fmtMoney(r.bonusTotalPHP) : '',
    total_hours: fmtHours(r.totalHours),
    ot_hours: fmtHours(r.otHours),
    bank_preferred: r.bankPreferredRaw ?? '',
    account_holder: r.details.account_holder_name ?? '',
    account_number: r.details.account_number ?? '',
    swift_code: r.details.swift_code ?? '',
    phone_number: r.details.phone_number ?? '',
    full_address: r.details.full_address ?? '',
  }));
}

export function buildSentRows(records: PaymentDispatchRow[]): CsvRow[] {
  return records.map((r) => ({
    sent_date: r.sent_date,
    arrival_date: r.arrival_date ?? '',
    status: statusLabel(r.status),
    processor: r.processor,
    recipient_name: r.recipient_name ?? '',
    recipient_email: r.recipient_email,
    amount_usd: fmtMoney(r.amount_usd),
    amount_php: fmtMoney(r.amount_php),
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
  prefix: 'pending' | 'sent';
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

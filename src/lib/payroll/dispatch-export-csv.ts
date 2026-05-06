/**
 * Per-cycle dispatch CSV export.
 *
 * Source of truth = `disbursement_records` (every recipient who was owed pay
 * this cycle, paid or otherwise). When a row also has a matching
 * `payment_dispatches` entry — i.e. Lenny logged it via the Mark Paid dialog
 * — we overlay the dialog-only fields (preferred bank, account holder, SWIFT,
 * arrival date, note). `personal_email` and processor fallback come from
 * `employee_hourly_rates`. Backfilled cycles where money moved without going
 * through the dialog still get a complete row, just with the dialog-only
 * columns blank.
 */

import { normEmail } from '@/lib/email/norm-email';
import type {
  PaymentDispatchRow,
  PaymentDispatchStatus,
} from '@/lib/supabase/payment-dispatches';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { DisbursementRecordRow } from '@/lib/payroll/disbursement-reports';
import { processorIdFromBankPreferred } from '@/components/payroll-clerk/mock-queue';

type DispatchExportRow = Record<string, string>;

const COLUMNS: { key: string; header: string }[] = [
  { key: 'name',            header: 'Name' },
  { key: 'personal_email',  header: 'Personal Email' },
  { key: 'work_email',      header: 'Work Email' },
  { key: 'processor',       header: 'Processor' },
  { key: 'amount_usd',      header: 'Amount (USD)' },
  { key: 'amount_php',      header: 'Amount (PHP)' },
  { key: 'transaction_id',  header: 'Transaction ID' },
  { key: 'bank_used',       header: 'Bank Used' },
  { key: 'date_sent',       header: 'Date Sent' },
  { key: 'arrival_date',    header: 'Arrival Date' },
  { key: 'preferred_bank',  header: 'Preferred Bank' },
  { key: 'account_holder',  header: 'Account Holder' },
  { key: 'account_number',  header: 'Account Number / Wallet' },
  { key: 'swift_code',      header: 'SWIFT Code' },
  { key: 'status',          header: 'Status' },
  { key: 'note',            header: 'Note' },
];

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number | string | null | undefined): string {
  if (n == null || n === '') return '';
  const x = typeof n === 'number' ? n : parseFloat(n);
  if (!Number.isFinite(x)) return '';
  return x.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function statusLabel(status: PaymentDispatchStatus | 'pending' | string): string {
  switch (status) {
    case 'paid':       return 'Paid';
    case 'not_paid':   return 'Not Paid';
    case 'threshold':  return 'Threshold';
    case 'problem':    return 'Problem';
    case 'pending':    return 'Pending';
    default:           return String(status);
  }
}

export function buildDispatchExportRows(
  records: DisbursementRecordRow[],
  dispatches: PaymentDispatchRow[],
  rates: EmployeeHourlyRateRow[],
): DispatchExportRow[] {
  // email → personal_email
  const personalByEmail = new Map<string, string>();
  // email → bank_preferred (for processor fallback)
  const bankPreferredByEmail = new Map<string, string>();
  for (const r of rates) {
    const work = normEmail(r.work_email);
    const personal = normEmail(r.personal_email);
    if (personal && r.personal_email) {
      const v = r.personal_email.trim();
      if (work) personalByEmail.set(work, v);
      personalByEmail.set(personal, v);
    }
    if (r.bank_preferred) {
      const bp = r.bank_preferred.trim();
      if (work) bankPreferredByEmail.set(work, bp);
      if (personal && !bankPreferredByEmail.has(personal)) {
        bankPreferredByEmail.set(personal, bp);
      }
    }
  }

  // email → most recent dispatch overlay (created_at desc, paid wins ties)
  const dispatchByEmail = new Map<string, PaymentDispatchRow>();
  for (const d of dispatches) {
    const key = normEmail(d.recipient_email);
    if (!key) continue;
    const prev = dispatchByEmail.get(key);
    if (!prev) {
      dispatchByEmail.set(key, d);
      continue;
    }
    // Prefer paid status; otherwise newer created_at wins.
    const prevPaid = prev.status === 'paid';
    const curPaid = d.status === 'paid';
    if (curPaid && !prevPaid) {
      dispatchByEmail.set(key, d);
    } else if (prevPaid === curPaid && d.created_at > prev.created_at) {
      dispatchByEmail.set(key, d);
    }
  }

  return records.map((r) => {
    const key = normEmail(r.recipient_email) ?? '';
    const dispatch = dispatchByEmail.get(key);

    // Pick the right amount: paid_amount_usd when status='paid', else owed amount_usd.
    const amountUSD =
      r.status === 'paid' && r.paid_amount_usd != null
        ? num(r.paid_amount_usd)
        : num(r.amount_usd);

    // Processor: dispatch wins, else infer from rates' bank_preferred.
    const processor =
      dispatch?.processor ??
      processorIdFromBankPreferred(bankPreferredByEmail.get(key) ?? null) ??
      '';

    // Date sent: dispatch.sent_date wins; otherwise pull the date portion of paid_at.
    const dateSent =
      dispatch?.sent_date ??
      (r.paid_at ? r.paid_at.slice(0, 10) : '');

    return {
      name: dispatch?.recipient_name ?? r.recipient_name ?? '',
      personal_email: personalByEmail.get(key) ?? '',
      work_email: r.recipient_email,
      processor,
      amount_usd: fmtMoney(amountUSD),
      amount_php: fmtMoney(r.amount_php),
      transaction_id: dispatch?.transaction_id ?? r.transaction_id ?? '',
      bank_used: dispatch?.bank_used ?? r.bank_used ?? '',
      date_sent: dateSent,
      arrival_date: dispatch?.arrival_date ?? '',
      preferred_bank: dispatch?.recipient_preferred_bank ?? '',
      account_holder: dispatch?.recipient_account_holder ?? '',
      account_number: dispatch?.recipient_account_number ?? '',
      swift_code: dispatch?.recipient_swift_code ?? '',
      status: statusLabel(r.status),
      note: dispatch?.note ?? '',
    };
  });
}

/** RFC 4180 quoting: wrap in quotes if value contains comma, quote, CR, or LF. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Serialize rows into CSV text. Prepends UTF-8 BOM so Excel auto-detects encoding. */
export function dispatchRowsToCsv(rows: DispatchExportRow[]): string {
  const header = COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const body = rows.map((r) => COLUMNS.map((c) => csvEscape(r[c.key])).join(','));
  return '﻿' + [header, ...body].join('\r\n');
}

/** Build a filename like `dispatch-2026-04-12_2026-04-18.csv`, falling back to cycleId. */
export function dispatchExportFilename(
  cycleId: string,
  periodStart: string | null,
  periodEnd: string | null,
): string {
  if (periodStart && periodEnd) {
    return `dispatch-${periodStart}_${periodEnd}.csv`;
  }
  const safe = cycleId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `dispatch-${safe}.csv`;
}

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
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { DisbursementRecordRow } from '@/lib/payroll/disbursement-reports';
import { isProcessorId } from '@/lib/employee-payment-processors';
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
  ids: EmployeeIdRow[] = [],
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

  // email → employee-chosen processor id (Bank Preferred wins over the
  // Disbursement channel). Mirrors the queue's precedence so records with no
  // dispatch row still export the processor the employee actually picked.
  const chosenProcessorByEmail = new Map<string, string>();
  for (const r of ids) {
    const work = normEmail(r.work_email);
    const personal = normEmail(r.personal_email);
    const bp = (r.bank_preferred ?? '').trim().toLowerCase();
    const pp = (r.preferred_processor ?? '').trim().toLowerCase();
    const chosen = (isProcessorId(bp) ? bp : '') || (isProcessorId(pp) ? pp : '');
    if (!chosen) continue;
    if (work) chosenProcessorByEmail.set(work, chosen);
    if (personal && !chosenProcessorByEmail.has(personal)) {
      chosenProcessorByEmail.set(personal, chosen);
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

    // Processor precedence: a recorded dispatch wins; else the employee's own
    // choice (Bank Preferred > Disbursement, from employee_ids); else infer
    // from the rates' legacy bank_preferred cell.
    const processor =
      dispatch?.processor ??
      chosenProcessorByEmail.get(key) ??
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

/**
 * Build export rows straight from `payment_dispatches`, for reports that have
 * no `disbursement_records` backing — i.e. urgent (MESA) weekly reports, where
 * each row IS the dispatch. `rates` only supplies the personal-email column;
 * the processor + banking come from the dispatch itself.
 */
export function buildDispatchExportRowsFromDispatches(
  dispatches: PaymentDispatchRow[],
  rates: EmployeeHourlyRateRow[],
): DispatchExportRow[] {
  const personalByEmail = new Map<string, string>();
  for (const r of rates) {
    if (!r.personal_email) continue;
    const work = normEmail(r.work_email);
    const personal = normEmail(r.personal_email);
    const v = r.personal_email.trim();
    if (work) personalByEmail.set(work, v);
    if (personal) personalByEmail.set(personal, v);
  }

  return dispatches.map((d) => {
    const key = normEmail(d.recipient_email) ?? '';
    return {
      name: d.recipient_name ?? '',
      personal_email: personalByEmail.get(key) ?? '',
      work_email: d.recipient_email,
      processor: d.processor ?? '',
      amount_usd: fmtMoney(d.amount_usd),
      amount_php: fmtMoney(d.amount_php),
      transaction_id: d.transaction_id ?? '',
      bank_used: d.bank_used ?? '',
      date_sent: d.sent_date ?? '',
      arrival_date: d.arrival_date ?? '',
      preferred_bank: d.recipient_preferred_bank ?? '',
      account_holder: d.recipient_account_holder ?? '',
      account_number: d.recipient_account_number ?? '',
      swift_code: d.recipient_swift_code ?? '',
      status: statusLabel(d.status),
      note: d.note ?? '',
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

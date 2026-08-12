/**
 * Cycle close report export — the downloadable artifact of Payment Dispatch's
 * Stop dialog (docs/features/cycle-closeout.md § Downloadable report).
 *
 * Two artifacts, one module, and the split is enforced by a discriminated
 * union so a premature file structurally CANNOT wear a FINAL header:
 *
 *   FINAL (CSV)      — the cycle was closed. Every headline figure renders
 *                      VERBATIM from the server-computed `CycleCloseoutRecord`
 *                      (the close-out POST/GET payload). The builder takes the
 *                      whole record object; there is no parameter through which
 *                      a client-side tally can reach the headline.
 *   PREMATURE (XLSX) — the clerk stopped WITHOUT closing. Figures are the live
 *                      client memos the screen shows, stamped "NOT YET CLOSED"
 *                      in the filename and in a banner row on every sheet.
 *
 * Deliberately pure: no fetch, no Supabase, no side effects — arrays in, file
 * contents out. All inputs are handed in by the caller (PayrollDispatch), whose
 * store functions already page via selectAllPaged, so the PostgREST 1,000-row
 * cap cannot bite inside this module.
 *
 * PII: payee rows carry bank name + account LAST-4 only (Kane, 2026-08-12).
 * `recipient_swift_code` and full account numbers have no field to land in —
 * the input types are narrow projections, never the full dispatch/queue rows.
 *
 * The words "Pay Cycle Report" are banned here: that was a different, retired
 * artifact with a completeness gate. This file titles itself "Cycle Close-Out"
 * (final) or "Cycle Snapshot" (premature) and never claims completeness.
 */

import * as XLSX from 'xlsx';
import type { CycleCloseoutRecord, CycleCloseoutUnpaidPayee } from '@/lib/payroll/cycle-closeout';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

// ─── Shared row projections ───────────────────────────────────────────────────

/** One live PAID dispatch, projected down to what the report may carry. */
export interface PaidDetailRow {
  name: string | null;
  email: string;
  payeeType: 'employee' | 'contractor';
  processor: string | null;
  amountUSD: number | null;
  amountPHP: number | null;
  transactionId: string | null;
  bankUsed: string | null;
  /** Masked — "···1234". The projection never carries the full number. */
  accountLast4: string | null;
  dateSent: string | null;
}

/** How the pending queue priced a row (mock-queue's `valuesSource`), in words. */
export type UnpaidAmountSource = 'snapshot' | 'lock' | 'recomputed';

const AMOUNT_SOURCE_LABEL: Record<UnpaidAmountSource, string> = {
  snapshot: 'Payroll Wizard (published)',
  lock: 'Payroll Wizard (locked)',
  recomputed: 'RECOMPUTED — not the wizard',
};

/** One payable-but-unpaid person for the PREMATURE snapshot: the exact
 *  `unpaidPayable` element shape plus amount provenance. Never a QueueRow —
 *  QueueRow.details (full account numbers, SWIFT, address) must not be an
 *  input type of this module. */
export interface PrematureUnpaidRow extends CycleCloseoutUnpaidPayee {
  amountSource?: UnpaidAmountSource | null;
}

export function maskAccountLast4(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  return `···${digits.slice(-4)}`;
}

/**
 * Project live dispatch rows to paid-detail rows. Filters to `status === 'paid'`
 * — the raw `paid[]` state also holds not_paid/threshold/problem marker rows
 * (superseded or not), and a sheet titled "paid" that summed them would not
 * reconcile to the frozen headline.
 */
export function projectPaidDetailRows(rows: readonly PaymentDispatchRow[]): PaidDetailRow[] {
  return rows
    .filter((r) => r.status === 'paid')
    .map((r) => ({
      name: r.recipient_name?.trim() || null,
      email: r.recipient_email,
      payeeType: (r.payee_type ?? 'employee') === 'contractor' ? 'contractor' : 'employee',
      processor: r.processor ?? null,
      amountUSD: r.amount_usd ?? null,
      amountPHP: r.amount_php ?? null,
      transactionId: r.transaction_id?.trim() || null,
      bankUsed: r.bank_used?.trim() || null,
      accountLast4: maskAccountLast4(r.recipient_account_number),
      dateSent: r.sent_date ?? null,
    }));
}

// ─── The model — a discriminated union, so "premature" can't render "final" ──

export interface FinalCloseReportModel {
  kind: 'final';
  /** The stored record, verbatim from the close-out POST/GET. Never a client tally. */
  record: CycleCloseoutRecord;
  /**
   * Optional live paid detail. `null`/omitted = record-only (the re-download
   * path — the record stores totals, not per-payee paid rows). When present,
   * the section carries a mandatory disclosure that these rows are live and
   * may differ from the frozen headline in either direction.
   */
  livePaidRows?: PaidDetailRow[] | null;
  generatedAt: Date;
}

export interface PrematureSnapshotModel {
  kind: 'premature';
  label: string;
  sourceFile: string;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: Date;
  /** Live paid rows (status==='paid' projection) at generation time. */
  paidRows: PaidDetailRow[];
  /** Distinct payees paid — the progress strip's own headline number. */
  distinctPaidCount: number;
  /** The unpaidPayable memo, verbatim, plus per-row amount provenance. */
  unpaid: PrematureUnpaidRow[];
}

export type CycleCloseReportModel = FinalCloseReportModel | PrematureSnapshotModel;

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** The six processor rails every breakdown lists (even at zero), in rail order.
 *  Keys OUTSIDE this list (legacy rails, literal 'unknown') are appended, never
 *  dropped — the per-processor section must sum to the paid headline. */
const KNOWN_PROCESSOR_IDS = ['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time `YYYY-MM-DD HH-MM-SS` — filesystem-safe (no colons), second
 *  resolution, LOCAL so a Monday-07:00-Manila download carries Monday's date. */
export function fileTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  );
}

/** Human timestamp with an explicit zone for in-file lines. */
function humanTimestamp(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

function slugLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function closeReportFilename(kind: 'final' | 'premature', label: string, now: Date): string {
  const ts = fileTimestamp(now);
  return kind === 'final'
    ? `cycle-closeout-${slugLabel(label)}-FINAL-${ts}.csv`
    : `cycle-snapshot-${slugLabel(label)}-PREMATURE-${ts}.xlsx`;
}

/** Money for CSV body cells: ungrouped 2dp string; null stays BLANK (a null
 *  threshold/problem marker amount means "owed an unknown amount", never 0.00). */
function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(2);
}

/**
 * Neutralize spreadsheet formula injection for FREE-TEXT cells: a value
 * starting with = + - or @ executes as a formula when the CSV is opened in
 * Excel, and payee names flow from onboarding data. Prefixing a `'` renders it
 * inert. Applied to text fields only — never to builder-controlled numeric
 * strings (a negative amount legitimately starts with '-').
 */
function neutralize(v: string | null | undefined): string {
  const s = (v ?? '').toString();
  if (/^[=+\-@]/.test(s.trim()) && s.trim().length > 0) return `'${s}`;
  return s;
}

/** RFC 4180 quoting over an already-neutralized value. */
function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function textCell(v: string | null | undefined): string {
  return csvEscape(neutralize(v));
}

function csvLine(cells: string[]): string {
  return cells.join(',');
}

const REASON_LABEL: Record<CycleCloseoutUnpaidPayee['reason'], string> = {
  pending: 'Never dispatched',
  problem: 'Problem',
  threshold: 'Held · threshold',
};

/**
 * Sum-preserving per-processor rows: every known rail (even zero), then every
 * stray key (legacy rails, 'unknown') — copied from the retired
 * PayCycleReportDetail behaviour, NOT the key-dropping map the old Reports tab
 * used. Section totals must equal the paid headline.
 */
function processorRows(
  byProcessor: Record<string, { count: number; usd: number; php: number }>,
): Array<{ id: string; count: number; usd: number; php: number }> {
  const out: Array<{ id: string; count: number; usd: number; php: number }> = [];
  const seen = new Set<string>();
  for (const id of KNOWN_PROCESSOR_IDS) {
    const v = byProcessor[id];
    out.push({ id, count: v?.count ?? 0, usd: v?.usd ?? 0, php: v?.php ?? 0 });
    seen.add(id);
  }
  for (const [id, v] of Object.entries(byProcessor)) {
    if (seen.has(id)) continue;
    out.push({ id, count: v.count, usd: v.usd, php: v.php });
  }
  return out;
}

// ─── FINAL — CSV, rendered verbatim from the stored record ────────────────────

/**
 * Build the FINAL close-out CSV. Headline figures come from `model.record`
 * exclusively. Optional `livePaidRows` adds a clearly-disclosed live section.
 */
export function buildFinalCloseoutCsv(model: FinalCloseReportModel): string {
  const { record } = model;
  const lines: string[] = [];

  // ── Provenance preamble (the Accounting export family's shape) ──
  lines.push(csvLine([textCell('Cycle Close-Out')]));
  lines.push(csvLine([textCell(record.label)]));
  lines.push(
    csvLine([
      textCell(
        record.period_start && record.period_end
          ? `Period: ${record.period_start} to ${record.period_end}`
          : 'Period: unknown',
      ),
    ]),
  );
  lines.push(csvLine([textCell(`Source file: ${record.source_file}`)]));
  lines.push(csvLine([textCell('Pulled from Simple-HRIS System')]));
  lines.push(csvLine([textCell(`Exported: ${humanTimestamp(model.generatedAt)}`)]));
  lines.push(
    csvLine([
      textCell(`STATUS: FINAL — closed ${record.closed_at} by ${record.closed_by}`),
    ]),
  );
  lines.push('');

  // ── Frozen headline — record.paid verbatim ──
  lines.push(csvLine([textCell('FROZEN AT CLOSE (server-computed)')]));
  lines.push(csvLine(['Payees paid', String(record.paid.payeeCount)]));
  lines.push(csvLine(['Employees paid', String(record.paid.employeeCount)]));
  lines.push(csvLine(['Contractor invoices paid', String(record.paid.contractorCount)]));
  lines.push(csvLine(['Paid dispatch rows', String(record.paid.dispatchCount)]));
  lines.push(csvLine(['Paid USD', money(record.paid.paidUSD)]));
  lines.push(csvLine(['Paid PHP', money(record.paid.paidPHP)]));
  // The number shown is the number the clerk saw: count + whatever the storage
  // cap dropped.
  lines.push(
    csvLine(['Payable not paid', String(record.unpaid.count + record.unpaid.truncated)]),
  );
  lines.push(csvLine(['Unpaid USD (listed rows)', money(record.unpaid.totalUSD)]));
  lines.push(csvLine(['Unpaid PHP (listed rows)', money(record.unpaid.totalPHP)]));
  if (record.unpaid.truncated > 0 || record.unpaid.dropped > 0) {
    lines.push(
      csvLine([
        textCell(
          `NOTICE: ${record.unpaid.truncated} unpaid ${
            record.unpaid.truncated === 1 ? 'person is' : 'people are'
          } counted above but not listed (storage cap); ${record.unpaid.dropped} ${
            record.unpaid.dropped === 1 ? 'entry was' : 'entries were'
          } dropped as unidentifiable (no email).`,
        ),
      ]),
    );
  }
  lines.push('');

  // ── Per-processor (frozen byProcessor, sum-preserving) ──
  lines.push(csvLine([textCell('PAID BY PROCESSOR (frozen at close)')]));
  lines.push(csvLine(['Processor', 'Payments', 'USD', 'PHP']));
  for (const p of processorRows(record.byProcessor)) {
    lines.push(csvLine([textCell(p.id), String(p.count), money(p.usd), money(p.php)]));
  }
  lines.push('');

  // ── Unpaid list — the stored payees, verbatim. Excluded people were never in
  //    this list (Kane's rule) and nothing here re-derives it. ──
  lines.push(csvLine([textCell('PAYABLE, NOT PAID (frozen at close)')]));
  lines.push(csvLine(['Name', 'Email', 'Type', 'Reason', 'Processor', 'Amount USD', 'Amount PHP']));
  for (const p of record.unpaid.payees) {
    lines.push(
      csvLine([
        textCell(p.name),
        textCell(p.email),
        textCell(p.payeeType === 'contractor' ? 'Contractor' : 'Employee'),
        textCell(REASON_LABEL[p.reason]),
        textCell(p.processor),
        money(p.amountUSD),
        money(p.amountPHP),
      ]),
    );
  }
  lines.push('');

  // ── Audit cross-check footer — never the headline; null is never zero. ──
  const ro = record.records_outstanding;
  lines.push(csvLine([textCell('Audit cross-check (includes Excluded — not the headline)')]));
  if (ro) {
    lines.push(
      csvLine([
        textCell(
          `disbursement_records outstanding at close: total ${ro.total} (not paid ${ro.notPaid}, threshold ${ro.threshold}, problem ${ro.problem}, never dispatched ${ro.neverDispatched})`,
        ),
      ]),
    );
  } else {
    lines.push(csvLine([textCell('disbursement_records cross-check: unavailable')]));
  }

  // ── Optional live paid detail, behind its mandatory disclosure ──
  if (model.livePaidRows && model.livePaidRows.length > 0) {
    lines.push('');
    lines.push(csvLine([textCell('PAID DETAIL — LIVE, NOT PART OF THE FROZEN RECORD')]));
    lines.push(
      csvLine([
        textCell(
          'Live payment_dispatches rows as held by this screen when the report was generated — the frozen close-out stores totals only; these rows may differ from the headline in either direction if anything was paid, undone, or re-marked around the close.',
        ),
      ]),
    );
    lines.push(
      csvLine([
        'Name', 'Email', 'Type', 'Processor', 'Amount USD', 'Amount PHP',
        'Transaction ID', 'Bank used', 'Account (last 4)', 'Date sent',
      ]),
    );
    for (const r of model.livePaidRows) {
      lines.push(
        csvLine([
          textCell(r.name),
          textCell(r.email),
          textCell(r.payeeType === 'contractor' ? 'Contractor' : 'Employee'),
          textCell(r.processor),
          money(r.amountUSD),
          money(r.amountPHP),
          textCell(r.transactionId),
          textCell(r.bankUsed),
          textCell(r.accountLast4),
          textCell(r.dateSent),
        ]),
      );
    }
  }

  // UTF-8 BOM so Excel auto-detects encoding for ₱ / accented names; CRLF per
  // RFC 4180 and the export-family convention.
  return '﻿' + lines.join('\r\n');
}

// ─── PREMATURE — XLSX, stamped NOT YET CLOSED on every sheet ─────────────────

const PREMATURE_BANNER = 'NOT YET CLOSED — PREMATURE SNAPSHOT';

/** Every sheet's first row. Structural text, not colour — the community `xlsx`
 *  build cannot emit fills, so status signalling must survive as content. */
function bannerRow(model: PrematureSnapshotModel): string[] {
  return [`${PREMATURE_BANNER} · taken ${humanTimestamp(model.generatedAt)} · figures are live and may still move`];
}

/** XLSX cells: names/emails stay strings (never formulas), money stays raw
 *  numbers so Excel can sum. */
function s(v: string | null | undefined): string {
  return v ?? '';
}

export function buildPrematureSnapshotWorkbook(model: PrematureSnapshotModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const totalPaidUSD = model.paidRows.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0);
  const totalPaidPHP = model.paidRows.reduce((sum, r) => sum + (r.amountPHP ?? 0), 0);
  const unpaidUSD = model.unpaid.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0);
  const unpaidPHP = model.unpaid.reduce((sum, r) => sum + (r.amountPHP ?? 0), 0);

  // Per-processor over the live paid rows, grouped on the RAW processor string
  // (null → 'unknown') — never a fixed-key map, which would silently drop
  // legacy/unknown rails and break sum-preservation.
  const byProcessor: Record<string, { count: number; usd: number; php: number }> = {};
  for (const r of model.paidRows) {
    const id = (r.processor ?? '').trim() || 'unknown';
    const acc = byProcessor[id] ?? { count: 0, usd: 0, php: 0 };
    acc.count += 1;
    acc.usd += r.amountUSD ?? 0;
    acc.php += r.amountPHP ?? 0;
    byProcessor[id] = acc;
  }

  // ── Sheet 1: Summary ──
  const summary: (string | number | null)[][] = [
    bannerRow(model),
    ['Cycle Snapshot'],
    [model.label],
    [
      model.periodStart && model.periodEnd
        ? `Period: ${model.periodStart} to ${model.periodEnd}`
        : 'Period: unknown',
    ],
    [`Source file: ${model.sourceFile}`],
    ['Pulled from Simple-HRIS System'],
    [`STATUS: ${PREMATURE_BANNER} — the pay cycle was stopped without being closed`],
    [],
    ['Distinct payees paid (live)', model.distinctPaidCount],
    ['Paid dispatch rows (live)', model.paidRows.length],
    ['Paid USD (live)', totalPaidUSD],
    ['Paid PHP (live)', totalPaidPHP],
    ['Payable not paid (live)', model.unpaid.length],
    ['Unpaid USD (live)', unpaidUSD],
    ['Unpaid PHP (live)', unpaidPHP],
    [],
    ['Paid by processor (live)'],
    ['Processor', 'Payments', 'USD', 'PHP'],
    ...Object.entries(byProcessor).map(([id, v]) => [id, v.count, v.usd, v.php] as (string | number)[]),
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summary);
  wsSummary['!cols'] = [{ wch: 34 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ── Sheet 2: Unpaid (payable) — the unpaidPayable memo verbatim. The
  //    Excluded tab is never in this input by construction. ──
  const unpaidRows: (string | number | null)[][] = [
    bannerRow(model),
    ['Name', 'Email', 'Type', 'Reason', 'Processor', 'Amount USD', 'Amount PHP', 'Amount Source'],
    ...model.unpaid.map((p) => [
      s(p.name),
      p.email,
      p.payeeType === 'contractor' ? 'Contractor' : 'Employee',
      REASON_LABEL[p.reason],
      s(p.processor),
      p.amountUSD, // raw number or null — a null renders blank, never 0.00
      p.amountPHP,
      p.amountSource ? AMOUNT_SOURCE_LABEL[p.amountSource] : '',
    ]),
  ];
  const wsUnpaid = XLSX.utils.aoa_to_sheet(unpaidRows);
  wsUnpaid['!cols'] = [
    { wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 16 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 28 },
  ];
  XLSX.utils.book_append_sheet(wb, wsUnpaid, 'Unpaid (payable)');

  // ── Sheet 3: Paid — live ──
  const paidRows: (string | number | null)[][] = [
    bannerRow(model),
    [
      'Name', 'Email', 'Type', 'Processor', 'Amount USD', 'Amount PHP',
      'Transaction ID', 'Bank used', 'Account (last 4)', 'Date sent',
    ],
    ...model.paidRows.map((r) => [
      s(r.name),
      r.email,
      r.payeeType === 'contractor' ? 'Contractor' : 'Employee',
      s(r.processor),
      r.amountUSD,
      r.amountPHP,
      s(r.transactionId),
      s(r.bankUsed),
      s(r.accountLast4),
      s(r.dateSent),
    ]),
  ];
  const wsPaid = XLSX.utils.aoa_to_sheet(paidRows);
  wsPaid['!cols'] = [
    { wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, wsPaid, 'Paid — live');

  return wb;
}

// ─── Browser download helpers (window-guarded; the builders stay pure) ───────

export function downloadCsvFile(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(filename, blob);
}

export function downloadWorkbookFile(filename: string, wb: XLSX.WorkBook): void {
  if (typeof window === 'undefined') return;
  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(filename, blob);
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Deferred revoke — the family convention (a click needs the URL alive).
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

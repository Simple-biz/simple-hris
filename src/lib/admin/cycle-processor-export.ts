/**
 * CSV export of the Admin → Diagnostics → Payroll Cycles month/week breakdown.
 *
 * ── What this file promises ────────────────────────────────────────────────
 * **It is exactly what the screen shows** — the same rows, the same totals, at
 * the same scope, footed by the same `summariseProcessorRows` the modal uses.
 * A download that quietly disagrees with the view that produced it is worse
 * than no download, because the disagreement travels and the screen does not.
 *
 * ── The column this file must never grow ───────────────────────────────────
 * **A success rate per processor.** `paidPayments` counts dispatch ROWS and the
 * three reason columns count PEOPLE, so dividing one by the other invents a
 * denominator out of two different units — measured live 2026-09-11, it would
 * print a plausible 97.73% for Kolan against a real month figure of 98.47%.
 * A spreadsheet is precisely where someone adds that column, which is why the
 * notes block says so in the file itself rather than only on the screen.
 *
 * ── No PII, unlike every other export here ─────────────────────────────────
 * The source is aggregates: counts, money, processor ids. There is no name, no
 * email, no account number and therefore no last-4 rule to inherit
 * (`cycle-close-report-export.ts` masks because it carries payees; this does
 * not carry payees). Do not "add the names for context".
 *
 * Deliberately pure: scope in, CSV text out. No fetch, no DOM, no Supabase.
 */

import type {
  CycleBreakdown,
  MonthPerformanceRow,
  ProcessorBreakdownRow,
} from '@/lib/admin/cycle-performance';
import { summariseProcessorRows } from '@/lib/admin/cycle-performance';

/**
 * Neutralize spreadsheet formula injection for FREE-TEXT cells.
 *
 * A value starting with `=`, `+`, `-` or `@` executes as a formula when the CSV
 * is opened in Excel, and a processor label is free text from the Pay
 * Processors registry — an admin can type anything into it. Prefixing a `'`
 * renders it inert.
 *
 * Applied to text only. Numeric cells are builder-controlled and must NOT pass
 * through here: a negative amount legitimately starts with `-`. Same split as
 * `cycle-close-report-export.ts`.
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

/** Money for body cells: ungrouped 2dp, so a spreadsheet reads it as a number. */
function money(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '';
}

function intCell(v: number): string {
  return Number.isFinite(v) ? String(Math.trunc(v)) : '';
}

/** `2026-09-11T14-32-05` — filename-safe, sorts correctly. */
export function exportTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * `cycle-processors_2026-08_Aug-9-15_2026-09-11T14-32-05.csv`
 *
 * The scope is IN the name — a week file and a month file must never be
 * confusable once they are sitting in someone's Downloads folder, because the
 * numbers differ and nothing inside a spreadsheet says which is which.
 */
export function processorExportFilename(
  month: MonthPerformanceRow,
  week: CycleBreakdown | null,
  now: Date,
): string {
  const scope = week ? slug(week.label) : 'all-weeks';
  return `cycle-processors_${month.month}_${scope}_${exportTimestamp(now)}.csv`;
}

/**
 * The notes that ride above the table.
 *
 * Not decoration. A bare grid of "Kolan · 990 payments · 2 problems" invites
 * exactly the per-rail percentage this whole surface refuses to draw, and the
 * screen's legend does not travel with the file.
 */
function noteLines(scopeLabel: string, doublePaid: number): string[] {
  return [
    'Cycle processor breakdown — Admin > Diagnostics > Payroll Cycles',
    `Scope: ${scopeLabel}`,
    'Source: the cycle close-out records. Closed cycles only; frozen at close time.',
    '',
    'NOTE: "Payments" counts dispatch ROWS, not people. Pending/Problem/Threshold count PEOPLE.',
    'NOTE: The two sides are DIFFERENT UNITS, so there is no success rate per processor.',
    '      The month rate is on the card this was exported from.',
    doublePaid > 0
      ? `NOTE: ${doublePaid} payment(s) went to someone already paid in the same week (retry, correction or double payment).`
      : 'NOTE: Payments and people agree in this scope — nobody was paid twice.',
    'NOTE: "Threshold" is a DELIBERATE hold under the payout minimum, not a failure.',
    '      "Pending" was never dispatched. "Problem" is money that got stuck.',
    'NOTE: Nothing records WHOSE FAULT a Problem was — no cause, no owner. This is evidence, not a verdict.',
    '',
  ];
}

const HEADER = [
  'Processor ID',
  'Processor',
  'Paid PHP',
  'Paid USD',
  'Payments',
  'Pending',
  'Problem',
  'Threshold',
  'Still owed (people)',
  'Owed PHP',
  'Owed USD',
] as const;

function bodyRow(p: ProcessorBreakdownRow): string {
  return [
    textCell(p.id),
    textCell(p.label),
    money(p.paidPHP),
    money(p.paidUSD),
    intCell(p.paidPayments),
    intCell(p.pending),
    intCell(p.problem),
    intCell(p.threshold),
    intCell(p.unpaidPeople),
    money(p.owedPHP),
    money(p.owedUSD),
  ].join(',');
}

/**
 * Build the file.
 *
 * `rows`, `paid` and `paidPayments` come from `resolveMonthScope` — the caller
 * passes the SAME values it rendered, so the file cannot drift from the view
 * even if the scope rules change later.
 */
export function buildProcessorCsv(input: {
  month: MonthPerformanceRow;
  /** Null when the whole month is in scope. */
  week: CycleBreakdown | null;
  rows: readonly ProcessorBreakdownRow[];
  /** Distinct people paid in scope. */
  paid: number;
  /** Paid dispatch ROWS in scope. */
  paidPayments: number;
}): string {
  const { month, week, rows, paid, paidPayments } = input;
  const t = summariseProcessorRows(rows);
  const scopeLabel = week ? `${week.label} (one week of ${month.label})` : `${month.label} — all weeks`;

  const lines: string[] = [
    ...noteLines(scopeLabel, paidPayments - paid),
    HEADER.join(','),
    ...rows.map(bodyRow),
    // The footer is a row, not a formula: a SUM() would recompute from whatever
    // the reader has since edited and stop matching the screen it came from.
    [
      textCell(week ? 'WEEK TOTAL' : 'MONTH TOTAL'),
      '',
      money(t.paidPHP),
      money(t.paidUSD),
      intCell(t.paidPayments),
      intCell(t.pending),
      intCell(t.problem),
      intCell(t.threshold),
      intCell(t.unpaidPeople),
      money(t.owedPHP),
      money(t.owedUSD),
    ].join(','),
    '',
    // People, stated separately and never in the Payments column, so the two
    // units cannot be read off the same line and divided.
    `People paid in scope,${intCell(paid)}`,
    `Payments in scope,${intCell(paidPayments)}`,
  ];

  // CRLF per RFC 4180, matching cycle-close-report-export.ts.
  return lines.join('\r\n') + '\r\n';
}

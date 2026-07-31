// Employee "Pay Stubs" tab — all-weeks PDF + XLSX export.
//
// The Pay Stubs profile tab loads every paid week's statement (via
// GET /api/employee/paystub?all=1, each mapped through `mapPayloadToPayStub`)
// and hands the flat set here to produce two downloadable "master" files:
//
//   - XLSX → a native Excel workbook, one row per week with the FULL earnings
//            breakdown + a totals row. Column fills/font colours aren't emitted
//            by the pure-JS `xlsx` writer (SheetJS Pro only), so the sheet is
//            styled structurally (title banner, sized columns, autofilter).
//   - PDF  → a branded, landscape statement built from scratch with pdf-lib so
//            it deploys cleanly on Vercel (no template read at runtime). Simple
//            navy + orange palette, matching the Payroll Wizard report export.
//
// Both run entirely in the browser (in-memory Blob download) — the rows are
// already loaded in the tab, so there's no server round-trip.
//
// The money numbers are the SAME the employee received on each emailed pay
// statement (single source of truth: `mapPayloadToPayStub`).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { PayStubView } from './paystub-view';
import { dedupeOneRowPerWeek } from './paystub-week-dedupe';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One week the employee can view/export — the API's `?all=1` element. */
export interface PayStubWeek {
  sourceFile: string;
  paidAt: string | null;
  /** Display pay date: real disbursement date, else the scheduled Tue (HuruPay) /
   *  Thu (wires) for this week. Preferred over `paidAt` for the Paid column. */
  payDate?: string | null;
  /** Dispatch status from the paystub API ('paid' | 'issued'). Present on a stub
   *  exported before it was sent — `payDate` is the SCHEDULED date then, so the
   *  Paid column must not present it as a disbursement. Omitted → legacy
   *  behaviour: any date means paid. */
  status?: string | null;
  view: PayStubView;
}

/** The date to show in the "Paid" column: the resolved pay date (real or
 *  scheduled), falling back to the raw paid date. A week the dispatch queue
 *  hasn't sent yet reads "Pending" rather than dating a payment that never left. */
function paidColumn(w: PayStubWeek): string {
  if (w.status && w.status !== 'paid') return 'Pending';
  const d = w.payDate ?? w.paidAt;
  return d ? formatDate(d) : 'Paid';
}

export interface PayStubExportOptions {
  employeeName: string;
  department?: string | null;
  logoUrl?: string;
}

/**
 * GUARDRAIL — at most ONE statement row per pay week, applied inside both
 * exporters so no caller can ever produce a doubled week (the route dedupes
 * too; this is the last line of defense on the legal record itself). Same
 * pay week under two source files (api_sync + daily_report staged twins, a
 * backfill re-upload with shifted filename dates): the paid row wins, then
 * the earlier list position (the route orders rows best-first).
 */
function dedupeWeeks(weeks: PayStubWeek[]): PayStubWeek[] {
  return dedupeOneRowPerWeek(weeks, (w) => ({
    weekStart: w.view.weekStart,
    weekEnd: w.view.weekEnd,
    // With a status present, only 'paid' counts; legacy rows (no status) keep
    // the old "any paid date means paid" reading.
    paid: w.status ? w.status === 'paid' : w.paidAt != null,
    paidAt: w.paidAt,
  }));
}

/** Derived per-week figures shared by both exporters. Bonuses (tech / PAB /
 *  performance) are itemized as their own columns, so only the netted MESA line
 *  and the weekday/weekend earnings split need deriving here. HSL weeks carry a
 *  weekend carve-out (`hasWeekend`); the columns show the weekday portion in
 *  Regular/Overtime and the Sat+Sun portion in the Weekend columns so a row
 *  still sums exactly to Net. Non-HSL (and pre-split) weeks: weekday === full
 *  and the weekend cells are zero. */
function derive(w: PayStubWeek) {
  const v = w.view;
  const mesaNet = v.mesaDisbursement - v.mesaDeduction;
  const hasWeekend = v.hasWeekend === true;
  return {
    mesaNet,
    weekdayHours: v.weekdayHours ?? v.mfHours,
    weekdayOtHours: v.weekdayOtHours ?? v.mfOtHours,
    weekdayPay: v.weekdayPay ?? v.mfPay,
    weekdayOtPay: v.weekdayOtPay ?? v.otPay,
    weekendHours: hasWeekend ? v.weekendHours : 0,
    weekendOtHours: hasWeekend ? v.weekendOtHours : 0,
    weekendPay: hasWeekend ? v.weekendPay : 0,
    weekendOtPay: hasWeekend ? v.weekendOtPay : 0,
  };
}

interface Totals {
  regular: number;
  ot: number;
  weekendPay: number;
  weekendOtPay: number;
  techBonus: number;
  attendanceBonus: number;
  performanceBonus: number;
  adjustment: number;
  orphanagePay: number;
  mesaNet: number;
  netPhp: number;
  netUsd: number;
}

function sumTotals(weeks: PayStubWeek[]): Totals {
  return weeks.reduce<Totals>(
    (t, w) => {
      const d = derive(w);
      t.regular += d.weekdayPay;
      t.ot += d.weekdayOtPay;
      t.weekendPay += d.weekendPay;
      t.weekendOtPay += d.weekendOtPay;
      t.techBonus += w.view.techBonus;
      t.attendanceBonus += w.view.attendanceBonus;
      t.performanceBonus += w.view.performanceBonus;
      t.adjustment += w.view.adjustment;
      t.orphanagePay += w.view.orphanagePay;
      t.mesaNet += d.mesaNet;
      t.netPhp += w.view.totalPayPhp;
      t.netUsd += w.view.totalPayUsd;
      return t;
    },
    {
      regular: 0,
      ot: 0,
      weekendPay: 0,
      weekendOtPay: 0,
      techBonus: 0,
      attendanceBonus: 0,
      performanceBonus: 0,
      adjustment: 0,
      orphanagePay: 0,
      mesaNet: 0,
      netPhp: 0,
      netUsd: 0,
    },
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 14, 2026" from a plain "YYYY-MM-DD…" (no TZ drift). */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return '-';
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}

/** Two-decimal number, no currency prefix. "-" for nil. */
function n2(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Signed two-decimal number; "-" for zero/nil. */
function n2Signed(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount === 0) return '-';
  return `${amount > 0 ? '+' : ''}${n2(amount)}`;
}

/** Full export timestamp, e.g. "July 17, 2026, 3:45 PM GMT+8" (viewer's local time). */
function formatTimestamp(d: Date): string {
  try {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return d.toLocaleString();
  }
}

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** kebab filename stem from a person's name. */
function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'employee';
}

// ---------------------------------------------------------------------------
// XLSX — full breakdown, one row per week + totals
// ---------------------------------------------------------------------------

interface XlsxCol {
  header: string;
  /** Excel column width in characters. */
  width: number;
  /** Pull the (numeric or string) cell value from a week. */
  value: (w: PayStubWeek) => string | number;
  /** Matching totals value (blank for non-summed columns). */
  total?: (t: Totals) => number;
}

const XLSX_COLS: XlsxCol[] = [
  { header: 'Period Ending', width: 22, value: (w) => w.view.weekHuman || '-' },
  { header: 'Week Start', width: 13, value: (w) => w.view.weekStart ?? '' },
  { header: 'Week End', width: 13, value: (w) => w.view.weekEnd ?? '' },
  { header: 'Regular Hours', width: 13, value: (w) => round2(derive(w).weekdayHours) },
  { header: 'OT Hours', width: 10, value: (w) => round2(derive(w).weekdayOtHours) },
  { header: 'Regular Pay', width: 14, value: (w) => round2(derive(w).weekdayPay), total: (t) => round2(t.regular) },
  { header: 'Overtime', width: 12, value: (w) => round2(derive(w).weekdayOtPay), total: (t) => round2(t.ot) },
  // HSL weekend carve-out (Sat+Sun at the premium rate) — zero for non-HSL weeks.
  { header: 'Weekend Hours', width: 14, value: (w) => round2(derive(w).weekendHours) },
  { header: 'Weekend OT Hours', width: 16, value: (w) => round2(derive(w).weekendOtHours) },
  { header: 'Weekend Pay', width: 14, value: (w) => round2(derive(w).weekendPay), total: (t) => round2(t.weekendPay) },
  { header: 'Weekend OT Pay', width: 15, value: (w) => round2(derive(w).weekendOtPay), total: (t) => round2(t.weekendOtPay) },
  { header: 'Tech Allowance', width: 14, value: (w) => round2(w.view.techBonus), total: (t) => round2(t.techBonus) },
  { header: 'Attendance', width: 12, value: (w) => round2(w.view.attendanceBonus), total: (t) => round2(t.attendanceBonus) },
  { header: 'Performance Bonus', width: 16, value: (w) => round2(w.view.performanceBonus), total: (t) => round2(t.performanceBonus) },
  { header: 'Adjustment', width: 12, value: (w) => round2(w.view.adjustment), total: (t) => round2(t.adjustment) },
  { header: 'Orphanage', width: 12, value: (w) => round2(w.view.orphanagePay), total: (t) => round2(t.orphanagePay) },
  { header: 'MESA Reimbursement', width: 18, value: (w) => round2(w.view.mesaDisbursement) },
  { header: 'MESA Deduction', width: 15, value: (w) => round2(w.view.mesaDeduction) },
  { header: 'Net Pay (PHP)', width: 15, value: (w) => round2(w.view.totalPayPhp), total: (t) => round2(t.netPhp) },
  { header: 'Net Pay (USD)', width: 14, value: (w) => round2(w.view.totalPayUsd), total: (t) => round2(t.netUsd) },
  { header: 'Paid', width: 15, value: (w) => paidColumn(w) },
];

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** Build the workbook: a titled sheet, one row per week, a totals row. */
export function buildPayStubsWorkbook(
  rawWeeks: PayStubWeek[],
  opts: PayStubExportOptions,
  generatedAt: Date,
): XLSX.WorkBook {
  const weeks = dedupeWeeks(rawWeeks);
  const totals = sumTotals(weeks);
  const wb = XLSX.utils.book_new();

  const banner: (string | number)[][] = [
    ['Pay Stubs'],
    [`Employee: ${opts.employeeName}${opts.department ? ` · ${opts.department}` : ''}`],
    [`Exported ${formatTimestamp(generatedAt)} · ${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'}`],
    ['Pulled from Simple-HRIS System'],
    [],
  ];

  const aoa: (string | number)[][] = [
    ...banner,
    XLSX_COLS.map((c) => c.header),
    ...weeks.map((w) => XLSX_COLS.map((c) => c.value(w))),
    XLSX_COLS.map((c, i) => (i === 0 ? 'TOTAL' : c.total ? c.total(totals) : '')),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = XLSX_COLS.map((c) => ({ wch: c.width }));

  const headerRow = banner.length + 1; // 1-indexed row holding the column headers
  const lastCol = XLSX_COLS.length - 1;
  // Autofilter over the header + data rows (not the totals row).
  ws['!autofilter'] = {
    ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + weeks.length}`,
  };
  // Merge each banner line (minus the blank spacer) across the full width.
  ws['!merges'] = banner.slice(0, banner.length - 1).map((_, i) => ({
    s: { r: i, c: 0 },
    e: { r: i, c: lastCol },
  }));

  XLSX.utils.book_append_sheet(wb, ws, 'Pay Stubs');
  return wb;
}

// ---------------------------------------------------------------------------
// PDF — branded landscape table (Simple navy + orange), totals footer
// ---------------------------------------------------------------------------

const PAGE_W = 792; // US Letter, landscape
const PAGE_H = 612;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 704
const BOTTOM = 56;

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);
const TOTAL_BG = rgb(0.93, 0.93, 0.96);

// pdf-lib's Helvetica is WinAnsi-encoded; map the peso sign + smart punctuation
// to safe equivalents and replace anything else unencodable with '?'.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '₱') out += 'PHP ';
    else if (ch === '–' || ch === '—' || ch === '−') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '…') out += '...';
    else out += '?';
  }
  return out;
}

async function loadLogoBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** "Jul 19 - 25, 2026" (same month) / "Jun 28 - Jul 4, 2026" — the PDF's
 *  compact period label. Shorter than `weekHuman` so the column never crowds
 *  its neighbours; falls back to `weekHuman` when the dates don't parse. */
function compactPeriod(v: PayStubView): string {
  const re = /^(\d{4})-(\d{2})-(\d{2})/;
  const s = v.weekStart ? re.exec(v.weekStart.trim()) : null;
  const e = v.weekEnd ? re.exec(v.weekEnd.trim()) : null;
  if (!s || !e) return v.weekHuman || '-';
  const sm = MONTHS[Number(s[2]) - 1] ?? '';
  const em = MONTHS[Number(e[2]) - 1] ?? '';
  return s[1] === e[1] && s[2] === e[2]
    ? `${sm} ${Number(s[3])} - ${Number(e[3])}, ${e[1]}`
    : `${sm} ${Number(s[3])} - ${em} ${Number(e[3])}, ${e[1]}`;
}

interface PdfColDef {
  header: string;
  align: 'left' | 'right';
  /** Optional columns are HIDDEN when every row renders '-' for them — a
   *  non-HSL employee gets no Weekend columns, someone with no adjustments no
   *  Adjustment column. Fewer columns = real breathing room; the XLSX export
   *  keeps the full fixed column set for ledger use. */
  optional?: boolean;
  cell: (w: PayStubWeek) => string;
  /** Totals-row text for this column ('' renders nothing). */
  total?: (t: Totals, weekCount: number) => string;
}

/** Column catalogue for the PDF summary. "Wknd Hrs"/"Weekend" carry the HSL
 *  Sat+Sun carve-out (regular + OT combined — the XLSX itemizes the two
 *  buckets); Regular/Overtime then hold the weekday portion so a row still
 *  sums across to Net. */
const PDF_COL_DEFS: PdfColDef[] = [
  {
    header: 'Period Ending', align: 'left',
    cell: (w) => compactPeriod(w.view),
    total: (_t, n) => `Total (${n})`,
  },
  { header: 'Reg Hrs', align: 'right', cell: (w) => derive(w).weekdayHours.toFixed(2) },
  { header: 'OT Hrs', align: 'right', cell: (w) => derive(w).weekdayOtHours.toFixed(2) },
  {
    header: 'Regular', align: 'right',
    cell: (w) => n2(derive(w).weekdayPay),
    total: (t) => n2(t.regular),
  },
  {
    header: 'Overtime', align: 'right',
    cell: (w) => n2(derive(w).weekdayOtPay),
    total: (t) => n2(t.ot),
  },
  {
    header: 'Wknd Hrs', align: 'right', optional: true,
    cell: (w) => {
      const d = derive(w);
      const hrs = d.weekendHours + d.weekendOtHours;
      return hrs > 0 ? hrs.toFixed(2) : '-';
    },
  },
  {
    header: 'Weekend', align: 'right', optional: true,
    cell: (w) => {
      const d = derive(w);
      const pay = d.weekendPay + d.weekendOtPay;
      return pay !== 0 ? n2(pay) : '-';
    },
    total: (t) => {
      const pay = t.weekendPay + t.weekendOtPay;
      return pay !== 0 ? n2(pay) : '-';
    },
  },
  {
    header: 'Tech', align: 'right', optional: true,
    cell: (w) => (w.view.techBonus > 0 ? n2(w.view.techBonus) : '-'),
    total: (t) => (t.techBonus > 0 ? n2(t.techBonus) : '-'),
  },
  {
    header: 'PAB', align: 'right', optional: true,
    cell: (w) => (w.view.attendanceBonus > 0 ? n2(w.view.attendanceBonus) : '-'),
    total: (t) => (t.attendanceBonus > 0 ? n2(t.attendanceBonus) : '-'),
  },
  {
    header: 'Perf', align: 'right', optional: true,
    cell: (w) => (w.view.performanceBonus > 0 ? n2(w.view.performanceBonus) : '-'),
    total: (t) => (t.performanceBonus > 0 ? n2(t.performanceBonus) : '-'),
  },
  {
    header: 'Adjustment', align: 'right', optional: true,
    cell: (w) => n2Signed(w.view.adjustment),
    total: (t) => n2Signed(t.adjustment),
  },
  {
    header: 'Orphanage', align: 'right', optional: true,
    cell: (w) => (w.view.orphanagePay > 0 ? n2(w.view.orphanagePay) : '-'),
    total: (t) => (t.orphanagePay > 0 ? n2(t.orphanagePay) : '-'),
  },
  {
    header: 'MESA', align: 'right', optional: true,
    cell: (w) => n2Signed(derive(w).mesaNet),
    total: (t) => n2Signed(t.mesaNet),
  },
  {
    header: 'Net (PHP)', align: 'right',
    cell: (w) => n2(w.view.totalPayPhp),
    total: (t) => n2(t.netPhp),
  },
  {
    header: 'Net (USD)', align: 'right',
    cell: (w) => n2(w.view.totalPayUsd),
    total: (t) => n2(t.netUsd),
  },
  { header: 'Paid', align: 'left', cell: (w) => paidColumn(w) },
];

/** Build the branded all-weeks pay-stubs PDF. Returns the raw bytes. */
export async function generatePayStubsPdf(
  rawWeeks: PayStubWeek[],
  opts: PayStubExportOptions,
  generatedAt: Date,
): Promise<Uint8Array> {
  const weeks = dedupeWeeks(rawWeeks);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  const logoBytes = await loadLogoBytes(opts.logoUrl ?? '/simple-logo.png');
  if (logoBytes) {
    try {
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const year = generatedAt.getFullYear();
  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };
  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };

  const totals = sumTotals(weeks);

  // ── Masthead ──────────────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: NAVY });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${formatTimestamp(generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    state.page.drawText('Pay Stubs', { x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY });
    state.y -= 15;
    const sub = `${opts.employeeName}${opts.department ? ` · ${opts.department}` : ''}   ${String.fromCharCode(0xb7)}   ${weeks.length} paid ${weeks.length === 1 ? 'week' : 'weeks'}`;
    state.page.drawText(sanitize(sub), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 10;
    state.page.drawLine({
      start: { x: MARGIN, y: state.y }, end: { x: PAGE_W - MARGIN, y: state.y },
      thickness: 1.3, color: NAVY,
    });
    state.y -= 16;
  }

  // ── Total net pay summary line ──────────────────────────────────────────────
  {
    const line = `Total Net Pay: PHP ${n2(totals.netPhp)}   (USD ${n2(totals.netUsd)})`;
    ensure(16);
    state.page.drawText(sanitize(line), { x: MARGIN, y: state.y - 11, size: 11, font: bold, color: NAVY });
    state.y -= 24;
  }

  // ── Table ────────────────────────────────────────────────────────────────
  // Layout is MEASURED, never assumed: every visible column is as wide as its
  // widest content (header / cell / totals text) at the chosen font size, so
  // text can never run into the next column — the defect the fixed-weight
  // layout had. Empty optional columns are dropped entirely, then the largest
  // font size (9.5pt down to 6.5pt) whose measured table fits CONTENT_W wins.
  const PAD_X = 5;
  const PAD_Y = 5;

  // 1. Render every cell once (also used for measuring).
  const visibleDefs = PDF_COL_DEFS.filter(
    (def) => !def.optional || weeks.some((w) => def.cell(w) !== '-'),
  );
  const rowsCells = weeks.map((w) => visibleDefs.map((def) => sanitize(def.cell(w))));
  const totalCells = visibleDefs.map((def) => sanitize(def.total?.(totals, weeks.length) ?? ''));
  const headerCells = visibleDefs.map((def) => sanitize(def.header));

  // 2. Largest font size whose widest-content column widths fit the page.
  const SIZES = [9.5, 9, 8.5, 8, 7.5, 7, 6.5];
  let BODY = SIZES[SIZES.length - 1];
  let widths: number[] = [];
  for (const size of SIZES) {
    const measured = visibleDefs.map((_def, i) => {
      let w = bold.widthOfTextAtSize(headerCells[i], size);
      for (const cells of rowsCells) w = Math.max(w, font.widthOfTextAtSize(cells[i], size));
      if (totalCells[i]) w = Math.max(w, bold.widthOfTextAtSize(totalCells[i], size));
      return w + PAD_X * 2;
    });
    const total = measured.reduce((s, w) => s + w, 0);
    if (total <= CONTENT_W || size === SIZES[SIZES.length - 1]) {
      BODY = size;
      widths = measured;
      // Overflow at the floor size (never with realistic column sets): squeeze
      // proportionally — cells are ellipsized at draw time, still no overlap.
      if (total > CONTENT_W) {
        widths = measured.map((w) => (w / total) * CONTENT_W);
      } else {
        // Distribute the slack evenly so the table fills the content width.
        const extra = (CONTENT_W - total) / measured.length;
        widths = measured.map((w) => w + extra);
      }
      break;
    }
  }
  const cols = visibleDefs.map((def, i) => ({ align: def.align, width: widths[i] }));
  const LH = BODY + 2.5;

  /** Ellipsize to the column's inner width — the no-overlap guarantee even for
   *  content that appears only after measuring (defensive; measured cells fit). */
  const fitText = (s: string, f: PDFFont, maxW: number): string => {
    if (f.widthOfTextAtSize(s, BODY) <= maxW) return s;
    let t = s;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, BODY) > maxW) t = t.slice(0, -1);
    return `${t}...`;
  };

  const drawCell = (raw: string, x: number, y: number, w: number, align: 'left' | 'right', f: PDFFont, color = TEXT) => {
    const s = fitText(raw, f, w - PAD_X * 2);
    const tw = f.widthOfTextAtSize(s, BODY);
    const tx = align === 'right' ? x + w - PAD_X - tw : x + PAD_X;
    state.page.drawText(s, { x: tx, y, size: BODY, font: f, color });
  };

  const headerH = LH + PAD_Y * 2;
  const drawHeader = () => {
    state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
    let x = MARGIN;
    for (let i = 0; i < cols.length; i++) {
      drawCell(headerCells[i], x, state.y - PAD_Y - BODY, cols[i].width, cols[i].align, bold, WHITE);
      x += cols[i].width;
    }
    state.y -= headerH;
  };

  ensure(headerH + LH + PAD_Y * 2);
  drawHeader();

  const rowH = LH + PAD_Y * 2;
  let alt = false;
  for (const cells of rowsCells) {
    if (state.y - rowH < BOTTOM) {
      newPage();
      drawHeader();
      alt = false;
    }
    if (alt) {
      state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
    }
    let x = MARGIN;
    for (let i = 0; i < cols.length; i++) {
      drawCell(cells[i] ?? '', x, state.y - PAD_Y - BODY, cols[i].width, cols[i].align, font);
      x += cols[i].width;
    }
    state.page.drawLine({
      start: { x: MARGIN, y: state.y - rowH }, end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
      thickness: 0.5, color: BORDER,
    });
    state.y -= rowH;
    alt = !alt;
  }

  // Totals footer row.
  if (weeks.length > 0) {
    if (state.y - rowH < BOTTOM) { newPage(); drawHeader(); }
    state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: TOTAL_BG });
    let x = MARGIN;
    for (let i = 0; i < cols.length; i++) {
      if (totalCells[i]) drawCell(totalCells[i], x, state.y - PAD_Y - BODY, cols[i].width, cols[i].align, bold, NAVY);
      x += cols[i].width;
    }
    state.y -= rowH;
  }

  if (weeks.length === 0) {
    ensure(20);
    state.page.drawText('No weeks on record yet.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  }

  // ── Footers on every page ───────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Confidential pay record · Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: BORDER });
    p.drawText(sanitize(footerText), { x: MARGIN, y: 28, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 28, size: 8, font, color: MUTED });
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// Browser download helpers
// ---------------------------------------------------------------------------

function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/** Build + download the all-weeks pay-stubs XLSX workbook. */
export function downloadPayStubsXlsx(weeks: PayStubWeek[], opts: PayStubExportOptions): void {
  const now = new Date();
  const wb = buildPayStubsWorkbook(weeks, opts, now);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `pay-stubs-${slug(opts.employeeName)}-${dateSuffix(now)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the branded all-weeks pay-stubs PDF. */
export async function downloadPayStubsPdf(weeks: PayStubWeek[], opts: PayStubExportOptions): Promise<void> {
  const now = new Date();
  const bytes = await generatePayStubsPdf(weeks, opts, now);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`pay-stubs-${slug(opts.employeeName)}-${dateSuffix(now)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}

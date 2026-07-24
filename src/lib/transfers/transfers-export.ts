// Accounting Transfers → CSV + XLSX + PDF export.
//
// Turns the transfer history currently in view (respecting the active search)
// into a portable audit record in three formats:
//
//   - CSV   → one flat, spreadsheet-friendly table (UTF-8 BOM so Excel renders
//             the peso symbol correctly), with a short provenance preamble.
//   - XLSX  → a native Excel workbook (title banner + at-a-glance summary +
//             one row per transfer, sized columns, autofilter over the header).
//   - PDF   → a branded document built from scratch with pdf-lib so it deploys
//             cleanly on Vercel (no template file read at runtime), carrying the
//             Simple logo in the masthead.
//
// All three run entirely in the browser (in-memory Blob download) — the rows are
// already loaded in the tab, so there's no server round-trip.
//
// The visual theme deliberately mirrors the Accounting dashboard's warm orange
// accent (matching the sibling `people-roster-export.ts`). pdf-lib fills are
// single-colour, so the orange→rose gradient is reproduced by interpolating a
// strip of thin rectangles (see drawHGradient).
//
// NOTE on XLSX theming: the pure-JS `xlsx` (SheetJS community) build does not
// emit cell fills / font colours — that's a Pro-only feature. So the sheet's
// "theme" is structural (title/summary banner rows, sized columns, an
// auto-filtered header) rather than coloured cells. The PDF carries the full
// colour treatment.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { AccountingTransferRow, TransferRateChange } from '@/lib/transfers/accounting-transfers';
import type { TransferRequestStatus } from '@/lib/supabase/department-transfer-requests';
import { CURRENCY_SYMBOL, type PayCurrency } from '@/lib/payment-catalog/pay-structure';

// ---------------------------------------------------------------------------
// Structured model
// ---------------------------------------------------------------------------

const DASH = '-';

/** Human-facing status labels — match the on-screen chips exactly. */
const STATUS_LABEL: Record<TransferRequestStatus, string> = {
  pending: 'Awaiting release',
  approved: 'Scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

/** One transfer, normalized for the flat table. */
export interface TransferExportRecord {
  employee: string;
  from: string;
  to: string;
  status: string;
  requestedBy: string;
  releasedBy: string;
  effective: string;
  rateChange: string;
  sheetSync: string;
  createdAt: string; // formatted
}

export interface TransferExportModel {
  generatedAt: Date;
  rows: TransferExportRecord[];
  /** Total transfers loaded BEFORE the in-view (search) filter. */
  total: number;
  /** Describes the in-view filter, e.g. "All transfers" or 'matching "kane"'. */
  filterLabel: string;
  // ── Rollups over the exported (filtered) rows ──
  appliedCount: number;
  awaitingCount: number;
  scheduledCount: number;
  sheetFailCount: number;
}

function clean(v: string | null | undefined): string {
  return (v ?? '').toString().trim();
}

/** "Jul 4, 2026" for an ISO/free-text date; '' when absent, raw when unparseable. */
function formatDate(iso: string | null | undefined): string {
  const s = clean(iso);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

/** Rate in its own currency (PHP/USD/COP), 2 decimals. `ascii` swaps ₱ for
 *  "PHP " so it survives pdf-lib's WinAnsi Helvetica encoding. */
function money(n: number | null, c: PayCurrency | null, ascii = false): string {
  if (n == null) return DASH;
  const sym = c ? CURRENCY_SYMBOL[c] : '';
  const num = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (ascii && c === 'PHP') return `PHP ${num}`;
  return `${sym}${num}`;
}

/** Flatten a rate change to a single "old → new" cell (matches the RateCell chip). */
function rateChangeStr(rc: TransferRateChange | null, ascii = false): string {
  if (!rc || (rc.old_regular == null && rc.new_regular == null)) return 'no catalog rate set';
  return `${money(rc.old_regular, rc.old_currency, ascii)} -> ${money(rc.new_regular, rc.new_currency, ascii)}`;
}

/** Effective date, or the proposed one flagged as such, mirroring the table cell. */
function effectiveStr(r: AccountingTransferRow): string {
  if (r.effective_date) return formatDate(r.effective_date);
  if (r.proposed_effective_date) return `${formatDate(r.proposed_effective_date)} (proposed)`;
  return DASH;
}

/** Sheet-sync state as a short label — only meaningful for applied rows. */
function sheetSyncStr(r: AccountingTransferRow): string {
  if (r.status !== 'applied') return DASH;
  return r.sheet_synced ? 'Synced' : 'Not synced';
}

/** Shape the raw transfer rows into a clean, per-transfer export model + rollups. */
export function buildTransferExport(input: {
  rows: readonly AccountingTransferRow[];
  total: number;
  filterLabel?: string;
}): TransferExportModel {
  const rows: TransferExportRecord[] = input.rows.map((r) => ({
    employee: clean(r.employee_name) || clean(r.employee_email) || 'Unknown',
    from: clean(r.from_department) || DASH,
    to: clean(r.to_department) || DASH,
    status: STATUS_LABEL[r.status] ?? r.status,
    requestedBy: clean(r.requested_by) || DASH,
    releasedBy: clean(r.decided_by) || DASH,
    effective: effectiveStr(r),
    rateChange: rateChangeStr(r.rate_change),
    sheetSync: sheetSyncStr(r),
    createdAt: formatDate(r.created_at),
  }));

  let appliedCount = 0;
  let awaitingCount = 0;
  let scheduledCount = 0;
  let sheetFailCount = 0;
  for (const r of input.rows) {
    if (r.status === 'applied') appliedCount += 1;
    if (r.status === 'pending') awaitingCount += 1;
    if (r.status === 'approved') scheduledCount += 1;
    if (r.status === 'applied' && !r.sheet_synced) sheetFailCount += 1;
  }

  return {
    generatedAt: new Date(),
    rows,
    total: input.total,
    filterLabel: clean(input.filterLabel) || 'All transfers',
    appliedCount,
    awaitingCount,
    scheduledCount,
    sheetFailCount,
  };
}

// ---------------------------------------------------------------------------
// Shared: formatting helpers
// ---------------------------------------------------------------------------

/** Full export timestamp, e.g. "July 20, 2026, 3:45 PM GMT+8" (viewer local time). */
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

function countLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'transfer' : 'transfers'}`;
}

/** "3 of 402 loaded" (or just the count when the view is unfiltered). */
function scopeCountLabel(model: TransferExportModel): string {
  const shown = model.rows.length;
  if (shown === model.total) return `${countLabel(shown)}`;
  return `${countLabel(shown)} of ${model.total.toLocaleString()} loaded`;
}

/** The provenance summary line shared across all three formats. */
function summaryLine(model: TransferExportModel): string {
  return `${scopeCountLabel(model)} · ${model.appliedCount} applied · ${model.awaitingCount} awaiting release · ${model.scheduledCount} scheduled${model.sheetFailCount > 0 ? ` · ${model.sheetFailCount} sheet-sync failure${model.sheetFailCount === 1 ? '' : 's'}` : ''}`;
}

// ---------------------------------------------------------------------------
// Shared columns — the flat CSV / XLSX table
// ---------------------------------------------------------------------------

interface FlatColumn {
  header: string;
  get: (r: TransferExportRecord) => string;
}

const FLAT_COLUMNS: FlatColumn[] = [
  { header: 'Employee', get: (r) => r.employee },
  { header: 'From', get: (r) => r.from },
  { header: 'To', get: (r) => r.to },
  { header: 'Effective', get: (r) => r.effective },
  { header: 'Requested By', get: (r) => r.requestedBy },
  { header: 'Released By', get: (r) => r.releasedBy },
  { header: 'Rate Change', get: (r) => r.rateChange },
  { header: 'Status', get: (r) => r.status },
  { header: 'Sheet Sync', get: (r) => r.sheetSync },
  { header: 'Requested On', get: (r) => r.createdAt },
];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 escaping: wrap in quotes when the value has a comma/quote/newline. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize the model to a single flat CSV table (with a UTF-8 BOM). */
export function transfersToCsv(model: TransferExportModel): string {
  const year = model.generatedAt.getFullYear();
  const preamble = [
    ['Department Transfers'],
    [`Filter: ${model.filterLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [summaryLine(model)],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...FLAT_COLUMNS.map((c) => c.header)].map(csvEscape).join(',');
  const body = model.rows.map((r, i) =>
    [i + 1, ...FLAT_COLUMNS.map((c) => c.get(r))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XLSX_COLUMN_WIDTHS = [26, 18, 18, 20, 26, 26, 24, 16, 12, 16];

/** Build a native Excel workbook: a titled sheet with one row per transfer. */
export function buildTransfersWorkbook(model: TransferExportModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const aoa: (string | number)[][] = [
    ['Department Transfers'],
    [`Filter: ${model.filterLabel}`],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${summaryLine(model)}`],
    [],
    ['#', ...FLAT_COLUMNS.map((c) => c.header)],
  ];
  model.rows.forEach((r, i) => {
    aoa.push([i + 1, ...FLAT_COLUMNS.map((c) => c.get(r))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, ...XLSX_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  const headerRow = 5; // 1-indexed row that holds the column headers
  const lastCol = FLAT_COLUMNS.length; // 0=`#`, then one per column
  ws['!autofilter'] = { ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + model.rows.length}` };
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Transfers');
  return wb;
}

// ---------------------------------------------------------------------------
// PDF — Accounting warm orange → rose themed
// ---------------------------------------------------------------------------

const PAGE_W = 792; // US Letter, LANDSCAPE (wide audit table)
const PAGE_H = 612;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2; // 712
const BOTTOM = 52;

type RGB = readonly [number, number, number];
const C_ORANGE: RGB = [0.918, 0.345, 0.047]; // #EA580C  orange-600
const C_ORANGE_500: RGB = [0.976, 0.451, 0.086]; // #F97316  orange-500
const C_ROSE: RGB = [0.957, 0.247, 0.369]; // #F43F5E  rose-500
const C_AMBER: RGB = [0.961, 0.62, 0.043]; // #F59E0B  amber-500
const tup = (c: RGB) => rgb(c[0], c[1], c[2]);

const ORANGE = tup(C_ORANGE);
const AMBER = tup(C_AMBER);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900  #18181B
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500  #71717A
const ROW_ALT = rgb(1, 0.969, 0.929); // orange-50  #FFF7ED  (warm zebra)
const BORDER = rgb(0.914, 0.871, 0.812); // warm hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (smart punctuation, arrows) with safe equivalents.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '→') out += '->';
    else if (ch === '…') out += '...';
    else out += '?';
  }
  return out;
}

/** Wrap text to a width, hard-breaking tokens that are themselves too long. */
function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitize(raw).trim();
  if (!text) return [''];
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/)) {
    while (!fits(word)) {
      let i = word.length;
      while (i > 1 && !fits(word.slice(0, i))) i--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, i));
      word = word.slice(i);
      if (i <= 1 && word.length) break;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && !fits(candidate)) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Draw a horizontal gradient bar by slicing into thin rectangles. */
function drawHGradient(
  page: PDFPage, x: number, y: number, w: number, h: number,
  from: RGB, to: RGB, steps = 60,
): void {
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const r = from[0] + (to[0] - from[0]) * t;
    const g = from[1] + (to[1] - from[1]) * t;
    const b = from[2] + (to[2] - from[2]) * t;
    page.drawRectangle({ x: x + i * sw, y, width: sw + 0.6, height: h, color: rgb(r, g, b) });
  }
}

type Col = { header: string; width: number; align?: 'left' | 'right' };

async function loadLogoBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** Build the Accounting-themed PDF report. Returns the raw PDF bytes. */
export async function generateTransfersPdf(
  model: TransferExportModel,
  opts: { logoUrl?: string } = {},
): Promise<Uint8Array> {
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

  const year = model.generatedAt.getFullYear();
  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };

  // ── Masthead (page 1) ─────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: ORANGE });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, INK);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 48;
    state.page.drawText('ACCOUNTING - DEPARTMENT TRANSFERS', { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ORANGE });
    state.y -= 18;
    state.page.drawText('Department Transfers', { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 14;
    state.page.drawText(sanitize(model.filterLabel), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 11;
    state.page.drawText(sanitize(scopeCountLabel(model)), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 9;
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_ORANGE_500, C_ROSE);
    state.y -= 18;
  }

  // ── At-a-glance metric band (amber-topped stat cards) ──────────────────────
  {
    const items: { label: string; value: string; sub: string }[] = [
      { label: 'Applied', value: model.appliedCount.toLocaleString(), sub: 'completed moves' },
      { label: 'Awaiting release', value: model.awaitingCount.toLocaleString(), sub: 'pending requests' },
      { label: 'Scheduled', value: model.scheduledCount.toLocaleString(), sub: 'released, not applied' },
      { label: 'Sheet-sync failures', value: model.sheetFailCount.toLocaleString(), sub: 'need a retry' },
    ];
    const gap = 10;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 52;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: AMBER });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 9, y: state.y + boxH - 16, size: 7, font: bold, color: MUTED });
      state.page.drawText(sanitize(item.value), { x: x + 9, y: state.y + 17, size: 18, font: bold, color: ORANGE });
      state.page.drawText(sanitize(item.sub), { x: x + 9, y: state.y + 7, size: 7, font, color: MUTED });
    });
    state.y -= 16;
  }

  // ── Transfers table (orange header, warm zebra; paginates) ─────────────────
  const BODY = 8;
  const LH = 10.5;
  const PAD_X = 6;
  const PAD_Y = 5;

  // Column widths sum to CONTENT_W (712). The last column absorbs the remainder.
  const w = { num: 20, emp: 96, move: 118, eff: 78, req: 92, rel: 92, rate: 108 };
  const columns: Col[] = [
    { header: '#', width: w.num, align: 'right' },
    { header: 'Employee', width: w.emp },
    { header: 'Move', width: w.move },
    { header: 'Effective', width: w.eff },
    { header: 'Requested by', width: w.req },
    { header: 'Released by', width: w.rel },
    { header: 'Rate change', width: w.rate },
    { header: 'Status', width: CONTENT_W - w.num - w.emp - w.move - w.eff - w.req - w.rel - w.rate },
  ];
  const tableRows = model.rows.map((r, i) => [
    String(i + 1),
    r.employee,
    `${r.from} -> ${r.to}`,
    r.effective,
    r.requestedBy,
    r.releasedBy,
    rateChangeAscii(r),
    r.sheetSync !== DASH ? `${r.status} (${r.sheetSync})` : r.status,
  ]);

  const drawTable = (cols: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: ORANGE });
      let x = MARGIN;
      for (const c of cols) {
        const label = wrapText(c.header, bold, BODY, c.width - PAD_X * 2)[0];
        const tw = bold.widthOfTextAtSize(label, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(label, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };

    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();

    let alt = false;
    for (const row of rows) {
      const cellLines = cols.map((c, i) => wrapText(row[i] ?? '', font, BODY, c.width - PAD_X * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * LH + PAD_Y * 2;

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
        const c = cols[i];
        const lines = cellLines[i];
        for (let li = 0; li < lines.length; li++) {
          const tw = font.widthOfTextAtSize(lines[li], BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: INK });
        }
        x += c.width;
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH },
        end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5,
        color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    }
    state.y -= 8;
  };

  if (model.rows.length === 0) {
    ensure(20);
    state.page.drawText('No transfers match this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  } else {
    drawTable(columns, tableRows);
  }

  // ── Footers on every page ──────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p: PDFPage, i: number) => {
    drawHGradient(p, MARGIN, 37, CONTENT_W, 1, C_ORANGE_500, C_ROSE, 40);
    p.drawText(sanitize(footerText), { x: MARGIN, y: 24, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const pw = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - pw, y: 24, size: 8, font, color: MUTED });
  });

  return doc.save();
}

/** The rate-change cell for the PDF: "no catalog rate set" or "old -> new" with
 *  the peso glyph swapped for "PHP " (WinAnsi-safe). Rebuilt from the record's
 *  already-flattened string, replacing the ₱ symbol so Helvetica can encode it. */
function rateChangeAscii(r: TransferExportRecord): string {
  return r.rateChange.replace(/₱/g, 'PHP ');
}

// ---------------------------------------------------------------------------
// Browser download helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

function baseName(model: TransferExportModel): string {
  return `department-transfers-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadTransfersCsv(model: TransferExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([transfersToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadTransfersXlsx(model: TransferExportModel): void {
  const wb = buildTransfersWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the Accounting-themed PDF report. */
export async function downloadTransfersPdf(
  model: TransferExportModel,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generateTransfersPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}

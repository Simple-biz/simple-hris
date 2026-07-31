// Pay Cycle Report → CSV + XLSX + PDF export.
//
// Renders a PUBLISHED (frozen) pay-cycle report — see pay-cycle-report-snapshot.ts
// — into three portable formats, all built in the browser from the snapshot the
// tab already holds. No server round-trip, and no risk of the export disagreeing
// with the report on screen.
//
//   - CSV  → one flat table with a provenance preamble, UTF-8 BOM so Excel
//            renders the peso sign.
//   - XLSX → native workbook: title/summary banner, sized columns, autofilter.
//   - PDF  → branded document built from scratch with pdf-lib (deploys cleanly
//            on Vercel; no template read at runtime), Simple logo in the
//            masthead, warm orange→rose Accounting treatment.
//
// Mirrors src/lib/transfers/transfers-export.ts deliberately — same theme, same
// gradient-by-slices technique, same WinAnsi sanitizer. SheetJS community emits
// no cell fills, so the XLSX "theme" is structural only; the PDF carries colour.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { PayCycleReportPayee, PayCycleReportSnapshot } from './pay-cycle-report-snapshot';

/** Fallback for any missing optional field in printed/tabular output. */
const DASH = '-';

// ---------------------------------------------------------------------------
// Structured model
// ---------------------------------------------------------------------------

export interface PayCycleReportExportModel {
  generatedAt: Date;
  /** The full frozen record — totals and byProcessor always describe the whole
   *  published cycle, never just the (possibly search-filtered) `rows` below. */
  snapshot: PayCycleReportSnapshot;
  /** The payee rows to actually render. Defaults to every payee in the
   *  snapshot; callers pass the filtered list when a search is active in the
   *  Reports tab so the export matches what's on screen. */
  rows: PayCycleReportPayee[];
  /** Document heading, e.g. "Pay Cycle Report". */
  title: string;
  /** Small-caps eyebrow above the PDF title. */
  eyebrow: string;
  /** Download filename stem (a YYYY-MM-DD suffix is appended). */
  fileBase: string;
  /** Describes the in-view filter/cycle, e.g. the report's own label. */
  filterLabel: string;
}

/** Shape a published snapshot (optionally search-filtered) into the export
 *  model shared by CSV / XLSX / PDF. */
export function buildPayCycleReportExport(
  snapshot: PayCycleReportSnapshot,
  opts: { rows?: PayCycleReportPayee[]; filterLabel?: string; generatedAt?: Date } = {},
): PayCycleReportExportModel {
  return {
    generatedAt: opts.generatedAt ?? new Date(),
    snapshot,
    rows: opts.rows ?? snapshot.payees,
    title: 'Pay Cycle Report',
    eyebrow: 'ACCOUNTING - PAY CYCLE REPORT',
    fileBase: `pay-cycle-report-${snapshot.period_start ?? snapshot.source_file.replace(/\.csv$/i, '')}`,
    filterLabel: clean(opts.filterLabel) || snapshot.label,
  };
}

// ---------------------------------------------------------------------------
// Shared: formatting helpers
// ---------------------------------------------------------------------------

function clean(v: string | null | undefined): string {
  return (v ?? '').toString().trim();
}

/** `$1,234.56` / `₱1,234.56` — 2 decimals, thousands-grouped for on-screen /
 *  CSV-preamble / PDF prose use. (The flat CSV table body formats amounts
 *  separately, without grouping — see payCycleReportToCsv.) */
function money(n: number, currency: 'USD' | 'PHP'): string {
  const sym = currency === 'USD' ? '$' : '₱';
  const num = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${num}`;
}

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

function typeLabel(p: PayCycleReportPayee): 'Contractor' | 'Employee' {
  return p.payeeType === 'contractor' ? 'Contractor' : 'Employee';
}

function dash(v: string | null | undefined): string {
  return v ?? DASH;
}

// ---------------------------------------------------------------------------
// Summary line — shared by all three formats
// ---------------------------------------------------------------------------

/** "42 payments" (unfiltered) or "17 of 42 payments" when a search narrowed
 *  the exported rows. */
function paymentsLabel(shown: number, total: number): string {
  if (shown === total) return `${total.toLocaleString()} payments`;
  return `${shown.toLocaleString()} of ${total.toLocaleString()} payments`;
}

/** The at-a-glance line repeated in the CSV preamble and PDF masthead. Money
 *  and payee-count figures always come from the snapshot's own totals — a
 *  search filter changes which rows are listed, never what the published
 *  cycle says it paid. */
function summaryLine(model: PayCycleReportExportModel): string {
  const { totals } = model.snapshot;
  return [
    paymentsLabel(model.rows.length, totals.dispatchCount),
    `${totals.payeeCount.toLocaleString()} payees`,
    money(totals.paidUSD, 'USD'),
    money(totals.paidPHP, 'PHP'),
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// Shared columns — the flat CSV / XLSX table
// ---------------------------------------------------------------------------

interface FlatColumn {
  header: string;
  width: number;
  get: (p: PayCycleReportPayee) => string | number;
}

const FLAT_COLUMNS: FlatColumn[] = [
  { header: 'Name',           width: 26, get: (p) => p.name ?? p.email },
  { header: 'Email',          width: 30, get: (p) => p.email },
  { header: 'Type',           width: 12, get: (p) => (p.payeeType === 'contractor' ? 'Contractor' : 'Employee') },
  { header: 'Processor',      width: 14, get: (p) => p.processor },
  { header: 'Amount (USD)',   width: 14, get: (p) => p.amountUSD },
  { header: 'Amount (PHP)',   width: 16, get: (p) => p.amountPHP },
  { header: 'Transaction ID', width: 22, get: (p) => p.transactionId ?? '' },
  { header: 'Bank Used',      width: 20, get: (p) => p.bankUsed ?? '' },
  { header: 'Date Sent',      width: 14, get: (p) => p.dateSent ?? '' },
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

/** Numbers in the flat body stay plain 2-decimal (no thousands grouping) so a
 *  spreadsheet import never splits an amount on the comma. */
function csvCell(v: string | number): string {
  return typeof v === 'number' ? v.toFixed(2) : v;
}

/** Serialize the model to a single flat CSV table (with a UTF-8 BOM and a
 *  short provenance preamble ahead of the header row). */
export function payCycleReportToCsv(model: PayCycleReportExportModel): string {
  const { snapshot } = model;
  const year = model.generatedAt.getFullYear();
  const preamble = [
    [model.title],
    [`Cycle: ${model.filterLabel}`],
    [`Period: ${snapshot.period_start ?? DASH} to ${snapshot.period_end ?? DASH}`],
    [`Published: ${formatTimestamp(new Date(snapshot.published_at))} by ${snapshot.published_by_email}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [summaryLine(model)],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...FLAT_COLUMNS.map((c) => c.header)].map(csvEscape).join(',');
  const body = model.rows.map((p, i) =>
    [i + 1, ...FLAT_COLUMNS.map((c) => csvCell(c.get(p)))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Build a native Excel workbook: a titled sheet with one row per payee.
 *  Amounts stay numeric (unlike the CSV) so Excel can sum them directly. */
export function buildPayCycleReportWorkbook(model: PayCycleReportExportModel): XLSX.WorkBook {
  const { snapshot } = model;
  const wb = XLSX.utils.book_new();
  const aoa: (string | number)[][] = [
    [model.title],
    [`Cycle: ${model.filterLabel} / Period: ${snapshot.period_start ?? DASH} to ${snapshot.period_end ?? DASH}`],
    [
      `Published: ${formatTimestamp(new Date(snapshot.published_at))} by ${snapshot.published_by_email}` +
        ` · Exported ${formatTimestamp(model.generatedAt)}`,
    ],
    [],
    ['#', ...FLAT_COLUMNS.map((c) => c.header)],
  ];
  model.rows.forEach((p, i) => {
    aoa.push([i + 1, ...FLAT_COLUMNS.map((c) => c.get(p))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const headerRow = 5; // 1-indexed row that holds the column headers
  const lastCol = FLAT_COLUMNS.length; // 0 = `#`, then one per column
  ws['!cols'] = [{ wch: 5 }, ...FLAT_COLUMNS.map((c) => ({ wch: c.width }))];
  ws['!autofilter'] = { ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + model.rows.length}` };
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Pay Cycle Report');
  return wb;
}

// ---------------------------------------------------------------------------
// PDF — Accounting warm orange → rose themed
// ---------------------------------------------------------------------------

const PAGE_W = 792; // US Letter, LANDSCAPE (wide payee table)
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

const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900  #18181B
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500  #71717A
const ACCENT = tup(C_ORANGE);
const STRIPE = tup(C_AMBER);
const ROW_ALT = rgb(1, 0.969, 0.929); // orange-50  #FFF7ED
const BORDER = rgb(0.914, 0.871, 0.812); // warm hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (peso sign, smart punctuation, arrows) with
// safe equivalents. The peso sign gets its own branch — unlike the sibling
// transfers-export.ts, this module's data (bank names, notes) can carry a
// literal ₱ from arbitrary payee fields rather than only from our own money()
// calls, so the general sanitizer itself must catch it, not just call sites.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '₱') out += 'PHP ';
    else if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
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

/** Build the themed PDF report. Returns the raw PDF bytes. */
export async function generatePayCycleReportPdf(
  model: PayCycleReportExportModel,
  opts: { logoUrl?: string } = {},
): Promise<Uint8Array> {
  const { snapshot } = model;
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
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: ACCENT });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, INK);
    right(`Published ${formatTimestamp(new Date(snapshot.published_at))} by ${snapshot.published_by_email}`, top - 21, 8.5, font);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 32, 8, font);

    state.y = top - 48;
    state.page.drawText(sanitize(model.eyebrow), { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ACCENT });
    state.y -= 18;
    state.page.drawText(sanitize(model.title), { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 14;
    state.page.drawText(sanitize(model.filterLabel), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 11;
    state.page.drawText(sanitize(summaryLine(model)), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 9;
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_ORANGE_500, C_ROSE);
    state.y -= 18;
  }

  // ── At-a-glance metric band (accent-topped stat cards) ─────────────────────
  // Always exactly four — unlike transfers-export's status buckets (some of
  // which are legitimately absent), every one of these totals is always
  // meaningful for a published cycle, even if zero.
  {
    const { totals } = snapshot;
    const items = [
      {
        label: 'Payees',
        value: totals.payeeCount.toLocaleString(),
        sub: `${totals.employeeCount.toLocaleString()} employees, ${totals.contractorCount.toLocaleString()} contractors`,
      },
      { label: 'Payments', value: totals.dispatchCount.toLocaleString(), sub: 'dispatches paid' },
      { label: 'Total paid (USD)', value: money(totals.paidUSD, 'USD'), sub: 'across all processors' },
      { label: 'Total paid (PHP)', value: money(totals.paidPHP, 'PHP'), sub: 'across all processors' },
    ];

    const gap = 10;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 52;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: STRIPE });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 9, y: state.y + boxH - 16, size: 7, font: bold, color: MUTED });
      state.page.drawText(sanitize(item.value), { x: x + 9, y: state.y + 17, size: 18, font: bold, color: ACCENT });
      state.page.drawText(sanitize(item.sub), { x: x + 9, y: state.y + 7, size: 7, font, color: MUTED });
    });
    state.y -= 16;
  }

  // ── "Paid by processor" band ────────────────────────────────────────────────
  {
    const entries = Object.entries(snapshot.byProcessor).sort((a, b) => b[1].usd - a[1].usd);
    if (entries.length > 0) {
      ensure(12);
      state.page.drawText('PAID BY PROCESSOR', { x: MARGIN, y: state.y, size: 7.5, font: bold, color: MUTED });
      state.y -= 12;

      const gap = 8;
      const cellW = 130;
      const cellH = 32;
      const perRow = Math.max(1, Math.floor((CONTENT_W + gap) / (cellW + gap)));
      for (let i = 0; i < entries.length; i += perRow) {
        const rowEntries = entries.slice(i, i + perRow);
        ensure(cellH);
        state.y -= cellH;
        rowEntries.forEach(([processor, stats], col) => {
          const x = MARGIN + col * (cellW + gap);
          state.page.drawRectangle({ x, y: state.y, width: cellW, height: cellH, color: WHITE, borderColor: BORDER, borderWidth: 0.5 });
          state.page.drawText(sanitize(processor), { x: x + 8, y: state.y + cellH - 13, size: 8, font: bold, color: INK });
          const sub = `${stats.count.toLocaleString()} · ${money(stats.usd, 'USD')}`;
          state.page.drawText(sanitize(sub), { x: x + 8, y: state.y + 9, size: 7.5, font, color: MUTED });
        });
      }
      state.y -= 14;
    }
  }

  // ── Payee table (orange header, warm zebra; paginates) ──────────────────────
  const BODY = 8;
  const LH = 10.5;
  const PAD_X = 6;
  const PAD_Y = 5;

  // Column widths sum to CONTENT_W (712). `Sent` absorbs the remainder. `#`
  // must fit three Helvetica digits at 8pt plus PAD_X*2 (13.35 + 12 = 25.4pt):
  // transfers-export.ts documents that a narrower 20pt column — less than the
  // width of "10" — hard-broke every row from #10 on into stacked digits.
  const w = { num: 26, name: 85, email: 120, type: 54, proc: 58, usd: 64, php: 82, txn: 90, bank: 70 };
  const used = w.num + w.name + w.email + w.type + w.proc + w.usd + w.php + w.txn + w.bank;
  const columns: Col[] = [
    { header: '#', width: w.num, align: 'right' },
    { header: 'Name', width: w.name },
    { header: 'Email', width: w.email },
    { header: 'Type', width: w.type },
    { header: 'Processor', width: w.proc },
    { header: 'USD', width: w.usd, align: 'right' },
    { header: 'PHP', width: w.php, align: 'right' },
    { header: 'Txn ID', width: w.txn },
    { header: 'Bank used', width: w.bank },
    { header: 'Sent', width: CONTENT_W - used },
  ];
  const tableRows = model.rows.map((p, i) => [
    String(i + 1),
    p.name ?? p.email,
    p.email,
    typeLabel(p),
    p.processor,
    money(p.amountUSD, 'USD'),
    money(p.amountPHP, 'PHP'),
    dash(p.transactionId),
    dash(p.bankUsed),
    dash(p.dateSent),
  ]);

  const drawTable = (cols: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: ACCENT });
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
    state.page.drawText('No payments in this report.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
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

function baseName(model: PayCycleReportExportModel): string {
  return `${model.fileBase}-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadPayCycleReportCsv(model: PayCycleReportExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([payCycleReportToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadPayCycleReportXlsx(model: PayCycleReportExportModel): void {
  const wb = buildPayCycleReportWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the themed PDF report. */
export async function downloadPayCycleReportPdf(
  model: PayCycleReportExportModel,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generatePayCycleReportPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}

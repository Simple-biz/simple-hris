// Accounting — MESA → CSV + XLSX + PDF export.
//
// Spec-driven: each MESA tab (Requests / Non Members / Active Members) hands
// this module a MesaExportSpec — title, scope, stat band, columns, and
// pre-formatted string rows — and gets back the same three formats the HR
// Global Master List export produces:
//
//   - CSV   → one flat, spreadsheet-friendly table (UTF-8 BOM so Excel renders
//             symbols correctly), with a short provenance preamble.
//   - XLSX  → a native Excel workbook (title banner + one row per record,
//             sized columns, autofilter).
//   - PDF   → a branded document built from scratch with pdf-lib so it deploys
//             cleanly on Vercel (no template file read at runtime).
//
// All three run entirely in the browser (in-memory Blob download) — the rows
// are already loaded in the tab, so there's no server round-trip.
//
// The visual theme deliberately mirrors the CEO dashboard (same treatment as
// src/lib/hr/global-master-list-export.ts): the warm orange→rose gradient
// accents and amber/gold highlights from src/components/ceo/CeoOverviewKpis.tsx.
// pdf-lib fills are single-colour, so the dashboard's signature orange→rose
// gradient is reproduced by interpolating a strip of thin rectangles
// (see drawHGradient).
//
// NOTE on XLSX theming: the pure-JS `xlsx` (SheetJS community) build does not
// emit cell fills / font colours when it writes a workbook — that's a Pro-only
// feature. So the spreadsheet's "theme" is necessarily structural (title/summary
// banner rows, sized columns, an auto-filtered header) rather than coloured
// cells. The PDF carries the full colour treatment.
//
// MESA-specific caveat carried on the Active Members export via spec.notes:
// figures are scoped to each member's CURRENT (open) account number. An
// opt-out closes that account — its history is retained in the mesa_ledger
// under the old number (nothing is deleted) — and a re-join opens a fresh
// account number starting from PHP 0.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface MesaExportColumn {
  header: string;
  align?: 'left' | 'right';
  /** Relative width in the PDF table — weights are scaled to fill the page. */
  pdfWeight: number;
  /** Excel column width in characters. */
  xlsxWidth: number;
}

export interface MesaExportStat {
  label: string;
  value: string;
}

export interface MesaExportSpec {
  /** Orange eyebrow above the PDF title, e.g. 'ACCOUNTING - MESA'. */
  eyebrow: string;
  /** Report title, e.g. 'MESA Active Members'. */
  title: string;
  /** Excel sheet name — must be ≤31 chars (XLSX hard limit). */
  sheetName: string;
  /** Filename stem, e.g. 'mesa-active-members' → mesa-active-members-2026-07-17.pdf */
  fileBase: string;
  /** Describes the filter the rows were pulled from, e.g. 'All departments'. */
  scopeLabel: string;
  /** Singular/plural noun for row counts, e.g. ['member', 'members']. */
  countNoun: [string, string];
  /** At-a-glance stat band (amber-topped cards in the PDF). Up to ~4 reads well. */
  stats: MesaExportStat[];
  columns: MesaExportColumn[];
  /** Pre-formatted display strings, one array per record (matches columns). */
  rows: string[][];
  /** Caveat lines rendered under the PDF table and in the CSV/XLSX preamble. */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Shared: timestamp + counts
// ---------------------------------------------------------------------------

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

function countLabel(spec: MesaExportSpec): string {
  const n = spec.rows.length;
  return `${n.toLocaleString()} ${n === 1 ? spec.countNoun[0] : spec.countNoun[1]}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 escaping: wrap in quotes when the value has a comma/quote/newline. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize the spec to a single flat CSV table (with a UTF-8 BOM). */
export function mesaExportToCsv(spec: MesaExportSpec, generatedAt: Date): string {
  const year = generatedAt.getFullYear();
  const preamble = [
    [spec.title],
    [`Scope: ${spec.scopeLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(generatedAt)}`],
    [countLabel(spec)],
    ...spec.stats.map((s) => [`${s.label}: ${s.value}`]),
    ...(spec.notes ?? []).map((n) => [`Note: ${n}`]),
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...spec.columns.map((c) => c.header)].map(csvEscape).join(',');
  const body = spec.rows.map((r, i) => [i + 1, ...r].map(csvEscape).join(','));
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Build a native Excel workbook: a titled sheet with one row per record. */
export function buildMesaWorkbook(spec: MesaExportSpec, generatedAt: Date): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const banner: (string | number)[][] = [
    [spec.title],
    [`Scope: ${spec.scopeLabel}`],
    [`Exported ${formatTimestamp(generatedAt)} · ${countLabel(spec)}`],
    ...(spec.notes ?? []).map((n) => [`Note: ${n}`]),
    [],
  ];
  const aoa: (string | number)[][] = [
    ...banner,
    ['#', ...spec.columns.map((c) => c.header)],
  ];
  spec.rows.forEach((r, i) => {
    aoa.push([i + 1, ...r]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, ...spec.columns.map((c) => ({ wch: c.xlsxWidth }))];
  // Turn on an autofilter across the header row so the sheet opens ready to
  // sort/filter. (Freeze panes aren't emitted by the pure-JS xlsx writer —
  // that's a SheetJS-Pro-only feature.)
  const headerRow = banner.length + 1; // 1-indexed row that holds the column headers
  const lastCol = spec.columns.length; // 0=`#`, then one per column
  ws['!autofilter'] = { ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + spec.rows.length}` };
  // Merge the banner rows (minus the blank spacer) across the full width so
  // the title reads cleanly.
  ws['!merges'] = banner.slice(0, banner.length - 1).map((_, i) => ({
    s: { r: i, c: 0 },
    e: { r: i, c: lastCol },
  }));
  XLSX.utils.book_append_sheet(wb, ws, spec.sheetName.slice(0, 31));
  return wb;
}

// ---------------------------------------------------------------------------
// PDF — CEO-dashboard themed (warm orange → rose + amber/gold)
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

// Palette lifted from the CEO dashboard (CeoOverviewKpis.tsx): orange-600 →
// rose-500 hero gradient, amber-500 accent, warm cream surfaces.
type RGB = readonly [number, number, number];
const C_ORANGE: RGB = [0.918, 0.345, 0.047]; // #EA580C  orange-600
const C_ORANGE_500: RGB = [0.976, 0.451, 0.086]; // #F97316  orange-500
const C_ROSE: RGB = [0.957, 0.247, 0.369]; // #F43F5E  rose-500
const C_AMBER: RGB = [0.961, 0.62, 0.043]; // #F59E0B  amber-500
const tup = (c: RGB) => rgb(c[0], c[1], c[2]);

const ORANGE = tup(C_ORANGE);
const ROSE = tup(C_ROSE);
const AMBER = tup(C_AMBER);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900  #18181B
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500  #71717A
const ROW_ALT = rgb(1, 0.969, 0.929); // orange-50  #FFF7ED  (warm zebra)
const BORDER = rgb(0.914, 0.871, 0.812); // warm hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (peso, smart punctuation) with safe equivalents,
// and anything else unencodable with '?'.
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

/** Draw a horizontal gradient bar by slicing into thin rectangles — pdf-lib has
 *  no native gradients, so this reproduces the dashboard's orange→rose accent. */
function drawHGradient(
  page: PDFPage,
  x: number,
  y: number,
  w: number,
  h: number,
  from: RGB,
  to: RGB,
  steps = 60,
): void {
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const r = from[0] + (to[0] - from[0]) * t;
    const g = from[1] + (to[1] - from[1]) * t;
    const b = from[2] + (to[2] - from[2]) * t;
    page.drawRectangle({
      x: x + i * sw,
      y,
      width: sw + 0.6, // tiny overlap so no seams show between slices
      height: h,
      color: rgb(r, g, b),
    });
  }
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

/** Build the CEO-themed PDF report. Returns the raw PDF bytes. */
export async function generateMesaPdf(
  spec: MesaExportSpec,
  generatedAt: Date,
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

  const year = generatedAt.getFullYear();
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
    right(`Exported ${formatTimestamp(generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 48;
    // Orange eyebrow → warm-branded, then the report title.
    state.page.drawText(sanitize(spec.eyebrow.toUpperCase()), { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ORANGE });
    state.y -= 18;
    state.page.drawText(sanitize(spec.title), { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 14;
    state.page.drawText(
      sanitize(`${spec.scopeLabel} · ${countLabel(spec)}`),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 9;
    // Signature orange→rose accent rule (the dashboard's hero hairline).
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_ORANGE_500, C_ROSE);
    state.y -= 18;
  }

  // ── At-a-glance metric band (amber-topped stat cards, like the hero tiles) ──
  if (spec.stats.length > 0) {
    const items = spec.stats;
    const gap = 12;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 46;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      // Amber top accent — the dashboard's gold highlight.
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: AMBER });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 10, y: state.y + boxH - 17, size: 7.5, font: bold, color: MUTED });
      // Long money values shrink a little to stay inside the card.
      const value = sanitize(item.value);
      let vSize = 18;
      while (vSize > 10 && bold.widthOfTextAtSize(value, vSize) > boxW - 20) vSize -= 1;
      state.page.drawText(value, { x: x + 10, y: state.y + 10, size: vSize, font: bold, color: ORANGE });
    });
    state.y -= 16;
  }

  // ── Data table (orange header, warm zebra; paginates with redrawn header) ──
  const BODY = 8.5;
  const LH = 11;
  const PAD_X = 6;
  const PAD_Y = 5;

  // '#' index column + spec columns, weights scaled to exactly fill CONTENT_W.
  const weighted = [{ header: '#', align: 'right' as const, pdfWeight: 24 }, ...spec.columns];
  const totalWeight = weighted.reduce((s, c) => s + c.pdfWeight, 0);
  const cols = weighted.map((c) => ({
    header: c.header,
    align: c.align ?? 'left',
    width: (c.pdfWeight / totalWeight) * CONTENT_W,
  }));
  const tableRows = spec.rows.map((r, i) => [String(i + 1), ...r]);

  const drawTable = () => {
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
    for (const row of tableRows) {
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

  if (spec.rows.length === 0) {
    ensure(20);
    state.page.drawText('No records match this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  } else {
    drawTable();
  }

  // ── Notes (e.g. the per-stint account caveat) ──────────────────────────────
  if (spec.notes && spec.notes.length > 0) {
    for (const note of spec.notes) {
      const lines = wrapText(`Note: ${note}`, font, 8, CONTENT_W);
      ensure(lines.length * 10 + 6);
      for (const line of lines) {
        state.page.drawText(line, { x: MARGIN, y: state.y - 8, size: 8, font, color: MUTED });
        state.y -= 10;
      }
      state.y -= 4;
    }
  }

  // ── Footers on every page ───────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p: PDFPage, i: number) => {
    // Thin gradient rule above the footer echoes the masthead accent.
    drawHGradient(p, MARGIN, 41, CONTENT_W, 1, C_ORANGE_500, C_ROSE, 40);
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

function baseName(spec: MesaExportSpec, d: Date): string {
  return `${spec.fileBase}-${dateSuffix(d)}`;
}

/** Build + download the CSV report. */
export function downloadMesaCsv(spec: MesaExportSpec): void {
  const now = new Date();
  downloadBlob(
    `${baseName(spec, now)}.csv`,
    new Blob([mesaExportToCsv(spec, now)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadMesaXlsx(spec: MesaExportSpec): void {
  const now = new Date();
  const wb = buildMesaWorkbook(spec, now);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(spec, now)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the CEO-themed PDF report. */
export async function downloadMesaPdf(spec: MesaExportSpec, opts?: { logoUrl?: string }): Promise<void> {
  const now = new Date();
  const bytes = await generateMesaPdf(spec, now, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(spec, now)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}

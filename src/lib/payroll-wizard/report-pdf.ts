// Payroll Wizard -- Salaries report PDF export.
//
// Turns the Reports step's salary snapshot into a branded, sectioned PDF built
// from scratch with pdf-lib so it deploys cleanly on Vercel (no template file
// read at runtime). Mirrors the Payment Catalog exporter's look: Simple navy +
// orange palette, logo masthead with "Pulled from Simple-HRIS System", navy
// table headers, alternating rows, and a per-page footer.
//
// Runs entirely in the browser (in-memory Blob download) -- the salary data is
// already loaded in the Reports step, so there's no server round-trip. The
// same Draft vs. Official logic the XLSX export uses is honoured here: a draft
// report carries a DRAFT watermark + banner and an "(Draft)" filename.

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFImage } from 'pdf-lib';
import type { PayrollExportRow } from './report-rows';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Row model shared with the XLSX export — built by report-rows.ts from the
 *  staged dispatch payload, so the PDF can never show a different split than
 *  the money that was actually staged. */
export type PayrollReportRow = PayrollExportRow;

export interface PayrollReportModel {
  isDraft: boolean;
  isReplay: boolean;
  startedAt: Date;
  dispatchedAt: Date;
  generatedAt: Date;
  usdToPhpRate: number;
  /** Human period label, e.g. "May 1–15, 2026" (optional). */
  periodLabel?: string | null;
  employees: PayrollReportRow[];
  totalPhp: number;
  totalUsd: number | null;
}

// ---------------------------------------------------------------------------
// Layout + palette (landscape US Letter for the wide salary table)
// ---------------------------------------------------------------------------

const PAGE_W = 792; // US Letter, landscape
const PAGE_H = 612;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 704
const BOTTOM = 56; // keep content clear of the footer

// Brand-ish palette pulled from the Simple logo (navy + orange).
const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);
const AMBER = rgb(0.72, 0.53, 0.04);

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// anything unencodable with '?' so a stray glyph can never crash generation.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    out += (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? ch : '?';
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
      if (i <= 1 && word.length) break; // never loop forever on a too-wide single char
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && !fits(candidate)) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
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

/** Full export timestamp, e.g. "June 16, 2026, 3:45 PM GMT+8" (viewer's local time). */
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

/** Two-decimal number with no currency prefix. */
function n2(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Signed two-decimal number, "+" for positive, "-" for negative, "-" for zero/nil. */
function n2Signed(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount === 0) return '-';
  return `${amount > 0 ? '+' : ''}${n2(amount)}`;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Build the branded Payroll Wizard salaries PDF. Returns the raw PDF bytes. */
export async function generatePayrollReportPdf(
  model: PayrollReportModel,
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

  const statusLabel = model.isDraft ? 'DRAFT' : 'OFFICIAL';

  // ── Masthead (page 1) ───────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: NAVY });
    }

    // Right-aligned provenance tagline.
    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    // Title + a status chip (DRAFT amber / OFFICIAL navy) right after it.
    const title = 'Payroll Wizard - Salaries / Wages Report';
    state.page.drawText(title, { x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY });
    {
      const chipColor = model.isDraft ? AMBER : NAVY;
      const chipText = statusLabel;
      const cw = bold.widthOfTextAtSize(chipText, 8) + 12;
      const cx = MARGIN + bold.widthOfTextAtSize(title, 16) + 12;
      state.page.drawRectangle({ x: cx, y: state.y - 2, width: cw, height: 16, color: chipColor });
      state.page.drawText(chipText, { x: cx + 6, y: state.y + 2, size: 8, font: bold, color: WHITE });
    }
    state.y -= 15;
    const subtitle = model.isDraft
      ? (model.isReplay
          ? 'Past period, never dispatched - numbers reconstructed from this period\'s saved state.'
          : 'Draft preview - numbers reflect the current wizard state and have not been dispatched.')
      : (model.isReplay
          ? 'Replay of a dispatched period - salaries from the dispatched snapshot.'
          : `Dispatched ${formatTimestamp(model.dispatchedAt)}.`);
    state.page.drawText(sanitize(subtitle), { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
    state.y -= 10;
    state.page.drawLine({
      start: { x: MARGIN, y: state.y }, end: { x: PAGE_W - MARGIN, y: state.y },
      thickness: 1.3, color: NAVY,
    });
    state.y -= 18;
  }

  // ── Summary line (period / started / total outflow) ──────────────────────
  {
    const pieces: string[] = [];
    if (model.periodLabel) pieces.push(`Period: ${model.periodLabel}`);
    pieces.push(`Started: ${formatTimestamp(model.startedAt)}`);
    pieces.push(`Employees: ${model.employees.length}`);
    if (model.usdToPhpRate > 0) pieces.push(`FX: 1 USD = ${n2(model.usdToPhpRate)} PHP`);
    for (const ln of wrapText(pieces.join('     '), font, 8.5, CONTENT_W)) {
      ensure(12);
      state.page.drawText(ln, { x: MARGIN, y: state.y - 9, size: 8.5, font, color: MUTED });
      state.y -= 12;
    }

    const outflowLabel = model.isDraft ? 'Projected Outflow' : 'Total Outflow';
    const usdSuffix = model.totalUsd != null ? `   (USD ${n2(model.totalUsd)})` : '';
    const outflow = `${outflowLabel}: PHP ${n2(model.totalPhp)}${usdSuffix}`;
    ensure(16);
    state.page.drawText(sanitize(outflow), { x: MARGIN, y: state.y - 11, size: 11, font: bold, color: NAVY });
    state.y -= 22;
  }

  // ── Table renderer (wraps every cell; paginates with a redrawn header) ────
  const BODY = 8.5;
  const LH = 11;
  const PAD_X = 6;
  const PAD_Y = 5;

  const drawTable = (columns: Col[], rows: string[][], footer?: string[]) => {
    const headerH = LH + PAD_Y * 2;

    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
      let x = MARGIN;
      for (const c of columns) {
        const lines = wrapText(c.header, bold, BODY, c.width - PAD_X * 2);
        const tw = bold.widthOfTextAtSize(lines[0], BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(lines[0], { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };

    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();

    let alt = false;
    for (const row of rows) {
      const cellLines = columns.map((c, i) => wrapText(row[i] ?? '', font, BODY, c.width - PAD_X * 2));
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
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        const lines = cellLines[i];
        for (let li = 0; li < lines.length; li++) {
          const tw = font.widthOfTextAtSize(lines[li], BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: TEXT });
        }
        x += c.width;
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH }, end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5, color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    }

    if (footer) {
      const rowH = LH + PAD_Y * 2;
      if (state.y - rowH < BOTTOM) { newPage(); drawHeader(); }
      state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: rgb(0.93, 0.93, 0.96) });
      let x = MARGIN;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        const txt = footer[i] ?? '';
        if (txt) {
          const tw = bold.widthOfTextAtSize(sanitize(txt), BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(sanitize(txt), { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: NAVY });
        }
        x += c.width;
      }
      state.y -= rowH;
    }
    state.y -= 8;
  };

  // ── Salaries table ────────────────────────────────────────────────────────
  {
    // Orange section tab.
    ensure(24);
    state.page.drawRectangle({ x: MARGIN, y: state.y - 9, width: 4, height: 10, color: ORANGE });
    state.page.drawText('SALARIES / WAGES', { x: MARGIN + 10, y: state.y - 8, size: 9.5, font: bold, color: NAVY });
    state.y -= 17;

    // Fully reconcilable: Initial + Bonuses + Adj. + Orphanage + MESA = Net.
    // (The XLSX carries the finer PAB/Tech/Other split of the Bonuses column.)
    const cols: Col[] = [
      { header: 'Employee', width: 150 },
      { header: 'Department', width: 66 },
      { header: 'Hours', width: 36, align: 'right' },
      { header: 'Regular', width: 52, align: 'right' },
      { header: 'OT', width: 46, align: 'right' },
      { header: 'Initial', width: 54, align: 'right' },
      { header: 'Bonuses', width: 52, align: 'right' },
      { header: 'Adj.', width: 48, align: 'right' },
      { header: 'Orphanage', width: 48, align: 'right' },
      { header: 'MESA', width: 48, align: 'right' },
      { header: 'Net (PHP)', width: 58, align: 'right' },
      { header: 'Net (USD)', width: 46, align: 'right' },
    ];

    const rows = model.employees.map((e) => [
      e.email ? `${e.name}\n${e.email}` : e.name,
      e.department || '-',
      Number.isFinite(e.hours) ? e.hours.toFixed(2) : '-',
      n2(e.regular),
      n2(e.ot),
      n2(e.initial),
      // Earned bonuses (PAB + Tech + Other) are never negative; the signed
      // Accounting Adj. has its own column — never gate a signed value on > 0.
      e.bonusesEarned > 0 ? `+${n2(e.bonusesEarned)}` : '-',
      n2Signed(e.adjustment),
      e.orphanage > 0 ? `+${n2(e.orphanage)}` : '-',
      n2Signed(e.mesaNet),
      n2(e.netPhp),
      e.netUsd != null ? n2(e.netUsd) : '-',
    ]);

    const footer = [
      `Total (${model.employees.length})`, '', '', '', '', '', '', '', '', '',
      n2(model.totalPhp),
      model.totalUsd != null ? n2(model.totalUsd) : '-',
    ];

    drawTable(cols, rows, footer);
  }

  if (model.employees.length === 0) {
    ensure(20);
    state.page.drawText('No employees in this payroll run.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  }

  // ── Draft watermark on every page ─────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  if (model.isDraft) {
    const wm = 'DRAFT';
    const size = 120;
    const wmFont = bold;
    const tw = wmFont.widthOfTextAtSize(wm, size);
    for (const p of pages) {
      // Rotate about the page centre; offset so the rotated text sits centred.
      p.drawText(wm, {
        x: PAGE_W / 2 - (tw / 2) * Math.cos(Math.PI / 9) - (size / 2) * Math.sin(Math.PI / 9),
        y: PAGE_H / 2 - (tw / 2) * Math.sin(Math.PI / 9) + (size / 2) * Math.cos(Math.PI / 9) - size,
        size,
        font: wmFont,
        color: AMBER,
        opacity: 0.08,
        rotate: degrees(20),
      });
    }
  }

  // ── Footers on every page ─────────────────────────────────────────────────
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}  ${String.fromCharCode(0xb7)}  ${statusLabel} report`;
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
// Browser download helper
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

/** Build + download the branded Payroll Wizard salaries PDF. */
export async function downloadPayrollReportPdf(
  model: PayrollReportModel,
  filename: string,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generatePayrollReportPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer (not a
  // possibly-shared view) -- keeps TS + every browser happy.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(filename, new Blob([ab], { type: 'application/pdf' }));
}

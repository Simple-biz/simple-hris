import 'server-only';

// Server-side renderer for Penny AI downloadable reports. Deliberately mirrors
// the Payment Catalog "Export PDF" look (src/lib/payment-catalog/catalog-export.ts):
// the Simple navy/orange brand palette, a logo masthead with the
// "Pulled from Simple-HRIS System" provenance block, navy table headers with
// white text + alternating rows, orange section-label bullets, and the shared
// "Developed by AI/API Team / Simple.biz" page footer. Built from scratch with
// pdf-lib so it deploys cleanly on Vercel (no template file read at runtime; the
// only optional asset is the logo, fetched by absolute URL with a text fallback).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import type { BizReport, ReportAlign, ReportSection } from '@/lib/ceo/biz-report';

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

// Brand palette pulled from the Simple logo (navy + orange) — identical to the
// Payment Catalog export so the two reports read as one family.
const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);

const BODY = 9;
const LH = 11.5;
const PAD_X = 6;
const PAD_Y = 5;

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols Penny tends to emit (peso, smart punctuation) with safe
// equivalents, and anything else unencodable with '?'.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '…') out += '...';
    else if (ch === '₱') out += 'PHP ';
    else out += '?';
  }
  return out;
}

/** Wrap text to a width, hard-breaking tokens that are themselves too long. */
function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitize(raw);
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
    let line = '';
    for (let word of trimmed.split(/\s+/)) {
      while (!fits(word)) {
        let i = word.length;
        while (i > 1 && !fits(word.slice(0, i))) i--;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, i));
        word = word.slice(i);
        if (i <= 1 && word.length) break;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && !fits(candidate)) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
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

/** Read the logo straight off disk (public/simple-logo.png). A robust fallback
 *  for when the URL fetch isn't available, so the masthead logo is ALWAYS shown. */
async function loadLogoFromDisk(): Promise<Uint8Array | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'simple-logo.png')));
  } catch {
    return null;
  }
}

/** Decoded image bytes for an employee avatar, ready to embed. */
export interface AvatarImage {
  bytes: Uint8Array;
  format: 'png' | 'jpg';
}

export interface BizReportPdfInput {
  report: BizReport;
  /** Human-readable generated timestamp (e.g. "June 23, 2026, 3:14 PM"). */
  generatedAt?: string;
  /** Calendar year for the footer/provenance line. */
  year?: number;
  /** Optional "Prepared for" attribution (e.g. the requester's email). */
  preparedFor?: string;
  /** Absolute URL to the Simple logo PNG (falls back to a wordmark if absent). */
  logoUrl?: string;
  /**
   * Resolves an employee's uploaded profile photo from their email, for roster
   * sections. The caller owns trust/allowlisting (the model never supplies image
   * URLs); returns null when there's no photo or it can't be fetched.
   */
  resolveAvatar?: (email: string) => Promise<AvatarImage | null>;
}

type Col = { header: string; width: number; align: ReportAlign };

export async function generateBizReportPdf(input: BizReportPdfInput): Promise<Uint8Array> {
  const { report } = input;
  const year = input.year ?? 0;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  {
    // Prefer fetching the asset by URL (mirrors the Payment Catalog export);
    // fall back to reading it off disk so the logo is ALWAYS present.
    let bytes: ArrayBuffer | Uint8Array | null = input.logoUrl
      ? await loadLogoBytes(input.logoUrl)
      : null;
    if (!bytes) bytes = await loadLogoFromDisk();
    if (bytes) {
      try {
        logo = await doc.embedPng(bytes);
      } catch {
        logo = null;
      }
    }
  }

  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };
  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };
  const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
    const s = sanitize(text);
    const w = f.widthOfTextAtSize(s, size);
    state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
  };

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

    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    if (input.generatedAt) right(`Generated ${input.generatedAt}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year || ''} Simple.biz`.trim(), top - 32, 8, font);
    if (input.preparedFor) right(`Prepared for ${input.preparedFor}`, top - 43, 8, font);

    state.y = top - (input.preparedFor ? 58 : 48);

    // Orange eyebrow brands it as a Penny AI report, then the report title.
    state.page.drawText('PENNY AI REPORT', { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ORANGE });
    state.y -= 16;
    for (const ln of wrapText(report.title, bold, 16, CONTENT_W)) {
      ensure(20);
      state.page.drawText(ln, { x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY });
      state.y -= 18;
    }
    if (report.subtitle) {
      for (const ln of wrapText(report.subtitle, font, 9, CONTENT_W)) {
        state.page.drawText(ln, { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
        state.y -= 11;
      }
    }
    state.y -= 4;
    state.page.drawLine({
      start: { x: MARGIN, y: state.y },
      end: { x: PAGE_W - MARGIN, y: state.y },
      thickness: 1.3,
      color: NAVY,
    });
    state.y -= 18;
  }

  // ── Section label (orange bullet + navy bold) ─────────────────────────────
  const sectionLabel = (text: string) => {
    ensure(24);
    state.page.drawRectangle({ x: MARGIN, y: state.y - 9, width: 4, height: 10, color: ORANGE });
    state.page.drawText(sanitize(text), { x: MARGIN + 10, y: state.y - 8, size: 9.5, font: bold, color: NAVY });
    state.y -= 17;
  };

  // ── Table renderer (wraps every cell; paginates with a redrawn header) ────
  const drawTable = (columns: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
      let x = MARGIN;
      for (const c of columns) {
        const txt = wrapText(c.header, bold, BODY, c.width - PAD_X * 2)[0];
        const tw = bold.widthOfTextAtSize(txt, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : c.align === 'center' ? x + (c.width - tw) / 2 : x + PAD_X;
        state.page.drawText(txt, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
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
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : c.align === 'center' ? x + (c.width - tw) / 2 : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: TEXT });
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

  /** Distribute CONTENT_W across columns by natural content width, capping any
   *  single column so one long column can't starve the rest (cells wrap). */
  const layoutColumns = (headers: string[], rows: string[][], aligns: ReportAlign[]): Col[] => {
    const natural = headers.map((h, ci) => {
      let w = bold.widthOfTextAtSize(sanitize(h), BODY);
      for (const r of rows) w = Math.max(w, font.widthOfTextAtSize(sanitize(r[ci] ?? ''), BODY));
      return w + PAD_X * 2 + 4;
    });
    const sum = natural.reduce((a, b) => a + b, 0) || 1;
    const cap = sum * 0.45;
    const capped = natural.map((w) => Math.min(w, cap));
    const sumCapped = capped.reduce((a, b) => a + b, 0) || 1;
    return headers.map((h, ci) => ({
      header: h,
      width: (capped[ci] / sumCapped) * CONTENT_W,
      align: aligns[ci] ?? 'left',
    }));
  };

  // ── Metric boxes (navy/orange stat cards, two per row) ────────────────────
  const drawMetrics = (items: { label: string; value: string }[]) => {
    const cols = 2;
    const gap = 12;
    const boxW = (CONTENT_W - gap * (cols - 1)) / cols;
    const boxH = 40;
    for (let i = 0; i < items.length; i += cols) {
      ensure(boxH + 8);
      state.y -= boxH;
      for (let c = 0; c < cols; c++) {
        const item = items[i + c];
        if (!item) continue;
        const x = MARGIN + c * (boxW + gap);
        state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
        state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: ORANGE });
        state.page.drawText(wrapText(item.label, font, 8, boxW - 14)[0], { x: x + 8, y: state.y + boxH - 16, size: 8, font, color: MUTED });
        state.page.drawText(wrapText(item.value, bold, 13, boxW - 14)[0], { x: x + 8, y: state.y + 9, size: 13, font: bold, color: NAVY });
      }
      state.y -= 8;
    }
    state.y -= 2;
  };

  const drawTextSection = (section: Extract<ReportSection, { type: 'text' }>) => {
    if (section.heading) sectionLabel(section.heading);
    for (const ln of wrapText(section.body, font, 10, CONTENT_W)) {
      ensure(13);
      state.y -= 13;
      state.page.drawText(ln, { x: MARGIN, y: state.y, size: 10, font, color: TEXT });
    }
    state.y -= 10;
  };

  // ── Pre-resolve + embed roster avatars (employee profile photos) ──────────
  // Done up front so row drawing stays synchronous; missing/failed photos fall
  // back to initials.
  const avatarByEmail = new Map<string, PDFImage>();
  if (input.resolveAvatar) {
    const emails = new Set<string>();
    for (const s of report.sections) {
      if (s.type === 'roster') for (const p of s.people) if (p.email) emails.add(p.email.toLowerCase());
    }
    for (const email of emails) {
      const img = await input.resolveAvatar(email);
      if (!img) continue;
      try {
        const embedded = img.format === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
        avatarByEmail.set(email, embedded);
      } catch {
        // unembeddable (e.g. progressive JPEG) — skip; row uses initials
      }
    }
  }

  const initialsOf = (name: string) =>
    sanitize(name)
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';

  const drawRoster = (section: Extract<ReportSection, { type: 'roster' }>) => {
    if (section.heading) sectionLabel(section.heading);
    const AV = 36; // avatar square
    const rowH = 46;
    const textX = MARGIN + 4 + AV + 12;
    const textW = CONTENT_W - (textX - MARGIN) - 6;
    let alt = false;
    for (const p of section.people) {
      ensure(rowH);
      state.y -= rowH;
      if (alt) {
        state.page.drawRectangle({ x: MARGIN, y: state.y, width: CONTENT_W, height: rowH, color: ROW_ALT });
      }
      const ax = MARGIN + 4;
      const ay = state.y + (rowH - AV) / 2;
      const img = p.email ? avatarByEmail.get(p.email.toLowerCase()) : undefined;
      if (img) {
        const scale = Math.min(AV / img.width, AV / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        state.page.drawImage(img, { x: ax + (AV - w) / 2, y: ay + (AV - h) / 2, width: w, height: h });
        state.page.drawRectangle({ x: ax, y: ay, width: AV, height: AV, borderColor: BORDER, borderWidth: 0.5 });
      } else {
        state.page.drawRectangle({ x: ax, y: ay, width: AV, height: AV, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
        const ini = initialsOf(p.name);
        const tw = bold.widthOfTextAtSize(ini, 13);
        state.page.drawText(ini, { x: ax + (AV - tw) / 2, y: ay + AV / 2 - 4.5, size: 13, font: bold, color: NAVY });
      }
      state.page.drawText(wrapText(p.name, bold, 11, textW)[0], { x: textX, y: state.y + rowH - 19, size: 11, font: bold, color: NAVY });
      if (p.detail) {
        state.page.drawText(wrapText(p.detail, font, 9, textW)[0], { x: textX, y: state.y + 10, size: 9, font, color: MUTED });
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y },
        end: { x: MARGIN + CONTENT_W, y: state.y },
        thickness: 0.5,
        color: BORDER,
      });
      alt = !alt;
    }
    state.y -= 10;
  };

  // ── Sections ──────────────────────────────────────────────────────────────
  for (const section of report.sections) {
    if (section.type === 'text') {
      drawTextSection(section);
    } else if (section.type === 'metrics') {
      if (section.heading) sectionLabel(section.heading);
      drawMetrics(section.items);
    } else if (section.type === 'table') {
      if (section.heading) sectionLabel(section.heading);
      const aligns = section.columns.map((_, i) => section.aligns?.[i] ?? 'left');
      drawTable(layoutColumns(section.columns, section.rows, aligns), section.rows);
    } else if (section.type === 'roster') {
      drawRoster(section);
    }
  }

  // ── Footers on every page (shared with the Payment Catalog export) ─────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText =
    `Generated by Penny AI ${String.fromCharCode(0xb7)} Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year || ''}`.trim();
  pages.forEach((p: PDFPage, i: number) => {
    p.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: BORDER });
    p.drawText(sanitize(footerText), { x: MARGIN, y: 28, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 28, size: 8, font, color: MUTED });
  });

  return doc.save();
}

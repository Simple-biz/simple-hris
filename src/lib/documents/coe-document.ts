// Certificate of Engagement — the PDF itself.
//
// Unlike every other document type in this flow, a COE is not supplied by the
// worker: the HRIS writes it. So this module owns the layout, which means the
// signature can be drawn INTO the document's own signature block (the template
// ends with one) instead of only onto an appended certification page.
//
// Two states, one layout:
//   • DRAFT (status `pending`) — signature slot carries a red UNSIGNED box and
//     the page carries a diagonal watermark. The employee can download the
//     draft, so it must be impossible to pass off as the real thing.
//   • SIGNED — the approver's drawn signature, printed name, title, email and
//     the signing date fill that slot; no watermark. requests.ts then appends
//     the shared certification page (Reference ID + requested/signed dates).
//
// DESIGN
// This is a document a worker hands to a bank, a landlord or an embassy, so it
// is typeset as formal correspondence rather than decorated as a certificate:
// restrained palette (the app's navy + one orange accent), hairline rules for
// structure, a tracked-caps document title, real inline emphasis on the figures
// a reader is looking for, and dot leaders on the bonus schedule. No borders as
// ornament, no gradients, no seals.
//
// Wording follows the approved template verbatim, with one deliberate change:
// the template's closing line said "collaboration with _Employee Name_" while
// the rest said "_Worker Name_" — the worker's name is used throughout.

import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { embedPdfFonts, type PdfFontSet } from '@/lib/pdf/fonts';
import type { CoeFacts } from './coe-facts';

type Color = ReturnType<typeof rgb>;

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const FAINT = rgb(0.58, 0.58, 0.64);
const BORDER = rgb(0.86, 0.86, 0.9);
const HAIRLINE = rgb(0.9, 0.9, 0.93);
const ROSE = rgb(0.75, 0.11, 0.24);
const ROSE_TINT = rgb(0.99, 0.95, 0.96);
const WATERMARK = rgb(0.93, 0.93, 0.95);

const PAGE_W = 612; // US Letter portrait, matching the pay-stub export
const PAGE_H = 792;
const MARGIN = 64;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN + 14; // footer rule sits at MARGIN-16, text at MARGIN-28

const BODY_SIZE = 10.5;
const BODY_LEADING = 16.5;

export interface CoeRenderParams {
  facts: CoeFacts;
  /** Request id — printed in the footer so page 1 alone is verifiable. */
  requestId: string;
  /** When the certificate was generated (ISO). The draft shows this; the signed
   *  copy shows the signing date in the signature block. */
  generatedAtIso: string;
  /** Present only when signing. Absent ⇒ watermarked draft. */
  signature?: {
    /** PNG/JPEG data URL from the signature pad. */
    dataUrl: string;
    name: string;
    title: string;
    email: string;
    signedAtIso: string;
  };
}

/** "07.31.2026" — the template's signature-block date format. */
function formatDotDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}.${get('day')}.${get('year')}`;
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    return { bytes: new Uint8Array(Buffer.from(m[2], 'base64')), mime: m[1].toLowerCase() };
  } catch {
    return null;
  }
}

/** Greedy word-wrap honouring the font's real metrics. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(probe, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A run of body copy; `bold` lifts the figures a reader scans for. */
export interface Span {
  text: string;
  bold?: boolean;
  color?: Color;
}

interface Word {
  text: string;
  font: PDFFont;
  color: Color;
  width: number;
  space: boolean;
}

/** pdf-lib has no letter-spacing, so tracked text is measured by hand. */
function trackedWidth(text: string, font: PDFFont, size: number, tracking: number): number {
  if (!text) return 0;
  return font.widthOfTextAtSize(text, size) + tracking * (text.length - 1);
}

/**
 * Render the Certificate of Engagement. Returns a one-page PDF for realistic
 * inputs; the wrap and space checks paginate rather than overflow.
 */
export async function renderCoeDocument(params: CoeRenderParams): Promise<Uint8Array> {
  const { facts, requestId, generatedAtIso, signature } = params;

  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of Engagement — ${facts.workerName}`);
  doc.setAuthor('Simple');
  doc.setSubject('Certificate of Engagement');
  doc.setCreator('Simple HRIS');
  doc.setProducer('Simple HRIS');

  const fonts = await embedPdfFonts(doc);
  const { regular, bold, sanitize } = fonts;

  let sigImage: PDFImage | null = null;
  if (signature) {
    const parsed = dataUrlToBytes(signature.dataUrl);
    if (!parsed) throw new Error('Saved signature is not a valid data URL');
    try {
      sigImage =
        parsed.mime.includes('jpeg') || parsed.mime.includes('jpg')
          ? await doc.embedJpg(parsed.bytes)
          : await doc.embedPng(parsed.bytes);
    } catch {
      throw new Error('Saved signature image could not be embedded (redraw and save it again)');
    }
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  /** Start a fresh page when the next block would cross the footer zone. */
  const ensureSpace = (needed: number) => {
    if (y - needed >= BOTTOM_LIMIT) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  const text = (
    raw: string,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: Color;
      x?: number;
      align?: 'left' | 'center' | 'right';
    } = {},
  ) => {
    const f = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const s = sanitize(raw);
    const w = f.widthOfTextAtSize(s, size);
    const x =
      opts.align === 'center'
        ? (PAGE_W - w) / 2
        : opts.align === 'right'
          ? PAGE_W - MARGIN - w
          : (opts.x ?? MARGIN);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? TEXT });
  };

  /** Letter-spaced text, drawn glyph by glyph. Used only for the document title
   *  and the small section labels — formal-document typography, not decoration. */
  const tracked = (
    raw: string,
    opts: { size: number; font: PDFFont; color: Color; tracking: number; align?: 'left' | 'center' },
  ) => {
    const s = sanitize(raw);
    const total = trackedWidth(s, opts.font, opts.size, opts.tracking);
    let x = opts.align === 'center' ? (PAGE_W - total) / 2 : MARGIN;
    for (const ch of s) {
      page.drawText(ch, { x, y, size: opts.size, font: opts.font, color: opts.color });
      x += opts.font.widthOfTextAtSize(ch, opts.size) + opts.tracking;
    }
  };

  const rule = (opts: { width?: number; x?: number; thickness?: number; color?: Color; center?: boolean } = {}) => {
    const w = opts.width ?? CONTENT_W;
    const x = opts.center ? (PAGE_W - w) / 2 : (opts.x ?? MARGIN);
    page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: opts.thickness ?? 0.6,
      color: opts.color ?? HAIRLINE,
    });
  };

  /**
   * Wrapped body copy with inline emphasis. The figures a bank looks for (rate,
   * start date, team) are bold inside otherwise plain prose, which needs
   * per-word measurement rather than per-line.
   */
  const richParagraph = (
    spans: Span[],
    opts: { size?: number; leading?: number; color?: Color; indent?: number } = {},
  ) => {
    const size = opts.size ?? BODY_SIZE;
    const leading = opts.leading ?? BODY_LEADING;
    const indent = opts.indent ?? 0;
    const maxW = CONTENT_W - indent;
    const base = opts.color ?? TEXT;

    const words: Word[] = [];
    for (const span of spans) {
      const font = span.bold ? bold : regular;
      const color = span.color ?? base;
      // Split keeping the whitespace so a span boundary can't glue two words.
      for (const piece of sanitize(span.text).split(/(\s+)/)) {
        if (!piece) continue;
        words.push({
          text: piece,
          font,
          color,
          width: font.widthOfTextAtSize(piece, size),
          space: /^\s+$/.test(piece),
        });
      }
    }

    let line: Word[] = [];
    let lineW = 0;
    const flush = () => {
      // Trailing spaces must not affect anything; drop them before drawing.
      while (line.length && line[line.length - 1].space) line.pop();
      if (line.length) {
        ensureSpace(leading);
        let x = MARGIN + indent;
        for (const w of line) {
          if (!w.space) page.drawText(w.text, { x, y, size, font: w.font, color: w.color });
          x += w.width;
        }
        y -= leading;
      }
      line = [];
      lineW = 0;
    };

    for (const w of words) {
      if (w.space && line.length === 0) continue; // no leading space on a new line
      if (!w.space && lineW + w.width > maxW && line.length) flush();
      line.push(w);
      lineW += w.width;
    }
    flush();
  };

  /** Small navy label that opens a block. Not an eyebrow on every section —
   *  the document has exactly one. */
  const sectionLabel = (raw: string) => {
    ensureSpace(14);
    tracked(raw.toUpperCase(), { size: 7.5, font: bold, color: NAVY, tracking: 1.1 });
    y -= 6;
    rule({ width: 26, thickness: 1.4, color: ORANGE });
    y -= 14;
  };

  /**
   * A schedule row: label on the left, amount hard right, dot leader between.
   * Standard in formal financial correspondence and far easier to read than a
   * comma-run of "Label: amount" pairs.
   */
  const leaderRow = (label: string, amount: string | null, qualifier?: string) => {
    ensureSpace(qualifier ? 26 : 15);
    const size = 10.5;
    const labelS = sanitize(label);
    const amountS = amount ? sanitize(amount) : '';
    const labelW = regular.widthOfTextAtSize(labelS, size);
    const amountW = amountS ? bold.widthOfTextAtSize(amountS, size) : 0;

    page.drawText(labelS, { x: MARGIN, y, size, font: regular, color: TEXT });
    if (amountS) {
      page.drawText(amountS, { x: PAGE_W - MARGIN - amountW, y, size, font: bold, color: NAVY });
    }

    // Dots fill the gap, inset from both sides so they never touch the text.
    const gapStart = MARGIN + labelW + 6;
    const gapEnd = PAGE_W - MARGIN - amountW - 6;
    const dot = sanitize('·');
    const dotW = regular.widthOfTextAtSize(dot, size);
    if (gapEnd - gapStart > dotW * 2) {
      const step = dotW * 2.1;
      for (let x = gapStart; x <= gapEnd - dotW; x += step) {
        page.drawText(dot, { x, y, size, font: regular, color: FAINT });
      }
    }
    y -= 13;

    if (qualifier) {
      ensureSpace(12);
      page.drawText(sanitize(qualifier), { x: MARGIN, y, size: 8.5, font: regular, color: MUTED });
      y -= 13;
    }
  };

  // ── Letterhead ────────────────────────────────────────────────────────────
  y -= 14;
  text('Simple', { size: 21, font: bold, color: NAVY });
  text('Pulled from Simple-HRIS System', { size: 8.5, font: bold, color: NAVY, align: 'right' });
  y -= 12;
  text('Payroll Department  ·  payroll@simple.biz', { size: 8, color: MUTED, align: 'right' });
  y -= 14;
  rule({ thickness: 1.2, color: NAVY });
  y -= 2.6;
  rule({ width: 58, thickness: 2.4, color: ORANGE });
  y -= 40;

  // ── Document title ────────────────────────────────────────────────────────
  tracked('Certificate of Engagement', {
    size: 15,
    font: bold,
    color: NAVY,
    tracking: 1.9,
    align: 'center',
  });
  y -= 14;
  rule({ width: 44, thickness: 1.6, color: ORANGE, center: true });
  y -= 26;

  // ── Who it is about ───────────────────────────────────────────────────────
  text(facts.workerName, { size: 16.5, font: bold, color: TEXT, align: 'center' });
  y -= 15;
  {
    const meta = [
      facts.employeeId ? `Employee ID ${facts.employeeId}` : null,
      facts.team,
      facts.employeeEmail,
    ]
      .filter(Boolean)
      .join('   ·   ');
    text(meta, { size: 8.5, color: MUTED, align: 'center' });
  }
  y -= 19;
  rule();
  y -= 21;

  // ── Body ──────────────────────────────────────────────────────────────────
  richParagraph([
    { text: 'This is to certify that ' },
    { text: facts.workerName, bold: true },
    { text: ' has been contracted with Simple since ' },
    { text: facts.startDateLabel, bold: true },
    { text: ' as part of our ' },
    { text: facts.team, bold: true },
    { text: '. Their work schedule consists of ' },
    { text: `${facts.weeklyHours} hours per week`, bold: true },
    { text: ', with an hourly rate of ' },
    { text: facts.hourlyRate, bold: true, color: NAVY },
    { text: ' and an overtime rate of ' },
    { text: facts.overtimeRate, bold: true, color: NAVY },
    { text: ' per hour.' },
  ]);
  y -= 15;

  sectionLabel('Additional bonuses for workers who qualify');
  for (const b of facts.standardBonuses) {
    leaderRow(b.label, b.amount, b.qualifier);
  }
  if (facts.performanceBonuses.length > 0) {
    for (const b of facts.performanceBonuses) {
      leaderRow(b.label, b.amount ?? 'Performance-based');
    }
  } else {
    leaderRow('Performance Bonuses', 'None assigned at this time');
  }
  y -= 15;

  richParagraph([
    { text: 'Please note that ' },
    { text: facts.workerName, bold: true },
    {
      text:
        ' is not an employee but a contractor, meaning their engagement with us is on a ' +
        'contractual basis. Our working relationship is in good standing, and we look forward to ' +
        'continuing our collaboration with ',
    },
    { text: facts.workerName, bold: true },
    { text: '.' },
  ]);
  y -= 13;

  richParagraph(
    [
      {
        text:
          'In accordance with company privacy and security policies, personal identification ' +
          'numbers, including government-issued and tax identification numbers, are not disclosed ' +
          'on Certificates of Engagement. This measure safeguards sensitive information and ' +
          'supports compliance with applicable data protection requirements.',
      },
    ],
    { size: 9, leading: 13.5, color: MUTED },
  );
  y -= 22;

  // ── Signature block ───────────────────────────────────────────────────────
  ensureSpace(signature ? 126 : 92);
  text('Signed,', { size: BODY_SIZE, color: TEXT });
  y -= 10;

  if (signature && sigImage) {
    const maxW = Math.min(196, CONTENT_W * 0.44);
    const maxH = 46;
    const scale = Math.min(maxW / sigImage.width, maxH / sigImage.height, 1);
    const w = sigImage.width * scale;
    const h = sigImage.height * scale;
    y -= h;
    page.drawImage(sigImage, { x: MARGIN, y, width: w, height: h });
    y -= 9;
    rule({ width: 214, thickness: 0.8, color: BORDER });
    y -= 14;
    text(signature.name, { size: 11.5, font: bold, color: TEXT });
    y -= 13;
    text(signature.title, { size: 9.5, color: TEXT });
    y -= 12;
    text(signature.email, { size: 9, color: MUTED });
    y -= 14;
    text(formatDotDate(signature.signedAtIso), { size: 9, font: bold, color: NAVY });
    y -= 16;
  } else {
    const boxW = Math.min(316, CONTENT_W);
    const boxH = 58;
    y -= boxH;
    page.drawRectangle({
      x: MARGIN,
      y,
      width: boxW,
      height: boxH,
      color: ROSE_TINT,
      borderColor: ROSE,
      borderWidth: 1,
    });
    page.drawText(sanitize('UNSIGNED'), {
      x: MARGIN + 14,
      y: y + boxH - 22,
      size: 12,
      font: bold,
      color: ROSE,
    });
    page.drawText(sanitize('Pending Accounting approval — not yet valid.'), {
      x: MARGIN + 14,
      y: y + boxH - 37,
      size: 8.5,
      font: regular,
      color: ROSE,
    });
    page.drawText(sanitize(`Generated ${formatDotDate(generatedAtIso)} by Simple HRIS`), {
      x: MARGIN + 14,
      y: y + boxH - 50,
      size: 8,
      font: regular,
      color: MUTED,
    });
    y -= 16;
  }

  // ── Footer on every page: Reference ID so page 1 stands alone ─────────────
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN - 16 },
      end: { x: PAGE_W - MARGIN, y: MARGIN - 16 },
      thickness: 0.6,
      color: HAIRLINE,
    });
    const left = sanitize(`Reference ID ${requestId}  ·  Verify with Simple Accounting`);
    p.drawText(left, { x: MARGIN, y: MARGIN - 28, size: 7, font: regular, color: MUTED });
    const right = sanitize(
      pages.length > 1
        ? `Confidential — Simple.biz  ·  Page ${i + 1} of ${pages.length}`
        : 'Confidential — Simple.biz',
    );
    p.drawText(right, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(right, 7),
      y: MARGIN - 28,
      size: 7,
      font: regular,
      color: MUTED,
    });
  });

  // Diagonal watermark, drawn last so it sits over the text but stays pale
  // enough to read through. Only ever on the unsigned copy.
  if (!signature) {
    for (const p of pages) drawWatermark(p, bold, sanitize('UNSIGNED DRAFT'));
  }

  return doc.save();
}

/** Big pale diagonal stamp across the page. */
function drawWatermark(page: PDFPage, font: PDFFont, text: string): void {
  const size = 52;
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (PAGE_W - w * 0.72) / 2,
    y: PAGE_H * 0.4,
    size,
    font,
    color: WATERMARK,
    rotate: degrees(32),
    opacity: 0.9,
  });
}

/** Exported for tests — the pieces that don't need a PDFDocument. */
export const __coeInternals = { formatDotDate, wrapText, trackedWidth };
export type { PdfFontSet };

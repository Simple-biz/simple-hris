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
// Wording follows the approved template verbatim, with one deliberate change:
// the template's closing line said "collaboration with _Employee Name_" while
// the rest said "_Worker Name_" — the worker's name is used throughout.

import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { embedPdfFonts, type PdfFontSet } from '@/lib/pdf/fonts';
import type { CoeFacts } from './coe-facts';

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const BORDER = rgb(0.86, 0.86, 0.9);
const ROSE = rgb(0.75, 0.11, 0.24);
const ROSE_TINT = rgb(0.99, 0.95, 0.96);
const WATERMARK = rgb(0.93, 0.93, 0.95);

const PAGE_W = 612; // US Letter portrait, matching the pay-stub export
const PAGE_H = 792;
const MARGIN = 64;
const CONTENT_W = PAGE_W - MARGIN * 2;

const BODY_SIZE = 10.5;
const BODY_LEADING = 16.5;

export interface CoeRenderParams {
  facts: CoeFacts;
  /** Request id — printed in the footer so page 1 alone is verifiable. */
  requestId: string;
  /** When the certificate was generated (ISO). Printed as the "Signed," date
   *  once signed; the draft shows the generation date instead. */
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

/**
 * Render the Certificate of Engagement. Returns a single-page PDF (two pages if
 * the body overflows, which the wrap accounts for).
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

  /** Start a fresh page when the next block would cross the bottom margin. */
  const ensureSpace = (needed: number) => {
    if (y - needed >= MARGIN + 24) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  const drawLineOfText = (
    raw: string,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      x?: number;
      rightAlign?: boolean;
    } = {},
  ) => {
    const f = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const s = sanitize(raw);
    const x = opts.rightAlign ? PAGE_W - MARGIN - f.widthOfTextAtSize(s, size) : (opts.x ?? MARGIN);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? TEXT });
  };

  /** Draw a wrapped paragraph, advancing y. Handles page breaks mid-paragraph. */
  const paragraph = (
    text: string,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; leading?: number; indent?: number } = {},
  ) => {
    const f = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const leading = opts.leading ?? BODY_LEADING;
    const indent = opts.indent ?? 0;
    const lines = wrapText(sanitize(text), f, size, CONTENT_W - indent);
    for (const line of lines) {
      ensureSpace(leading);
      page.drawText(line, {
        x: MARGIN + indent,
        y,
        size,
        font: f,
        color: opts.color ?? TEXT,
      });
      y -= leading;
    }
  };

  // ── Letterhead ────────────────────────────────────────────────────────────
  y -= 14;
  drawLineOfText('Simple', { size: 22, font: bold, color: NAVY });
  drawLineOfText('Pulled from Simple-HRIS System', {
    size: 9,
    font: bold,
    color: NAVY,
    rightAlign: true,
  });
  y -= 13;
  drawLineOfText('payroll@simple.biz', { size: 8.5, color: MUTED, rightAlign: true });
  y -= 16;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1.4,
    color: NAVY,
  });
  y -= 3;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + 64, y },
    thickness: 3,
    color: ORANGE,
  });
  y -= 46;

  // ── Title ─────────────────────────────────────────────────────────────────
  {
    const title = 'Certificate of Engagement';
    const size = 19;
    const w = bold.widthOfTextAtSize(sanitize(title), size);
    page.drawText(sanitize(title), {
      x: (PAGE_W - w) / 2,
      y,
      size,
      font: bold,
      color: NAVY,
    });
    y -= 20;
    // Worker identity line, centred under the title.
    const idBits = [facts.workerName, facts.employeeId ? `Employee ID ${facts.employeeId}` : null]
      .filter(Boolean)
      .join('  ·  ');
    const idW = regular.widthOfTextAtSize(sanitize(idBits), 9.5);
    page.drawText(sanitize(idBits), {
      x: (PAGE_W - idW) / 2,
      y,
      size: 9.5,
      font: regular,
      color: MUTED,
    });
    y -= 36;
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  paragraph(
    `This is to certify that ${facts.workerName} has been contracted with Simple since ` +
      `${facts.startDateLabel} as part of our ${facts.team}. Their work schedule consists of ` +
      `${facts.weeklyHours} hours per week, with an hourly rate of ${facts.hourlyRate} and an ` +
      `overtime rate of ${facts.overtimeRate} per hour.`,
  );
  y -= 10;

  paragraph('Below are the additional bonuses available to our workers who qualify:');
  y -= 8;

  // Standard (Attendance / Technology) then performance bonuses, as bullets.
  const bulletLines: string[] = [
    ...facts.standardBonuses.map(
      (b) => `${b.label}: ${b.amount}${b.qualifier ? ` (${b.qualifier})` : ''}`,
    ),
    facts.performanceBonuses.length > 0
      ? `Performance Bonuses: ${facts.performanceBonuses
          .map((b) => (b.amount ? `${b.label} (${b.amount})` : b.label))
          .join(', ')}`
      : 'Performance Bonuses: none assigned at this time.',
  ];
  for (const line of bulletLines) {
    ensureSpace(BODY_LEADING);
    page.drawText(sanitize('•'), { x: MARGIN + 6, y, size: BODY_SIZE, font: regular, color: ORANGE });
    const wrapped = wrapText(sanitize(line), regular, BODY_SIZE, CONTENT_W - 22);
    let first = true;
    for (const w of wrapped) {
      if (!first) ensureSpace(BODY_LEADING);
      page.drawText(w, { x: MARGIN + 22, y, size: BODY_SIZE, font: regular, color: TEXT });
      y -= BODY_LEADING;
      first = false;
    }
    y -= 3;
  }
  y -= 8;

  paragraph(
    `Please note that ${facts.workerName} is not an employee but a contractor, meaning their ` +
      'engagement with us is on a contractual basis. Our working relationship is in good standing, ' +
      `and we look forward to continuing our collaboration with ${facts.workerName}.`,
  );
  y -= 10;

  paragraph(
    'In accordance with company privacy and security policies, personal identification numbers — ' +
      'including government-issued and tax identification numbers — are not disclosed on ' +
      'Certificates of Engagement. This measure safeguards sensitive information and supports ' +
      'compliance with applicable data protection requirements.',
    { color: MUTED, size: 9.5, leading: 14.5 },
  );
  y -= 26;

  // ── Signature block ───────────────────────────────────────────────────────
  ensureSpace(150);
  drawLineOfText('Signed,', { size: BODY_SIZE });
  y -= 12;

  if (signature && sigImage) {
    const maxW = Math.min(200, CONTENT_W * 0.45);
    const maxH = 54;
    const scale = Math.min(maxW / sigImage.width, maxH / sigImage.height, 1);
    const w = sigImage.width * scale;
    const h = sigImage.height * scale;
    y -= h + 2;
    page.drawImage(sigImage, { x: MARGIN, y, width: w, height: h });
    y -= 10;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + 220, y },
      thickness: 0.8,
      color: TEXT,
    });
    y -= 15;
    drawLineOfText(signature.name, { size: 11, font: bold });
    y -= 13;
    drawLineOfText(signature.email, { size: 9.5, color: MUTED });
    y -= 12;
    drawLineOfText(signature.title, { size: 9.5, color: MUTED });
    y -= 14;
    drawLineOfText(formatDotDate(signature.signedAtIso), { size: 9.5, color: MUTED });
    y -= 18;
  } else {
    // Unsigned draft: fill the slot so the space cannot read as an oversight,
    // and make the document's status unmistakable.
    const boxH = 62;
    y -= boxH;
    page.drawRectangle({
      x: MARGIN,
      y,
      width: Math.min(320, CONTENT_W),
      height: boxH,
      color: ROSE_TINT,
      borderColor: ROSE,
      borderWidth: 1.2,
    });
    page.drawText(sanitize('UNSIGNED'), {
      x: MARGIN + 14,
      y: y + boxH - 24,
      size: 13,
      font: bold,
      color: ROSE,
    });
    page.drawText(sanitize('Pending Accounting approval — not yet valid.'), {
      x: MARGIN + 14,
      y: y + boxH - 41,
      size: 9,
      font: regular,
      color: ROSE,
    });
    page.drawText(sanitize(`Generated ${formatDotDate(generatedAtIso)} by Simple HRIS`), {
      x: MARGIN + 14,
      y: y + boxH - 54,
      size: 8,
      font: regular,
      color: MUTED,
    });
    y -= 20;
  }

  // ── Footer on every page: Reference ID so page 1 stands alone ─────────────
  const shortRef = requestId.split('-')[0] ?? requestId;
  for (const p of doc.getPages()) {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN - 18 },
      end: { x: PAGE_W - MARGIN, y: MARGIN - 18 },
      thickness: 0.5,
      color: BORDER,
    });
    const footer = sanitize(
      `Reference ID ${requestId}  ·  Verify with Simple Accounting  ·  Confidential — Simple.biz`,
    );
    p.drawText(footer, { x: MARGIN, y: MARGIN - 30, size: 7.5, font: regular, color: MUTED });
    p.drawText(sanitize(`Ref ${shortRef}`), {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(sanitize(`Ref ${shortRef}`), 7.5),
      y: MARGIN - 42,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
  }

  // Diagonal DRAFT watermark, drawn last so it sits over the text but stays
  // pale enough to read through. Only ever on the unsigned copy.
  if (!signature) {
    for (const p of doc.getPages()) {
      drawWatermark(p, bold, sanitize('UNSIGNED DRAFT'));
    }
  }

  return doc.save();
}

/** Big pale diagonal stamp across the page. */
function drawWatermark(page: PDFPage, font: PDFFont, text: string): void {
  const size = 54;
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (PAGE_W - w * 0.72) / 2,
    y: PAGE_H * 0.42,
    size,
    font,
    color: WATERMARK,
    rotate: degrees(32),
    opacity: 0.85,
  });
}

/** Exported for tests — the pieces that don't need a PDFDocument. */
export const __coeInternals = { formatDotDate, wrapText };
export type { PdfFontSet };

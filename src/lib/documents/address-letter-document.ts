// Proof of Residential Address — the PDF itself.
//
// Aliviah's hand-made letter (2026-10-06) is the template: Simple letterhead, a tracked
// title, the worker's name with Employee ID · team · work email under it, a "To Whom It
// May Concern" paragraph, a grey box with the six facts a bank checks, and a signature
// block reading "<signer> / Accounting Team · <email> · <date>".
//
// ONE deliberate wording change: the template says "the residential address listed
// above", but its own box sits BELOW the paragraph. A bank letter that points the reader
// the wrong way is wrong, so this prints "listed below".
//
// Two states, one layout, exactly like the Certificate of Engagement (coe-document.ts):
//   • DRAFT — a red UNSIGNED box in the signature slot and a diagonal UNSIGNED DRAFT
//     watermark. It is stored as the row's `original.pdf`, which the worker can download.
//   • SIGNED — the signer's own saved signature, name, "Accounting Team", email and
//     date. This IS the delivered copy: requests.ts appends NO certification page,
//     because that page says the document "was submitted by the employee named
//     below", which is false for a letter Accounting issues. The footer's Reference
//     ID is what makes the page verifiable on its own.
//
// The drawing primitives are COPIED from coe-document.ts rather than shared: the COE's
// one-page layout is pinned by its own tests, and refactoring it to serve a second
// document is a risk this letter does not need to take.

import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { embedPdfFonts } from '@/lib/pdf/fonts';
import { embedSimpleLogo, simpleLogoWidthForHeight } from '@/lib/pdf/logo';
import type { AddressLetterFacts } from './address-letter';
import type { CompleteLetterAddress } from './types';

export type { CompleteLetterAddress };

type Color = ReturnType<typeof rgb>;

const NAVY = rgb(0.13, 0.15, 0.33);
const LABEL_BLUE = rgb(0.16, 0.22, 0.62);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const DOTS = rgb(0.72, 0.72, 0.77);
const BORDER = rgb(0.86, 0.86, 0.9);
const HAIRLINE = rgb(0.9, 0.9, 0.93);
const BOX_FILL = rgb(0.95, 0.95, 0.96);
const BOX_EDGE = rgb(0.85, 0.85, 0.88);
const ROSE = rgb(0.75, 0.11, 0.24);
const ROSE_TINT = rgb(0.99, 0.95, 0.96);
const WATERMARK = rgb(0.93, 0.93, 0.95);

const PAGE_W = 612; // US Letter portrait, matching the COE and the pay-stub export
const PAGE_H = 792;
const MARGIN = 64;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN + 14;

const BODY_SIZE = 10.5;
// Whitespace is the one-page budget: the worst case (long name, three-line address,
// full-height signature) is pinned by a test with a slack floor. Recover space from
// these gaps, never from the box or the signature block.
const BODY_LEADING = 16;

export interface AddressLetterRenderParams {
  facts: Pick<AddressLetterFacts, 'workerName' | 'workEmail' | 'employeeId' | 'team' | 'startDateLabel'>;
  address: CompleteLetterAddress;
  /** Request id — printed in the footer so the page stands alone. */
  requestId: string;
  /** The issue date (ISO). Printed as DATE ISSUED and, when signed, in the signature line. */
  issuedAtIso: string;
  /** Present only for the signed copy. Absent ⇒ watermarked draft. */
  signature?: {
    dataUrl: string;
    name: string;
    email: string;
  };
  /** Layout report for the one-page tests; never used in production. */
  onLayout?: (report: AddressLetterLayoutReport) => void;
}

export interface AddressLetterLayoutReport {
  pages: number;
  contentHeight: number;
  /** Points left on a one-page budget. < 0 means a second page was needed. */
  slack: number;
}

/** "October 6, 2026" in Manila — the clock every document in this flow prints. */
function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function manilaYear(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(new Date().getFullYear());
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric' }).format(d);
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

/** Greedy word-wrap on real metrics; a single word wider than the line is split. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  const pushLong = (word: string) => {
    let chunk = '';
    for (const ch of word) {
      if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk;
  };
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
      line = probe;
      continue;
    }
    if (line) lines.push(line);
    line = font.widthOfTextAtSize(w, size) > maxWidth ? pushLong(w) : w;
  }
  if (line) lines.push(line);
  return lines;
}

interface Span {
  text: string;
  bold?: boolean;
  color?: Color;
}

function trackedWidth(text: string, font: PDFFont, size: number, tracking: number): number {
  if (!text) return 0;
  return font.widthOfTextAtSize(text, size) + tracking * (text.length - 1);
}

/** Render the letter. One page for realistic inputs; paginates rather than overflows. */
export async function renderAddressLetterDocument(params: AddressLetterRenderParams): Promise<Uint8Array> {
  const { facts, address, requestId, issuedAtIso, signature } = params;

  const doc = await PDFDocument.create();
  doc.setTitle(`Proof of Residential Address — ${facts.workerName}`);
  doc.setAuthor('Simple');
  doc.setSubject('Proof of Residential Address');
  doc.setCreator('Simple HRIS');
  doc.setProducer('Simple HRIS');

  const { regular, bold, sanitize } = await embedPdfFonts(doc);

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

  const ensureSpace = (needed: number) => {
    if (y - needed >= BOTTOM_LIMIT) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  const text = (
    raw: string,
    opts: { size?: number; font?: PDFFont; color?: Color; x?: number; align?: 'left' | 'center' } = {},
  ) => {
    const f = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const s = sanitize(raw);
    const w = f.widthOfTextAtSize(s, size);
    const x = opts.align === 'center' ? (PAGE_W - w) / 2 : (opts.x ?? MARGIN);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? TEXT });
  };

  const tracked = (raw: string, opts: { size: number; font: PDFFont; color: Color; tracking: number }) => {
    const s = sanitize(raw);
    let x = (PAGE_W - trackedWidth(s, opts.font, opts.size, opts.tracking)) / 2;
    for (const ch of s) {
      page.drawText(ch, { x, y, size: opts.size, font: opts.font, color: opts.color });
      x += opts.font.widthOfTextAtSize(ch, opts.size) + opts.tracking;
    }
  };

  const rule = (opts: { width?: number; thickness?: number; color?: Color; center?: boolean } = {}) => {
    const w = opts.width ?? CONTENT_W;
    const x = opts.center ? (PAGE_W - w) / 2 : MARGIN;
    page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: opts.thickness ?? 0.6, color: opts.color ?? HAIRLINE });
  };

  /** The template's dotted separators between sections. */
  const dottedRule = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.8,
      color: DOTS,
      dashArray: [1.2, 3],
    });
  };

  /** Wrapped body copy with inline bold — the name and date a bank scans for. */
  const richParagraph = (spans: Span[], opts: { size?: number; leading?: number } = {}) => {
    const size = opts.size ?? BODY_SIZE;
    const leading = opts.leading ?? BODY_LEADING;
    const words: { text: string; font: PDFFont; color: Color; width: number; space: boolean }[] = [];
    for (const span of spans) {
      const font = span.bold ? bold : regular;
      for (const piece of sanitize(span.text).split(/(\s+)/)) {
        if (!piece) continue;
        words.push({
          text: piece,
          font,
          color: span.color ?? TEXT,
          width: font.widthOfTextAtSize(piece, size),
          space: /^\s+$/.test(piece),
        });
      }
    }
    let line: typeof words = [];
    let lineW = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      if (line.length) {
        ensureSpace(leading);
        let x = MARGIN;
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
      if (w.space && line.length === 0) continue;
      if (!w.space && lineW + w.width > CONTENT_W && line.length) flush();
      line.push(w);
      lineW += w.width;
    }
    flush();
  };

  // ── Letterhead ────────────────────────────────────────────────────────────
  const logo = await embedSimpleLogo(doc);
  y -= 14;
  if (logo) {
    const h = 29;
    page.drawImage(logo, { x: MARGIN, y: y - 7, width: simpleLogoWidthForHeight(h), height: h });
  } else {
    text('Simple', { size: 21, font: bold, color: NAVY });
  }
  y -= 22;
  rule({ thickness: 1.2, color: NAVY });
  y -= 2.6;
  rule({ width: 98, thickness: 3, color: ORANGE });
  y -= 32;

  // ── Title + who it is about ───────────────────────────────────────────────
  tracked('PROOF OF RESIDENTIAL ADDRESS', { size: 15, font: bold, color: NAVY, tracking: 1.3 });
  y -= 12;
  rule({ width: 54, thickness: 1.8, color: ORANGE, center: true });
  y -= 22;
  text(facts.workerName, { size: 16.5, font: bold, color: NAVY, align: 'center' });
  y -= 17;
  text(
    [facts.employeeId ? `Employee ID ${facts.employeeId}` : null, facts.team, facts.workEmail]
      .filter(Boolean)
      .join('   ·   '),
    { size: 8.5, color: MUTED, align: 'center' },
  );
  y -= 14;
  dottedRule();
  y -= 20;

  // ── Body ──────────────────────────────────────────────────────────────────
  text('To Whom It May Concern:', { size: 9.5, font: bold, color: TEXT });
  y -= 16;
  richParagraph([
    { text: 'This letter confirms that ' },
    { text: facts.workerName, bold: true },
    { text: ' is currently contracted with Simple since ' },
    { text: facts.startDateLabel, bold: true },
    {
      text:
        ' and has provided the residential address listed below as their current home address in our ' +
        'records. This document is being issued at the contractor’s request for the purpose of ' +
        'residential address verification. The information contained in this letter reflects the ' +
        'address currently provided by the contractor to Simple.',
    },
  ]);
  y -= 4;
  dottedRule();
  y -= 14;

  // ── The facts box ─────────────────────────────────────────────────────────
  {
    const rows: Array<[string, string]> = [
      ['FULL LEGAL NAME', facts.workerName],
      ['RESIDENTIAL ADDRESS', address.street],
      ['CITY / STATE / PROVINCE', address.cityProvince],
      ['POSTAL / ZIP CODE', address.postalCode],
      ['COUNTRY', address.country],
      ['DATE ISSUED', formatLongDate(issuedAtIso)],
    ];
    const pad = 12;
    const labelSize = 8.5;
    const valueSize = 10;
    const labelW = 156;
    const valueX = MARGIN + pad + labelW;
    const valueW = CONTENT_W - pad * 2 - labelW;
    const lineH = 13;
    const rowGap = 6;
    const wrapped = rows.map(([label, value]) => ({
      label,
      lines: wrapText(sanitize(value), bold, valueSize, valueW),
    }));
    const boxH =
      pad * 2 + wrapped.reduce((h, r) => h + Math.max(1, r.lines.length) * lineH, 0) + rowGap * (rows.length - 1) - 4;
    ensureSpace(boxH);
    const top = y;
    page.drawRectangle({
      x: MARGIN,
      y: top - boxH,
      width: CONTENT_W,
      height: boxH,
      color: BOX_FILL,
      borderColor: BOX_EDGE,
      borderWidth: 0.6,
      borderDashArray: [1.5, 2],
    });
    y = top - pad - labelSize;
    for (const r of wrapped) {
      page.drawText(sanitize(r.label), { x: MARGIN + pad, y, size: labelSize, font: bold, color: LABEL_BLUE });
      for (const [i, line] of r.lines.entries()) {
        page.drawText(line, { x: valueX, y: y - i * lineH, size: valueSize, font: bold, color: TEXT });
      }
      y -= Math.max(1, r.lines.length) * lineH + rowGap;
    }
    y = top - boxH - 14;
  }
  dottedRule();
  y -= 22;

  // ── Signature block ───────────────────────────────────────────────────────
  ensureSpace(signature ? 118 : 96);
  text('Signed,', { size: BODY_SIZE, color: TEXT });
  y -= 10;
  const issued = formatLongDate(issuedAtIso);
  if (signature && sigImage) {
    const maxW = Math.min(196, CONTENT_W * 0.44);
    const maxH = 46;
    const scale = Math.min(maxW / sigImage.width, maxH / sigImage.height, 1);
    const w = sigImage.width * scale;
    const h = sigImage.height * scale;
    y -= h;
    page.drawImage(sigImage, { x: MARGIN, y, width: w, height: h });
    y -= 9;
    rule({ width: 200, thickness: 0.8, color: BORDER });
    y -= 16;
    text(signature.name, { size: 12, font: bold, color: TEXT });
    y -= 14;
    // Template wording: the TEAM, not the signer's personal title.
    text(`Accounting Team  ·  ${signature.email}  ·  ${issued}`, { size: 8.5, color: MUTED });
    y -= 14;
  } else {
    const boxW = Math.min(316, CONTENT_W);
    const boxH = 58;
    y -= boxH;
    page.drawRectangle({ x: MARGIN, y, width: boxW, height: boxH, color: ROSE_TINT, borderColor: ROSE, borderWidth: 1 });
    page.drawText(sanitize('UNSIGNED'), { x: MARGIN + 14, y: y + boxH - 22, size: 12, font: bold, color: ROSE });
    page.drawText(sanitize('Not valid until Accounting signs it.'), {
      x: MARGIN + 14,
      y: y + boxH - 37,
      size: 8.5,
      font: regular,
      color: ROSE,
    });
    page.drawText(sanitize(`Generated ${issued} by Simple HRIS`), {
      x: MARGIN + 14,
      y: y + boxH - 50,
      size: 8,
      font: regular,
      color: MUTED,
    });
    y -= 16;
  }

  // ── Footer on every page ──────────────────────────────────────────────────
  const pages = doc.getPages();
  if (params.onLayout) {
    const budget = PAGE_H - MARGIN - BOTTOM_LIMIT;
    const contentHeight = (pages.length - 1) * budget + (PAGE_H - MARGIN - y);
    params.onLayout({ pages: pages.length, contentHeight, slack: budget - contentHeight });
  }
  const year = manilaYear(issuedAtIso);
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
        ? `Confidential document — Simple.biz © ${year}  ·  Page ${i + 1} of ${pages.length}`
        : `Confidential document — Simple.biz © ${year}`,
    );
    p.drawText(right, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(right, 7),
      y: MARGIN - 28,
      size: 7,
      font: regular,
      color: MUTED,
    });
  });

  if (!signature) {
    for (const p of pages) drawWatermark(p, bold, sanitize('UNSIGNED DRAFT'));
  }

  return doc.save();
}

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
export const __addressLetterInternals = { formatLongDate, manilaYear, wrapText };

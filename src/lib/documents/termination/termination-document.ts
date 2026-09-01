// [TERMINATION-DOCS]
// Certificate of Termination — the PDF itself.
//
// The COE inverted. Same letterhead, same typographic system, opposite claim:
// this page states that the named worker is NO LONGER an active contractor, on
// which date, for which recorded reason, out of which department, and at what
// compensation at each end of the engagement.
//
// SIBLING, NOT A FORK. coe-document.ts is never modified and never will be:
// `text`, `tracked`, `rule`, `richParagraph`, `sectionLabel`, `leaderRow` and
// `ensureSpace` are closures INSIDE renderCoeDocument over `let page` / `let y`,
// so they are unreachable by import. They are duplicated here — the shipped
// precedent (sign-pdf.ts re-implements `text()`, its own wrap loop and
// `dataUrlToBytes` for exactly this reason). The three helpers the COE does
// export (`__coeInternals`) are imported rather than copied.
//
// ONE PAGE, always. A termination letter that runs to two pages reads as a
// mistake to whoever receives it, and it is the only document in this feature —
// nothing is appended afterwards. Every block measures before it draws, the
// worker name downscales rather than overflowing, and a leader row whose value
// cannot sit beside its label breaks to its own line instead of colliding.
// termination-document.test.ts pins the page count at the 1x1 placeholder, at
// the REAL full-height signature raster, and at a worst case.
//
// SIGNED AT GENERATION. `signature` is required, not optional: there is no draft
// state, so a missing signature is a type error rather than a silently unsigned
// legal page. Nothing routes through stampSignedDocument — that re-embeds fonts
// and the logo into already-embedded bytes (~184 KB vs ~97 KB).
//
// REFUSALS. The resolver's contract is "prompt, never refuse" — a blank is the
// normal state of a 2023 leaver and the rep fills it. By the time bytes are
// rendered every printed fact must be present and printable, so this module
// refuses rather than emitting a document that is false or mangled: a name that
// composes to a comma fragment or an @-address, a raw `hsl:*` slug, a missing
// end date or departure reason. Refusing is louder than a NOT NULL violation on
// insert and lands before any storage object is written.

import { PDFDocument, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import { embedPdfFonts } from '@/lib/pdf/fonts';
import { embedSimpleLogo, simpleLogoWidthForHeight } from '@/lib/pdf/logo';
import { __coeInternals } from '@/lib/documents/coe-document';
import { formatCoeStartDate } from '@/lib/documents/coe-facts';
import type { TerminationCurrency, TerminationFacts, TerminationRate } from './types';

const { formatDotDate, trackedWidth, wrapText } = __coeInternals;

type Color = ReturnType<typeof rgb>;

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const FAINT = rgb(0.58, 0.58, 0.64);
const BORDER = rgb(0.86, 0.86, 0.9);
const HAIRLINE = rgb(0.9, 0.9, 0.93);

const PAGE_W = 612; // US Letter portrait, matching the COE and the pay-stub export
const PAGE_H = 792;
const MARGIN = 64;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN + 14; // footer rule sits at MARGIN-16, text at MARGIN-28

const BODY_SIZE = 10.5;
const BODY_LEADING = 16.5;

/** Signature cap, IDENTICAL to the COE block (coe-document.ts:451, pinned in
 *  signature-render.ts PDF_SIGNATURE_MAX_HEIGHTS.coeBlock). Sharing the cap is
 *  what makes a typed signature (a fixed 184 px raster) and a drawn one land at
 *  the same size on both documents; a third cap would need adding there. */
const SIGNATURE_MAX_H = 46;

/** Currency symbols and locales, mirrored from pay-structure.ts:40 / :58 rather
 *  than imported — this module's type surface (./types) deliberately does not
 *  reach into payment-catalog, and a formatter is not worth the coupling.
 *  The peso sign is built from its code point so this source stays ASCII. */
const CURRENCY_SYMBOL: Record<TerminationCurrency, string> = {
  PHP: String.fromCharCode(0x20b1),
  USD: '$',
  // Colombian peso also uses "$"; the house symbol carries the code.
  COP: '$COP',
};

const CURRENCY_LOCALE: Record<TerminationCurrency, string> = {
  PHP: 'en-PH',
  USD: 'en-US',
  COP: 'es-CO',
};

/**
 * EVERY fixed string this document draws, in one place.
 *
 * Not a style preference: fontkit applies the `liga` GSUB feature, and a
 * ligature pruned out of the embedded subset renders as a BLANK GAP carrying the
 * full glyph advance — that is how "Certifi cate of Engagement" shipped. No
 * sanitiser test can catch it; the only reliable check lays the real strings out
 * and asserts every glyph has an outline. The test does that over these values,
 * so a sentence that is not routed through here is a sentence nothing checks.
 * Words at risk here: certificate, confirm, affiliated, effective, identifier.
 */
const PROSE = {
  title: 'Certificate of Termination',
  mastheadRight: 'Pulled from Simple-HRIS System',
  mastheadSub: 'Payroll Department  ·  payroll@simple.biz',
  wordmarkFallback: 'Simple',

  bodyOpen: 'This is to confirm that ',
  bodyNoLonger:
    ' is no longer an active contractor of Simple.biz. Their contract with the company ended on ',
  bodyUnaffiliated:
    ', and they are no longer affiliated with Simple.biz in any capacity and hold no ' +
    'authority to represent the company.',

  sectionLabel: 'Record of engagement',
  rowEndDate: 'Contract end date',
  rowReason: 'Reason for departure',
  rowDepartment: 'Ending department',
  rowStartDate: 'Contract start date',
  rowRateBoth: 'Hourly rate, hire to contract end',
  rowRateStart: 'Hourly rate at hire',
  rowRateEnd: 'Hourly rate at contract end',
  rateCurrencyNote: 'Each figure is stated in the currency it was paid in.',

  closing:
    'This letter states the record held in the Simple HRIS at the time it was generated, and ' +
    'makes no representation beyond it. Any question about the engagement, the departure ' +
    'reason or the compensation stated above should be raised with Simple Accounting, quoting ' +
    'the reference identifier below.',

  signedBy: 'Signed,',
  referencePrefix: 'Reference ID ',
  footerConfidential: 'Confidential — Simple.biz',
  footerIssuer: 'Issued by Simple HRIS',
} as const;

export interface TerminationRenderParams {
  facts: TerminationFacts;
  /** termination_documents.id — printed as the Reference ID. */
  documentId: string;
  /** When the document was generated (ISO). */
  generatedAtIso: string;
  /** The generating rep's own saved signature. REQUIRED — never a draft. */
  signature: {
    /** PNG/JPEG data URL from the signature pad. */
    dataUrl: string;
    name: string;
    title: string;
    email: string;
    signedAtIso: string;
  };
}

/** Hourly rates always show cents — a reader comparing 225 to 225.50 cares.
 *  Duplicate of the PRIVATE formatCoeRate (coe-facts.ts:141); the exported
 *  formatCoeMoney drops trailing cents, which would collapse a hire-to-end pair
 *  into a misleading "225 -> 225". */
function formatTerminationRate(amount: number, currency: TerminationCurrency): string {
  const digits = currency === 'COP' ? 0 : 2;
  const n = amount.toLocaleString(CURRENCY_LOCALE[currency], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // "$COP" carries the code, so it needs a space or a bank reads one token.
  const gap = currency === 'COP' ? ' ' : '';
  return `${CURRENCY_SYMBOL[currency]}${gap}${n}`;
}

/** A rate is printable only when it holds a real amount AND the currency that
 *  amount is denominated in. `0` never reaches here (the resolver turns it into
 *  a blank), but a stored 0 must not print either — and neither must a figure
 *  with no currency: `225` alone reads as pesos to a Filipino reader and as
 *  dollars to an American one, and the letter is a legal statement. An
 *  undenominated amount cannot reach this function (the resolver blanks it, the
 *  route demands a currency with every rep fill, and `describeUnloggableFacts`
 *  refuses the row), so this is the last of four gates, not the only one. */
function rateLabel(rate: TerminationRate | null | undefined): string | null {
  if (!rate || rate.amount == null || !Number.isFinite(rate.amount) || rate.amount <= 0) return null;
  if (!rate.currency) return null;
  return formatTerminationRate(rate.amount, rate.currency);
}

/** Date label for a `YYYY-MM-DD` cell, through the shared helper. Never
 *  `new Date('2026-08-18')` — that is UTC midnight and reads as the 17th in
 *  Manila. Prefers the label the resolver already computed. */
function dateLabel(label: string | null, raw: string | null): string | null {
  const fromFacts = (label ?? '').trim();
  if (fromFacts) return fromFacts;
  const iso = (raw ?? '').trim();
  return iso ? formatCoeStartDate(iso) : null;
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

/** A run of body copy; `bold` lifts the figures a reader scans for. */
interface Span {
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

/**
 * Largest size in `[min, start]` at which `s` fits `maxWidth` on one line.
 *
 * The worker name is set centred on a single line, and master-list names reach
 * 65 characters ("Maria Cristina Bernadette Villanueva-Santos de los Reyes
 * Magbanua") — 512pt at the headline size, past the 484pt content width. The
 * COE lets that overflow; here it downscales instead. Wrapping is worse: a
 * legal name split across two centred lines reads as two people.
 */
function fitSize(s: string, font: PDFFont, start: number, min: number, maxWidth: number): number {
  let size = start;
  while (size > min && font.widthOfTextAtSize(s, size) > maxWidth) size -= 0.5;
  return size;
}

/**
 * Render the Certificate of Termination. Returns a ONE-page PDF.
 *
 * Throws — rather than printing something false — when the composed legal name
 * is mangled, when a printed fact is missing, when the department label is a raw
 * `hsl:*` slug, or when the signature image cannot be embedded.
 */
export async function renderTerminationDocument(
  params: TerminationRenderParams,
): Promise<Uint8Array> {
  const { facts, documentId, generatedAtIso, signature } = params;

  // ── Refusals, before a single byte is allocated ────────────────────────────
  // The COE's guard is `/[,"“”]/` on the composed name: the master list stores
  // names surname-first with the go-by in quotes, and a row whose nickname sits
  // in FRONT of the surname composes to ", Jeannel Peduhan". `@` is this
  // feature's addition — parseNameParts parks an address found in the Name
  // column whole in `first` (name-parts.ts:163), and it passes the comma test,
  // so "jasminec@simple.biz" would print as somebody's legal name.
  const workerName = (facts.workerName ?? '').replace(/\s+/g, ' ').trim();
  if (!workerName || /[,"“”]/.test(workerName) || workerName.includes('@')) {
    throw new Error(
      `Refusing to print a mangled legal name: ${JSON.stringify(facts.workerName ?? null)}`,
    );
  }

  const endDateLabel = dateLabel(facts.terminationDateLabel, facts.terminationDate);
  if (!endDateLabel) {
    throw new Error('Refusing to issue a termination document with no termination date');
  }

  const reasonLabel = (facts.reasonLabel ?? '').trim();
  if (!reasonLabel || reasonLabel === '—') {
    throw new Error('Refusing to issue a termination document with no departure reason');
  }

  const departmentLabel = (facts.endingDepartmentLabel ?? '').trim();
  if (!departmentLabel) {
    throw new Error('Refusing to issue a termination document with no ending department label');
  }
  // Last line of defence for G6, matching the DDL's `not like 'hsl:%'` CHECK. A
  // raw sub-department slug is an internal key, not a department a human reads.
  if (/^hsl:/i.test(departmentLabel)) {
    throw new Error(
      `Refusing to print a raw department slug: "${departmentLabel}" (pass it through formatDeptLabel)`,
    );
  }

  const doc = await PDFDocument.create();
  doc.setTitle(`${PROSE.title} — ${workerName}`);
  doc.setAuthor('Simple');
  doc.setSubject(PROSE.title);
  doc.setCreator('Simple HRIS');
  doc.setProducer('Simple HRIS');

  // Exactly once per document: a second embedPdfFonts duplicates ~70 KB of font
  // data, a second embedSimpleLogo the artwork (fonts.ts:105-107).
  const fonts = await embedPdfFonts(doc);
  const { regular, bold, sanitize } = fonts;

  const parsedSig = dataUrlToBytes(signature.dataUrl);
  if (!parsedSig) throw new Error('Saved signature is not a valid data URL');
  let sigImage: PDFImage;
  try {
    sigImage =
      parsedSig.mime.includes('jpeg') || parsedSig.mime.includes('jpg')
        ? await doc.embedJpg(parsedSig.bytes)
        : await doc.embedPng(parsedSig.bytes);
  } catch {
    throw new Error('Saved signature image could not be embedded (redraw and save it again)');
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

  /** Letter-spaced text, drawn glyph by glyph — pdf-lib has no letter-spacing.
   *  Used for the document title and the one section label only. */
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

  const rule = (
    opts: { width?: number; x?: number; thickness?: number; color?: Color; center?: boolean } = {},
  ) => {
    const w = opts.width ?? CONTENT_W;
    const x = opts.center ? (PAGE_W - w) / 2 : (opts.x ?? MARGIN);
    page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: opts.thickness ?? 0.6,
      color: opts.color ?? HAIRLINE,
    });
  };

  /** Wrapped body copy with inline emphasis, measured per WORD so a span
   *  boundary can fall mid-line. The name and the end date are the two things a
   *  reader looks for, so they are bold inside otherwise plain prose. */
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

  /** Small navy label opening the facts block. The document has exactly one. */
  const sectionLabel = (raw: string) => {
    ensureSpace(14);
    tracked(raw.toUpperCase(), { size: 7.5, font: bold, color: NAVY, tracking: 1.1 });
    y -= 6;
    rule({ width: 26, thickness: 1.4, color: ORANGE });
    y -= 14;
  };

  /**
   * A record row: label left, value hard right, dot leader between. Standard in
   * formal correspondence and far easier to read than a comma-run of pairs.
   *
   * When the value cannot sit beside its label it breaks to its own right-
   * aligned line(s) instead of colliding — a real case, not a hypothetical:
   * "Ending department" plus a multi-part label such as "Healthcare Solutions —
   * Specialty Dental Billing and Insurance Verification Team" exceeds the 484pt
   * content width on its own.
   */
  const leaderRow = (label: string, value: string, qualifier?: string) => {
    const size = 10.5;
    const labelS = sanitize(label);
    const valueS = sanitize(value);
    const labelW = regular.widthOfTextAtSize(labelS, size);
    const valueW = bold.widthOfTextAtSize(valueS, size);
    const dot = sanitize('·');
    const dotW = regular.widthOfTextAtSize(dot, size);
    const fitsBeside = labelW + valueW + dotW * 4 <= CONTENT_W;

    if (fitsBeside) {
      ensureSpace(15);
      page.drawText(labelS, { x: MARGIN, y, size, font: regular, color: TEXT });
      page.drawText(valueS, { x: PAGE_W - MARGIN - valueW, y, size, font: bold, color: NAVY });
      // Dots fill the gap, inset from both sides so they never touch the text.
      const gapStart = MARGIN + labelW + 6;
      const gapEnd = PAGE_W - MARGIN - valueW - 6;
      if (gapEnd - gapStart > dotW * 2) {
        const step = dotW * 2.1;
        for (let x = gapStart; x <= gapEnd - dotW; x += step) {
          page.drawText(dot, { x, y, size, font: regular, color: FAINT });
        }
      }
      y -= 13;
    } else {
      ensureSpace(28);
      page.drawText(labelS, { x: MARGIN, y, size, font: regular, color: TEXT });
      y -= 13;
      for (const line of wrapText(valueS, bold, size, CONTENT_W - 18)) {
        ensureSpace(13);
        const w = bold.widthOfTextAtSize(line, size);
        page.drawText(line, { x: PAGE_W - MARGIN - w, y, size, font: bold, color: NAVY });
        y -= 13;
      }
    }

    if (qualifier) {
      ensureSpace(12);
      page.drawText(sanitize(qualifier), { x: MARGIN, y, size: 8.5, font: regular, color: MUTED });
      y -= 13;
    }
  };

  // ── Letterhead ────────────────────────────────────────────────────────────
  // The real wordmark, heart included; set as type when the PNG can't embed. A
  // missing letterhead must never be the reason a document fails.
  const logo = await embedSimpleLogo(doc);
  y -= 14;
  if (logo) {
    const h = 29;
    // Sit the artwork so the wordmark's baseline lands on the current text
    // baseline; the heart occupies the top of the box, hence the offset.
    page.drawImage(logo, { x: MARGIN, y: y - 7, width: simpleLogoWidthForHeight(h), height: h });
  } else {
    text(PROSE.wordmarkFallback, { size: 21, font: bold, color: NAVY });
  }
  text(PROSE.mastheadRight, { size: 8.5, font: bold, color: NAVY, align: 'right' });
  y -= 12;
  text(PROSE.mastheadSub, { size: 8, color: MUTED, align: 'right' });
  y -= 14;
  rule({ thickness: 1.2, color: NAVY });
  y -= 2.6;
  rule({ width: 58, thickness: 2.4, color: ORANGE });
  y -= 40;

  // ── Document title ────────────────────────────────────────────────────────
  tracked(PROSE.title.toUpperCase(), {
    size: 13.5,
    font: bold,
    color: NAVY,
    tracking: 2.2,
    align: 'center',
  });
  y -= 14;
  rule({ width: 44, thickness: 1.6, color: ORANGE, center: true });
  y -= 26;

  // ── Who it is about ───────────────────────────────────────────────────────
  {
    const nameSize = fitSize(sanitize(workerName), bold, 16.5, 11, CONTENT_W);
    text(workerName, { size: nameSize, font: bold, color: TEXT, align: 'center' });
  }
  y -= 15;
  // The work email is the IDENTITY this record is keyed on (G1), so it is the
  // one piece of metadata worth printing under the name.
  text(facts.identity.workEmail, { size: 8.5, color: MUTED, align: 'center' });
  y -= 19;
  rule();
  y -= 21;

  // ── The statement ─────────────────────────────────────────────────────────
  richParagraph([
    { text: PROSE.bodyOpen },
    { text: workerName, bold: true },
    { text: PROSE.bodyNoLonger },
    { text: endDateLabel, bold: true, color: NAVY },
    { text: PROSE.bodyUnaffiliated },
  ]);
  y -= 15;

  // ── The record ────────────────────────────────────────────────────────────
  sectionLabel(PROSE.sectionLabel);
  leaderRow(PROSE.rowEndDate, endDateLabel);
  leaderRow(PROSE.rowReason, reasonLabel);
  leaderRow(PROSE.rowDepartment, departmentLabel);

  const startLabel = dateLabel(facts.startDateLabel, facts.startDate);
  if (startLabel) leaderRow(PROSE.rowStartDate, startLabel);

  // Compensation, each figure in ITS OWN currency — USD and COP payees exist
  // and PHP-only would systematically misstate them. Three shapes rather than a
  // dangling arrow: a legal page never prints "-> 300.00" with nothing before it.
  {
    const startRate = rateLabel(facts.startingRate);
    const endRate = rateLabel(facts.endingRate);
    const mixed =
      !!startRate &&
      !!endRate &&
      facts.startingRate.currency !== facts.endingRate.currency;
    // "->" is written out because the subset has no arrow glyph — sanitize()
    // folds U+2192 to exactly this, so the source says what prints.
    if (startRate && endRate) {
      leaderRow(
        PROSE.rowRateBoth,
        `${startRate}  ->  ${endRate}`,
        mixed ? PROSE.rateCurrencyNote : undefined,
      );
    } else if (startRate) {
      leaderRow(PROSE.rowRateStart, startRate);
    } else if (endRate) {
      leaderRow(PROSE.rowRateEnd, endRate);
    }
  }
  y -= 17;

  richParagraph([{ text: PROSE.closing }], { size: 9, leading: 13.5, color: MUTED });
  y -= 22;

  // ── Signature block ───────────────────────────────────────────────────────
  ensureSpace(132);
  text(PROSE.signedBy, { size: BODY_SIZE, color: TEXT });
  y -= 10;
  {
    const maxW = Math.min(196, CONTENT_W * 0.44);
    // The trailing 1 is the never-upscale clamp: a 1x1 placeholder must stay
    // 1pt tall rather than being blown up to the cap.
    const scale = Math.min(maxW / sigImage.width, SIGNATURE_MAX_H / sigImage.height, 1);
    const w = sigImage.width * scale;
    const h = sigImage.height * scale;
    y -= h;
    page.drawImage(sigImage, { x: MARGIN, y, width: w, height: h });
  }
  y -= 9;
  rule({ width: 214, thickness: 0.8, color: BORDER });
  y -= 14;
  text(signature.name, { size: 11.5, font: bold, color: TEXT });
  y -= 13;
  text(signature.title, { size: 9.5, color: TEXT });
  y -= 12;
  text(signature.email, { size: 9, color: MUTED });
  y -= 14;
  // Signing date left, reference identifier right, one baseline: the two things
  // an auditor matches this page against the log row on.
  text(formatDotDate(signature.signedAtIso), { size: 9, font: bold, color: NAVY });
  text(`${PROSE.referencePrefix}${documentId}`, { size: 8, color: MUTED, align: 'right' });
  y -= 16;

  // ── Footer on every page ──────────────────────────────────────────────────
  // Pagination is defensive only — the tests pin this document at one page — but
  // an unnumbered second page would be worse than a numbered one.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN - 16 },
      end: { x: PAGE_W - MARGIN, y: MARGIN - 16 },
      thickness: 0.6,
      color: HAIRLINE,
    });
    const left = sanitize(PROSE.footerConfidential);
    p.drawText(left, { x: MARGIN, y: MARGIN - 28, size: 7, font: regular, color: MUTED });
    const right = sanitize(
      pages.length > 1
        ? `${PROSE.footerIssuer}  ·  Page ${i + 1} of ${pages.length}`
        : PROSE.footerIssuer,
    );
    p.drawText(right, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(right, 7),
      y: MARGIN - 28,
      size: 7,
      font: regular,
      color: MUTED,
    });
  });

  // `generatedAtIso` is recorded on the log row and carried in the PDF metadata;
  // the page itself prints the SIGNING date, which is the date that matters on a
  // signed instrument. Guarded: pdf-lib writes the value straight into the
  // trailer, and an Invalid Date would produce an unparseable /CreationDate.
  {
    const created = new Date(generatedAtIso);
    if (!Number.isNaN(created.getTime())) doc.setCreationDate(created);
  }

  return doc.save();
}

/** Exported for tests — the pieces that don't need a PDFDocument, plus every
 *  fixed string the page draws (the ligature check lays them out for real). */
export const __terminationInternals = {
  formatTerminationRate,
  fitSize,
  rateLabel,
  dateLabel,
  proseSamples: Object.values(PROSE) as readonly string[],
  SIGNATURE_MAX_H,
};

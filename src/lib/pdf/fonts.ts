// Shared font layer for every PDF the HRIS issues.
//
// pdf-lib's StandardFonts.Helvetica is WinAnsi-encoded, so it cannot draw the
// PESO SIGN (₱, U+20B1) — the pay-stub export and the signing certification page
// both worked around that by printing "PHP 225.00". A Certificate of Engagement
// goes to banks and embassies, so it prints the real ₱; this module is the one
// place that makes that possible, and the two older exports share it.
//
// The font is a 200-code-point subset of Noto Sans committed as base64 TS
// modules (see scripts/build-pdf-font.mjs for why, and how to regenerate). That
// keeps it ~35 KB per weight and identical on the server and in the browser —
// the pay-stub export is a client component, so a runtime fetch or an fs read
// would be a liability there.
//
// Embedding is best-effort: if it fails for any reason the caller still gets a
// usable font set backed by Helvetica, with sanitize() falling back to "PHP ".
// A broken font must never be the reason an employee can't download a pay stub.

import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { NOTO_SANS_REGULAR_BASE64 } from './fonts/noto-sans-regular';
import { NOTO_SANS_BOLD_BASE64 } from './fonts/noto-sans-bold';

/** Code points the subset covers, mirroring buildCharset() in the generator. */
function isCoveredBySubset(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true; // printable ASCII
  if (code >= 0xa0 && code <= 0xff) return true; // Latin-1 (accented names)
  return SMART_PUNCTUATION_CODES.has(code);
}

const SMART_PUNCTUATION_CODES = new Set(
  [...'₱–—‘’“”…•·'].map((ch) => ch.codePointAt(0) as number),
);

/** Glyphs the subset omits but callers legitimately pass; mapped to ASCII. */
const ASCII_SUBSTITUTES: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '≥': '>=',
  '≤': '<=',
  '×': 'x',
  '≈': '~',
  '™': '(TM)',
  ' ': ' ', // NBSP — covered by the subset, but a normal space lays out better
};

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PdfFontSet {
  regular: PDFFont;
  bold: PDFFont;
  /**
   * True when the Unicode subset embedded successfully, i.e. ₱ will render as
   * ₱. False means we fell back to WinAnsi Helvetica and sanitize() rewrites ₱
   * to "PHP " the way the exports did before this module existed.
   */
  unicode: boolean;
  /**
   * Make arbitrary text safe to draw with this font set. pdf-lib THROWS when a
   * glyph is missing, so every string handed to drawText must pass through
   * here — an unsanitized name with a CJK character would otherwise fail the
   * whole export.
   */
  sanitize(text: string): string;
}

/** WinAnsi-safe text — the pre-existing behaviour, kept for the fallback path. */
function sanitizeWinAnsi(text: string): string {
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

/** Unicode-subset-safe text — keeps ₱ and smart punctuation, folds the rest. */
function sanitizeUnicodeSubset(text: string): string {
  let out = '';
  for (const ch of text) {
    const sub = ASCII_SUBSTITUTES[ch];
    if (sub !== undefined) {
      out += sub;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code !== undefined && isCoveredBySubset(code)) out += ch;
    else out += '?';
  }
  return out;
}

/**
 * Embed the shared font set into `doc`. Call once per document and reuse the
 * result — embedding twice would duplicate ~70 KB of font data in the output.
 */
export async function embedPdfFonts(doc: PDFDocument): Promise<PdfFontSet> {
  try {
    // Dynamic import so the ~1 MB fontkit bundle stays off the critical path of
    // any caller that never renders a PDF.
    const { default: fontkit } = await import('@pdf-lib/fontkit');
    doc.registerFontkit(fontkit);
    const [regular, bold] = await Promise.all([
      doc.embedFont(base64ToBytes(NOTO_SANS_REGULAR_BASE64)),
      doc.embedFont(base64ToBytes(NOTO_SANS_BOLD_BASE64)),
    ]);
    return { regular, bold, unicode: true, sanitize: sanitizeUnicodeSubset };
  } catch {
    // Fall back to the standard fonts rather than failing the export.
    const [regular, bold] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
    ]);
    return { regular, bold, unicode: false, sanitize: sanitizeWinAnsi };
  }
}

/** Exported for tests — the two sanitizers, independent of any PDFDocument. */
export const __sanitizers = { sanitizeWinAnsi, sanitizeUnicodeSubset };

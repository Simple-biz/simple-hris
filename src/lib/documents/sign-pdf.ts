// Signature stamping for approved document requests.
//
// Approving a request loads the employee's ORIGINAL uploaded PDF and appends a
// branded CERTIFICATION PAGE carrying the approver's drawn signature plus the
// two dates that make the document verifiable — when the employee REQUESTED it
// and when Accounting SIGNED it — alongside the request id an auditor can match
// against the `document_requests` row. The original pages are never redrawn
// (nothing can overlap or corrupt the submitted content); a one-line stamp is
// added at the very bottom edge of the last original page pointing at the
// certification page.
//
// Built with pdf-lib (same as the pay-stubs export) so it runs on Vercel's
// Node runtime with no native deps or template files.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const BORDER = rgb(0.86, 0.86, 0.9);
const PANEL = rgb(0.97, 0.97, 0.99);

/** WinAnsi-safe text (pdf-lib's standard Helvetica can't encode arbitrary Unicode). */
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

/** "July 18, 2026, 3:41 PM (GMT+8)" — Manila wall-clock, the company timezone. */
function formatManila(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const s = d.toLocaleString('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${s} (GMT+8)`;
  } catch {
    return d.toISOString();
  }
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

export interface StampSignedDocumentParams {
  /** The employee's original PDF, exactly as submitted. */
  originalBytes: Uint8Array | ArrayBuffer;
  /** The approver's saved signature (PNG/JPEG data URL from the signature pad). */
  signatureDataUrl: string;
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  employeeName: string;
  employeeEmail: string;
  /** Human document label, e.g. "Pay Stubs". */
  documentLabel: string;
  /** Optional period line for paystub bundles, e.g. "Last 6 months · 26 weeks". */
  periodLabel?: string | null;
  /** document_requests.id — the verifiable reference burned into the page. */
  requestId: string;
  requestedAtIso: string;
  signedAtIso: string;
}

/**
 * Returns the signed PDF: the original pages untouched + an appended
 * certification page. Throws when the input isn't a loadable PDF or the
 * signature image can't be embedded.
 */
export async function stampSignedDocument(params: StampSignedDocumentParams): Promise<Uint8Array> {
  const doc = await PDFDocument.load(params.originalBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const sig = dataUrlToBytes(params.signatureDataUrl);
  if (!sig) throw new Error('Saved signature is not a valid data URL');
  let sigImage: PDFImage;
  try {
    sigImage = sig.mime.includes('jpeg') || sig.mime.includes('jpg')
      ? await doc.embedJpg(sig.bytes)
      : await doc.embedPng(sig.bytes);
  } catch {
    throw new Error('Saved signature image could not be embedded (redraw and save it again)');
  }

  const originalPages = doc.getPages();
  const lastOriginal: PDFPage | undefined = originalPages[originalPages.length - 1];
  const pageW = lastOriginal?.getWidth() ?? 612;
  const pageH = lastOriginal?.getHeight() ?? 792;

  const shortId = params.requestId.split('-')[0] ?? params.requestId;

  // A one-line pointer on the last ORIGINAL page's extreme bottom edge (below
  // any normal content margin). Best-effort — never fail the signing over it.
  if (lastOriginal && pageH > 120) {
    try {
      const note = sanitize(
        `Digitally signed via Simple HRIS - Ref ${shortId} - see the appended certification page`,
      );
      lastOriginal.drawText(note, { x: 24, y: 8, size: 6.5, font, color: MUTED });
    } catch {
      /* decorative only */
    }
  }

  // ── Certification page (same size as the document it certifies) ───────────
  const page = doc.addPage([pageW, pageH]);
  const margin = Math.max(40, Math.min(56, pageW * 0.08));
  const contentW = pageW - margin * 2;
  // drawText's y is the BASELINE — start one cap-height down so the masthead
  // doesn't ride the top margin edge.
  let y = pageH - margin - 14;

  const text = (
    raw: string,
    opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; rightAlign?: boolean },
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 10;
    const s = sanitize(raw);
    const x = opts.rightAlign
      ? pageW - margin - f.widthOfTextAtSize(s, size)
      : opts.x ?? margin;
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? TEXT });
  };

  // Masthead
  text('Simple', { size: 22, font: bold, color: NAVY });
  text('Pulled from Simple-HRIS System', { size: 9, font: bold, color: NAVY, rightAlign: true });
  y -= 13;
  text('Documents - Certification of Signing', { size: 8.5, color: MUTED, rightAlign: true });
  y -= 18;
  page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 1.4, color: NAVY });
  y -= 3;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 64, y }, thickness: 3, color: ORANGE });
  y -= 30;

  text('DOCUMENT CERTIFICATION', { size: 16, font: bold, color: NAVY });
  y -= 20;

  const intro =
    'This page certifies that the preceding document was submitted by the employee named below, ' +
    'reviewed by Accounting, and approved and digitally signed through the Simple HRIS Documents ' +
    'workflow. The requested and signed dates below are recorded in the HRIS and can be used to ' +
    'confirm this document is authentic.';
  // Simple word-wrap for the intro paragraph.
  {
    const words = sanitize(intro).split(/\s+/);
    let line = '';
    const size = 9.5;
    const lh = 13;
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) > contentW && line) {
        page.drawText(line, { x: margin, y, size, font, color: MUTED });
        y -= lh;
        line = w;
      } else {
        line = probe;
      }
    }
    if (line) {
      page.drawText(line, { x: margin, y, size, font, color: MUTED });
      y -= lh;
    }
  }
  y -= 14;

  // Details panel
  const rows: Array<[string, string, boolean?]> = [
    ['Document', params.documentLabel],
    ...(params.periodLabel ? ([['Period', params.periodLabel]] as Array<[string, string]>) : []),
    ['Employee', params.employeeName || params.employeeEmail],
    ['Work email', params.employeeEmail],
    ['Requested on', formatManila(params.requestedAtIso), true],
    ['Signed on', formatManila(params.signedAtIso), true],
    ['Reference ID', params.requestId],
  ];
  const rowH = 22;
  const panelH = rows.length * rowH + 14;
  page.drawRectangle({ x: margin, y: y - panelH, width: contentW, height: panelH, color: PANEL });
  page.drawRectangle({
    x: margin, y: y - panelH, width: contentW, height: panelH,
    borderColor: BORDER, borderWidth: 1, opacity: 0,
  });
  {
    let ry = y - 22;
    const labelX = margin + 14;
    const valueX = margin + 118;
    for (const [label, value, emphasize] of rows) {
      page.drawText(sanitize(label.toUpperCase()), { x: labelX, y: ry, size: 7.5, font: bold, color: MUTED });
      page.drawText(sanitize(value), {
        x: valueX, y: ry - 1, size: 10.5,
        font: emphasize ? bold : font,
        color: emphasize ? NAVY : TEXT,
      });
      ry -= rowH;
    }
  }
  y -= panelH + 34;

  // Signature block
  text('Approved and signed by', { size: 8, font: bold, color: MUTED });
  y -= 8;
  {
    const maxW = Math.min(210, contentW * 0.5);
    const maxH = 58;
    const scale = Math.min(maxW / sigImage.width, maxH / sigImage.height, 1);
    const w = sigImage.width * scale;
    const h = sigImage.height * scale;
    y -= h + 4;
    page.drawImage(sigImage, { x: margin, y, width: w, height: h });
    y -= 8;
  }
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 230, y }, thickness: 0.8, color: TEXT });
  y -= 14;
  text(params.signerName, { size: 11, font: bold });
  y -= 13;
  text(`${params.signerTitle}${params.signerEmail ? `  ·  ${params.signerEmail}` : ''}`, { size: 9, color: MUTED });
  y -= 30;

  // Verification footer
  const year = new Date(params.signedAtIso).getFullYear() || new Date().getFullYear();
  page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.5, color: BORDER });
  y -= 14;
  text(
    'To verify: quote the Reference ID above to Simple Accounting, who can match it against the',
    { size: 8, color: MUTED },
  );
  y -= 11;
  text(
    'HRIS Documents record (same employee, requested date and signed date). This page was appended',
    { size: 8, color: MUTED },
  );
  y -= 11;
  text('at signing; the preceding pages are the document exactly as submitted.', { size: 8, color: MUTED });
  y -= 16;
  text(`Confidential document - Simple.biz (c) ${year}`, { size: 7.5, color: MUTED });

  return doc.save();
}

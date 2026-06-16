// Server-side renderer for the signed Intellectual Property Assignment PDF.
// Builds the document from scratch with pdf-lib (no template file to read at
// runtime, so it deploys cleanly on Vercel) using the SAME copy the hire saw on
// the form, then bakes in their name, drawn signature, the checked
// acknowledgement box, and the date they signed.

import { PDFDocument, StandardFonts, rgb, LineCapStyle, type PDFFont, type PDFImage } from "pdf-lib";
import {
  IP_ASSIGNMENT_TITLE,
  IP_ASSIGNMENT_INTRO,
  IP_ASSIGNMENT_SECTIONS,
  IP_ASSIGNMENT_ACKNOWLEDGEMENT,
  formatLongDate,
} from "./ip-assignment-text";

export type IpAssignmentPdfInput = {
  /** Name printed in the PARTICIPANT block. */
  name: string;
  /** Drawn signature as a data URL (PNG from the form's signature pad). */
  signatureDataUrl: string | null;
  /** ISO date (yyyy-mm-dd) the hire signed; rendered as "April 5, 1999". */
  dateIso: string | null;
};

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_SIZE = 10.5;
const BODY_LEAD = 15;
const HEAD_SIZE = 11;
const TITLE_SIZE = 15;
const TEXT_COLOR = rgb(0.1, 0.1, 0.12);
const MUTED_COLOR = rgb(0.35, 0.35, 0.4);
const LINE_COLOR = rgb(0.2, 0.2, 0.2);

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Names /
// values are usually Latin, but replace anything unencodable with '?' so a
// stray glyph can never crash document generation.
function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    out += (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? ch : "?";
  }
  return out;
}

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function dataUrlToImageBytes(
  dataUrl: string,
): { bytes: Uint8Array; kind: "png" | "jpg" } | null {
  const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const kind: "png" | "jpg" = /png/i.test(m[2]) ? "png" : "jpg";
  try {
    const bytes = Uint8Array.from(Buffer.from(m[3], "base64"));
    return { bytes, kind };
  } catch {
    return null;
  }
}

export async function generateIpAssignmentPdf(
  input: IpAssignmentPdfInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  // Draw a wrapped paragraph; paginates automatically.
  const paragraph = (
    text: string,
    opts: { font?: PDFFont; size?: number; lead?: number; gapAfter?: number } = {},
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? BODY_SIZE;
    const lead = opts.lead ?? BODY_LEAD;
    for (const ln of wrapLines(text, f, size, CONTENT_W)) {
      if (y - lead < MARGIN) newPage();
      y -= lead;
      page.drawText(ln, { x: MARGIN, y, size, font: f, color: TEXT_COLOR });
    }
    y -= opts.gapAfter ?? 8;
  };

  // ── Body ──────────────────────────────────────────────────────────────
  paragraph(IP_ASSIGNMENT_TITLE, { font: bold, size: TITLE_SIZE, lead: 20, gapAfter: 14 });
  for (const p of IP_ASSIGNMENT_INTRO) paragraph(p, { gapAfter: 10 });
  for (const section of IP_ASSIGNMENT_SECTIONS) {
    paragraph(section.heading, { font: bold, size: HEAD_SIZE, lead: 16, gapAfter: 4 });
    for (const p of section.paragraphs) paragraph(p);
  }

  // ── Acknowledgement (checked box + bold text) ───────────────────────────
  y -= 14;
  {
    const boxSize = 11;
    const gutter = 18;
    const ackLines = wrapLines(
      IP_ASSIGNMENT_ACKNOWLEDGEMENT,
      bold,
      BODY_SIZE,
      CONTENT_W - gutter,
    );
    if (y - BODY_LEAD < MARGIN) newPage();
    // Checkbox aligned to the first line.
    const boxTop = y - 2;
    const boxBottom = boxTop - boxSize;
    page.drawRectangle({
      x: MARGIN,
      y: boxBottom,
      width: boxSize,
      height: boxSize,
      borderColor: LINE_COLOR,
      borderWidth: 1,
    });
    // A check mark, drawn as two strokes (a checkmark glyph isn't in Helvetica's
    // WinAnsi encoding, so we vector-draw it inside the box).
    page.drawLine({
      start: { x: MARGIN + 2, y: boxBottom + 5 },
      end: { x: MARGIN + 4.3, y: boxBottom + 2.6 },
      thickness: 1.3,
      color: TEXT_COLOR,
      lineCap: LineCapStyle.Round,
    });
    page.drawLine({
      start: { x: MARGIN + 4.3, y: boxBottom + 2.6 },
      end: { x: MARGIN + 9, y: boxBottom + 8.5 },
      thickness: 1.3,
      color: TEXT_COLOR,
      lineCap: LineCapStyle.Round,
    });
    for (let i = 0; i < ackLines.length; i++) {
      if (i > 0) {
        if (y - BODY_LEAD < MARGIN) newPage();
        y -= BODY_LEAD;
      } else {
        y -= BODY_SIZE; // baseline of first line aligns next to the box
      }
      page.drawText(ackLines[i], {
        x: MARGIN + gutter,
        y,
        size: BODY_SIZE,
        font: bold,
        color: TEXT_COLOR,
      });
    }
    y -= 12;
  }

  // ── PARTICIPANT signature block ─────────────────────────────────────────
  y -= 18;
  if (y - 160 < MARGIN) newPage();
  paragraph("PARTICIPANT", { font: bold, size: HEAD_SIZE, lead: 16, gapAfter: 14 });

  const fieldW = 360;

  // Embed the signature image (if any) so we can render it on its own line.
  let sigImage: PDFImage | null = null;
  if (input.signatureDataUrl) {
    const parsed = dataUrlToImageBytes(input.signatureDataUrl);
    if (parsed) {
      try {
        sigImage = parsed.kind === "png"
          ? await doc.embedPng(parsed.bytes)
          : await doc.embedJpg(parsed.bytes);
      } catch {
        sigImage = null;
      }
    }
  }

  // A labelled signature/value line: value (text or image) sits on the rule,
  // the field label sits beneath it.
  const fieldLine = (label: string, value?: { text?: string; image?: PDFImage }) => {
    if (y - 70 < MARGIN) newPage();
    if (value?.image) {
      const maxW = fieldW;
      const maxH = 46;
      const scale = Math.min(maxW / value.image.width, maxH / value.image.height, 1);
      const w = value.image.width * scale;
      const h = value.image.height * scale;
      y -= h;
      page.drawImage(value.image, { x: MARGIN, y: y + 2, width: w, height: h });
    } else if (value?.text) {
      y -= 18;
      page.drawText(sanitize(value.text), {
        x: MARGIN,
        y,
        size: 12,
        font,
        color: TEXT_COLOR,
      });
    } else {
      y -= 26;
    }
    y -= 4;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + fieldW, y },
      thickness: 0.75,
      color: LINE_COLOR,
    });
    y -= 13;
    page.drawText(label, { x: MARGIN, y, size: 9, font, color: MUTED_COLOR });
    y -= 26;
  };

  fieldLine("Name", { text: input.name });
  fieldLine("Signature", sigImage ? { image: sigImage } : undefined);
  fieldLine("Date", { text: formatLongDate(input.dateIso) });

  return doc.save();
}

// HR Onboarding submission -> signed-contracts packet PDF (the View modal's
// "Download" tab).
//
// Compiles every agreement the hire signs on the onboarding form -- IP
// Assignment, Non-Solicitation, Privacy and Contract Worker Agreement -- into
// ONE branded document: the Simple logo heads every page, each agreement
// starts on a fresh page with the exact copy the hire saw (shared data
// modules, so this PDF can never drift from the form), the captured signature
// is baked onto its signature line, and every page's footer carries the date
// that agreement was signed plus the date the packet was generated.
//
// Runs entirely in the browser -- the View modal already holds the full row
// (signature data-URLs included), so there's no server round-trip. Visual
// language (navy + orange masthead palette, self-contained pdf-lib module)
// deliberately mirrors the other exports (onboarding-export.ts /
// catalog-export.ts) so the documents feel like one family.

import { PDFDocument, StandardFonts, rgb, LineCapStyle, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import {
  IP_ASSIGNMENT_TITLE,
  IP_ASSIGNMENT_INTRO,
  IP_ASSIGNMENT_SECTIONS,
  IP_ASSIGNMENT_ACKNOWLEDGEMENT,
  formatLongDate,
  todayLocalIso,
} from '@/lib/onboarding/ip-assignment-text';
import {
  AGREEMENT_TITLES,
  CONTRACT_WORKER_SECTIONS,
  NON_SOLICITATION_PARAGRAPHS,
  PRIVACY_PARAGRAPHS,
} from '@/lib/onboarding/agreement-copy';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The subset of an onboarding-submission row the packet reads. Kept loose
 * (plain `string | null` etc.) so the HR tab's local `SubmissionRow` type is
 * structurally assignable without importing it.
 */
export interface ContractsPacketInput {
  full_name: string | null;
  invite_name: string | null;
  submitted_at: string | null;
  ip_agreement_agreed: boolean | null;
  ip_agreement_name: string | null;
  ip_agreement_signature: string | null;
  ip_agreement_date: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  contract_signature: string | null;
  contract_date: string | null;
}

// ---------------------------------------------------------------------------
// Layout + palette
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_TOP = PAGE_H - 106; // below the logo masthead band
const CONTENT_BOTTOM = 64; // clear of the footer band
const BODY_SIZE = 10.5;
const BODY_LEAD = 15;
const HEAD_SIZE = 11;
const TITLE_SIZE = 15;
const TITLE_LEAD = 20;

// Brand-ish palette pulled from the Simple logo (navy + orange) — matches the
// onboarding / Payment Catalog exports so the documents look like one family.
const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const TEXT_COLOR = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.48);
const LINE_COLOR = rgb(0.2, 0.2, 0.2);
const BORDER = rgb(0.86, 0.86, 0.9);

// ---------------------------------------------------------------------------
// Small helpers (same conventions as the sibling pdf-lib exports)
// ---------------------------------------------------------------------------

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

/** Decode a signature-pad data URL into raw image bytes (browser-safe: atob,
 *  not Buffer, since this runs client-side). */
function dataUrlToImageBytes(dataUrl: string): { bytes: Uint8Array; kind: 'png' | 'jpg' } | null {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, kind: /png/i.test(m[1]) ? 'png' : 'jpg' };
  } catch {
    return null;
  }
}

/**
 * Local-time yyyy-mm-dd for a date-only OR timestamp ISO string. A date-only
 * value ("2026-07-21") is passed through untouched so a UTC-midnight parse can
 * never shift it a day backward; timestamps convert via the viewer's clock.
 */
function localDateIso(iso: string | null | undefined): string | null {
  const s = (iso ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : todayLocalIso(d);
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

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

type PacketDoc = {
  title: string;
  kind: 'ip' | 'paragraphs' | 'contract';
  /** Body copy when kind === 'paragraphs'. */
  paragraphs?: readonly string[];
  signed: boolean;
  /** Local yyyy-mm-dd the agreement was signed; null when unsigned. */
  signedIso: string | null;
  signatureDataUrl: string | null;
  signerName: string;
};

/** Build the signed-contracts packet. Returns the raw PDF bytes. */
export async function generateContractsPacketPdf(
  row: ContractsPacketInput,
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

  const generatedLabel = formatLongDate(todayLocalIso());
  const personName =
    (row.full_name ?? '').trim() || (row.invite_name ?? '').trim() || 'Onboarding participant';
  const submittedIso = localDateIso(row.submitted_at);

  const ipSigned = !!row.ip_agreement_signature || !!row.ip_agreement_agreed;
  const contractSigned = !!row.contract_signature;
  const docs: PacketDoc[] = [
    {
      title: IP_ASSIGNMENT_TITLE,
      kind: 'ip',
      signed: ipSigned,
      signedIso: ipSigned ? (localDateIso(row.ip_agreement_date) ?? submittedIso) : null,
      signatureDataUrl: row.ip_agreement_signature,
      signerName: (row.ip_agreement_name ?? '').trim() || personName,
    },
    {
      title: AGREEMENT_TITLES.nonSolicitation,
      kind: 'paragraphs',
      paragraphs: NON_SOLICITATION_PARAGRAPHS,
      signed: !!row.non_solicitation_signature,
      signedIso: row.non_solicitation_signature ? submittedIso : null,
      signatureDataUrl: row.non_solicitation_signature,
      signerName: personName,
    },
    {
      title: AGREEMENT_TITLES.privacy,
      kind: 'paragraphs',
      paragraphs: PRIVACY_PARAGRAPHS,
      signed: !!row.privacy_signature,
      signedIso: row.privacy_signature ? submittedIso : null,
      signatureDataUrl: row.privacy_signature,
      signerName: personName,
    },
    {
      title: AGREEMENT_TITLES.contract,
      kind: 'contract',
      signed: contractSigned,
      signedIso: contractSigned ? (localDateIso(row.contract_date) ?? submittedIso) : null,
      signatureDataUrl: row.contract_signature,
      signerName: personName,
    },
  ];

  // ── Page machinery ────────────────────────────────────────────────────────
  // Every page carries the logo masthead; the footer (signed/generated dates +
  // page numbers) is stamped in a second pass once the total count is known.
  // `currentFooter` holds the footer of the agreement being laid out, so its
  // continuation pages inherit the right dates.
  let page!: PDFPage;
  let y = 0;
  const footerLefts: string[] = [];
  let currentFooter = '';

  const drawMasthead = () => {
    const top = PAGE_H - 38;
    if (logo) {
      const h = 26;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      page.drawText('Simple', { x: MARGIN, y: top - 20, size: 20, font: bold, color: NAVY });
    }
    const right = (text: string, ty: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      page.drawText(s, { x: PAGE_W - MARGIN - w, y: ty, size, font: f, color });
    };
    right(personName, top - 10, 9.5, bold, NAVY);
    right('Onboarding Agreements', top - 23, 8.5, font);
    page.drawLine({
      start: { x: MARGIN, y: PAGE_H - 74 },
      end: { x: PAGE_W - MARGIN, y: PAGE_H - 74 },
      thickness: 1.1,
      color: NAVY,
    });
  };

  const addPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    footerLefts.push(currentFooter);
    drawMasthead();
    y = CONTENT_TOP;
  };
  const ensure = (space: number) => {
    if (y - space < CONTENT_BOTTOM) addPage();
  };

  // Draw a wrapped paragraph; paginates automatically.
  const paragraph = (
    text: string,
    o: { font?: PDFFont; size?: number; lead?: number; gapAfter?: number } = {},
  ) => {
    const f = o.font ?? font;
    const size = o.size ?? BODY_SIZE;
    const lead = o.lead ?? BODY_LEAD;
    for (const ln of wrapText(text, f, size, CONTENT_W)) {
      ensure(lead);
      y -= lead;
      page.drawText(ln, { x: MARGIN, y, size, font: f, color: TEXT_COLOR });
    }
    y -= o.gapAfter ?? 8;
  };

  // "- " bullet with a hanging indent (ASCII dash — a real bullet glyph isn't
  // WinAnsi-safe through sanitize()).
  const bulletItem = (text: string) => {
    const indent = 14;
    const lines = wrapText(text, font, BODY_SIZE, CONTENT_W - indent);
    lines.forEach((ln, i) => {
      ensure(BODY_LEAD);
      y -= BODY_LEAD;
      if (i === 0) {
        page.drawText('-', { x: MARGIN + 2, y, size: BODY_SIZE, font: bold, color: TEXT_COLOR });
      }
      page.drawText(ln, { x: MARGIN + indent, y, size: BODY_SIZE, font, color: TEXT_COLOR });
    });
    y -= 4;
  };

  // The IP acknowledgement row: checkbox (ticked when acknowledged) + bold text.
  const acknowledgement = (checked: boolean) => {
    y -= 6;
    const boxSize = 11;
    const gutter = 18;
    const ackLines = wrapText(IP_ASSIGNMENT_ACKNOWLEDGEMENT, bold, BODY_SIZE, CONTENT_W - gutter);
    ensure(BODY_LEAD + boxSize);
    const boxBottom = y - 2 - boxSize;
    page.drawRectangle({
      x: MARGIN,
      y: boxBottom,
      width: boxSize,
      height: boxSize,
      borderColor: LINE_COLOR,
      borderWidth: 1,
    });
    if (checked) {
      // Vector-drawn check mark (the glyph isn't in Helvetica's WinAnsi set).
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
    }
    for (let i = 0; i < ackLines.length; i++) {
      if (i > 0) {
        ensure(BODY_LEAD);
        y -= BODY_LEAD;
      } else {
        y -= BODY_SIZE; // baseline of the first line aligns next to the box
      }
      page.drawText(ackLines[i], { x: MARGIN + gutter, y, size: BODY_SIZE, font: bold, color: TEXT_COLOR });
    }
    y -= 12;
  };

  // PARTICIPANT block: Name / Signature / Date on labelled rules, with the
  // captured signature image (if any) sitting on its line.
  const signatureBlock = async (d: PacketDoc) => {
    ensure(190); // keep the whole block on one page where possible

    let sigImage: PDFImage | null = null;
    if (d.signatureDataUrl) {
      const parsed = dataUrlToImageBytes(d.signatureDataUrl);
      if (parsed) {
        try {
          sigImage = parsed.kind === 'png'
            ? await doc.embedPng(parsed.bytes)
            : await doc.embedJpg(parsed.bytes);
        } catch {
          sigImage = null;
        }
      }
    }

    y -= 10;
    paragraph('PARTICIPANT', { font: bold, size: HEAD_SIZE, lead: 16, gapAfter: 12 });

    const fieldW = 340;
    const fieldLine = (label: string, value?: { text?: string; image?: PDFImage }) => {
      ensure(70);
      if (value?.image) {
        const scale = Math.min(fieldW / value.image.width, 46 / value.image.height, 1);
        const w = value.image.width * scale;
        const h = value.image.height * scale;
        y -= h;
        page.drawImage(value.image, { x: MARGIN, y: y + 2, width: w, height: h });
      } else if (value?.text) {
        y -= 18;
        page.drawText(sanitize(value.text), { x: MARGIN, y, size: 12, font, color: TEXT_COLOR });
      } else {
        y -= 26; // blank line (unsigned)
      }
      y -= 4;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: MARGIN + fieldW, y },
        thickness: 0.75,
        color: LINE_COLOR,
      });
      y -= 13;
      page.drawText(label, { x: MARGIN, y, size: 9, font, color: MUTED });
      y -= 26;
    };

    fieldLine('Name', { text: d.signerName });
    fieldLine('Signature', sigImage ? { image: sigImage } : undefined);
    fieldLine('Date', d.signedIso ? { text: formatLongDate(d.signedIso) } : undefined);
  };

  // Fresh page + eyebrow + title for each agreement.
  const startDoc = (index: number, d: PacketDoc) => {
    currentFooter = `${d.signed ? (d.signedIso ? `Signed ${formatLongDate(d.signedIso)}` : 'Signed') : 'Not signed'} · Generated ${generatedLabel}`;
    addPage();
    page.drawRectangle({ x: MARGIN, y: y - 9, width: 4, height: 10, color: ORANGE });
    page.drawText(`AGREEMENT ${index + 1} OF ${docs.length}`, {
      x: MARGIN + 10,
      y: y - 8,
      size: 9,
      font: bold,
      color: NAVY,
    });
    y -= 30;
    for (const ln of wrapText(d.title, bold, TITLE_SIZE, CONTENT_W)) {
      y -= TITLE_LEAD;
      page.drawText(ln, { x: MARGIN, y, size: TITLE_SIZE, font: bold, color: NAVY });
    }
    y -= 12;
  };

  // ── Lay out the four agreements ───────────────────────────────────────────
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    startDoc(i, d);
    if (d.kind === 'ip') {
      for (const p of IP_ASSIGNMENT_INTRO) paragraph(p, { gapAfter: 10 });
      for (const section of IP_ASSIGNMENT_SECTIONS) {
        paragraph(section.heading, { font: bold, size: HEAD_SIZE, lead: 16, gapAfter: 4 });
        for (const p of section.paragraphs) paragraph(p);
      }
      acknowledgement(d.signed);
    } else if (d.kind === 'paragraphs') {
      for (const p of d.paragraphs ?? []) paragraph(p, { gapAfter: 10 });
    } else {
      for (const section of CONTRACT_WORKER_SECTIONS) {
        paragraph(section.heading, { font: bold, size: HEAD_SIZE, lead: 16, gapAfter: 4 });
        for (const p of section.paragraphs) paragraph(p);
        if (section.bullets) {
          for (const b of section.bullets) bulletItem(b);
          y -= 6;
        }
      }
    }
    await signatureBlock(d);
  }

  // ── Footers on every page (per-agreement signed date + generated date) ────
  const pages = doc.getPages();
  pages.forEach((p: PDFPage, i: number) => {
    p.drawLine({
      start: { x: MARGIN, y: 44 },
      end: { x: PAGE_W - MARGIN, y: 44 },
      thickness: 0.5,
      color: BORDER,
    });
    p.drawText(sanitize(footerLefts[i] ?? ''), { x: MARGIN, y: 31, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 31, size: 8, font, color: MUTED });
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

/** Build + download the packet, e.g. `signed-contracts-jan-kane-reroma-2026-07-28.pdf`. */
export async function downloadContractsPacketPdf(
  row: ContractsPacketInput,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generateContractsPacketPdf(row, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer (not a
  // possibly-shared view) -- keeps TS + every browser happy.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const slug =
    ((row.full_name ?? row.invite_name) ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'onboarding';
  downloadBlob(`signed-contracts-${slug}-${todayLocalIso()}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}

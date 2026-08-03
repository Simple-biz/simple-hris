// Employee Overview "Details" popup — a one-page PDF of the current pay
// week's ESTIMATE. Distinct from paystub-export.ts's generatePayStubsPdf,
// which renders the OFFICIAL, payroll-confirmed statement (landscape,
// multi-week, built from a full PayStubView). EmployeeDashboard's Pay
// snapshot numbers are locally-computed estimates with no PayStubView to
// hand it, so this is its own small module - portrait, single page, and
// explicit on the page that it's an estimate.
//
// Follows coe-document.ts's conventions (portrait Letter, embedPdfFonts for
// a real peso sign, embedSimpleLogo) rather than paystub-export.ts's older
// Helvetica + "PHP " sanitize fallback.

import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { embedPdfFonts } from '@/lib/pdf/fonts';
import { embedSimpleLogo, simpleLogoWidthForHeight } from '@/lib/pdf/logo';

type Color = ReturnType<typeof rgb>;

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 64;

const NAVY: Color = rgb(0.13, 0.15, 0.33);
const TEXT: Color = rgb(0.12, 0.12, 0.15);
const MUTED: Color = rgb(0.42, 0.42, 0.48);
const FAINT: Color = rgb(0.58, 0.58, 0.64);
const HAIRLINE: Color = rgb(0.9, 0.9, 0.93);
const BORDER: Color = rgb(0.86, 0.86, 0.9);
const EMERALD: Color = rgb(0.02, 0.36, 0.24);

export interface PaySnapshotPdfRow {
  label: string;
  /** Already formatted for display, e.g. "42.50h", "₱5,250.00", "—", "+₱2,000.00". */
  value: string;
}

export interface PaySnapshotTotal {
  label: string;
  value: string;
}

export interface PaySnapshotPdfInput {
  employeeName: string;
  department?: string | null;
  /** e.g. "Jul 28 - Aug 3, 2026" or "All time · combined". */
  weekLabel: string;
  /** One entry per visible grid tile, same order as on screen. */
  rows: PaySnapshotPdfRow[];
  totalLabel: string;
  totalValue: string;
  usdEquivalent?: string | null;
  /** The MESA-emergency-payout variant: an extra payout row + a grand total. */
  extraPayout?: PaySnapshotTotal | null;
  grandTotal?: PaySnapshotTotal | null;
}

/** "August 3, 2026, 4:12 PM GMT+8" (viewer's local time), matching paystub-export.ts. */
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

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** kebab filename stem from a person's name. */
function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'employee';
}

/** Build the one-page Pay Summary PDF. There is exactly one `addPage` call
 *  below and no pagination loop, so this is always exactly one page. */
export async function generatePaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt: Date,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Pay Summary — ${input.employeeName}`);
  doc.setAuthor('Simple');
  doc.setSubject('Pay Summary (estimate)');
  doc.setCreator('Simple HRIS');
  doc.setProducer('Simple HRIS');

  const { regular, bold, sanitize } = await embedPdfFonts(doc);
  const logo = await embedSimpleLogo(doc);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (
    raw: string,
    x: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; color?: Color } = {},
  ) => {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? regular;
    page.drawText(sanitize(raw), { x, y: baseline, size, font, color: opts.color ?? TEXT });
  };

  const right = (
    raw: string,
    rightEdge: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; color?: Color } = {},
  ) => {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? regular;
    const s = sanitize(raw);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: rightEdge - w, y: baseline, size, font, color: opts.color ?? TEXT });
  };

  // ── Masthead ─────────────────────────────────────────────────────────────
  if (logo) {
    const h = 26;
    const w = simpleLogoWidthForHeight(h);
    page.drawImage(logo, { x: MARGIN, y: y - h, width: w, height: h });
  } else {
    text('Simple', MARGIN, y - 20, { size: 20, font: bold, color: NAVY });
  }
  right('Pulled from Simple HRIS', PAGE_W - MARGIN, y - 8, { size: 9, font: bold, color: NAVY });
  right(`Generated ${formatTimestamp(generatedAt)}`, PAGE_W - MARGIN, y - 20, { size: 8, color: MUTED });
  y -= 42;

  text('PAY SUMMARY', MARGIN, y, { size: 17, font: bold, color: NAVY });
  y -= 17;
  const who = input.department ? `${input.employeeName} · ${input.department}` : input.employeeName;
  text(who, MARGIN, y, { size: 10.5, color: MUTED });
  y -= 14;
  text(input.weekLabel, MARGIN, y, { size: 10.5, font: bold, color: TEXT });
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.3, color: NAVY });
  y -= 22;

  // ── Rows ─────────────────────────────────────────────────────────────────
  const ROW_H = 22;
  for (const row of input.rows) {
    text(row.label, MARGIN, y, { size: 10, color: MUTED });
    right(row.value, PAGE_W - MARGIN, y, { size: 10.5, font: bold, color: TEXT });
    y -= 9;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: HAIRLINE });
    y -= ROW_H - 9;
  }

  // ── Total ────────────────────────────────────────────────────────────────
  y -= 4;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.3, color: NAVY });
  y -= 20;
  text(input.totalLabel, MARGIN, y, { size: 12, font: bold, color: NAVY });
  right(input.totalValue, PAGE_W - MARGIN, y, { size: 14, font: bold, color: EMERALD });
  if (input.usdEquivalent) {
    y -= 15;
    right(input.usdEquivalent, PAGE_W - MARGIN, y, { size: 9, color: MUTED });
  }

  if (input.extraPayout) {
    y -= 22;
    text(input.extraPayout.label, MARGIN, y, { size: 10, color: MUTED });
    right(input.extraPayout.value, PAGE_W - MARGIN, y, { size: 10.5, font: bold, color: TEXT });
  }
  if (input.grandTotal) {
    y -= 20;
    page.drawLine({ start: { x: MARGIN, y: y + 8 }, end: { x: PAGE_W - MARGIN, y: y + 8 }, thickness: 0.7, color: BORDER });
    text(input.grandTotal.label, MARGIN, y, { size: 12, font: bold, color: NAVY });
    right(input.grandTotal.value, PAGE_W - MARGIN, y, { size: 14, font: bold, color: EMERALD });
  }

  // ── Disclaimer ───────────────────────────────────────────────────────────
  y -= 34;
  text('Estimated figures — not an official pay stub.', MARGIN, y, { size: 9, color: FAINT });
  y -= 12;
  text('Your confirmed pay statement is available under Open Paystubs once processed.', MARGIN, y, { size: 9, color: FAINT });

  // ── Footer ───────────────────────────────────────────────────────────────
  page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: BORDER });
  text('Confidential pay estimate · Simple HRIS', MARGIN, 28, { size: 8, color: MUTED });
  right('Page 1 of 1', PAGE_W - MARGIN, 28, { size: 8, color: MUTED });

  return doc.save();
}

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

/** Build + download the Pay Summary PDF in the browser. */
export async function downloadPaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt: Date = new Date(),
): Promise<void> {
  const bytes = await generatePaySnapshotPdf(input, generatedAt);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(
    `pay-summary-${slug(input.employeeName)}-${dateSuffix(generatedAt)}.pdf`,
    new Blob([ab], { type: 'application/pdf' }),
  );
}
